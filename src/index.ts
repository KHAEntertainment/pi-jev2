import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	authHint,
	classify,
	describeAnswer,
	hasClassifierRuntime,
	isCalibratedModel,
	JevError,
	parseModelSpec,
	redact,
	rememberSecret,
	resolveModel,
	type ClassifierRegistry,
	type JevQuestion,
	type JevResponse,
	type JevState,
} from "./classifier";
import {
	GATE_MODES,
	loadJevConfig,
	readSecretFile,
	type GateMode,
	type JevConfig,
	type LoadedJevConfig,
} from "./config";
import {
	describeOutcome,
	ESCALATION_SCHEMA,
	escalate,
	newRequestId,
	resolveTransport,
	type EscalationOutcome,
	type EscalationRequest,
	type Escalator,
} from "./escalation";
import { a2aEscalator } from "./escalators/a2a";
import { piRpcEscalator } from "./escalators/pi-rpc";
import { traycerEscalator } from "./escalators/traycer";
import {
	buildGateState,
	describeAnswers,
	evaluateGate,
	GATE_QUESTIONS,
	judgmentKey,
	summarizeArguments,
	summarizeVerdict,
	type GateVerdict,
} from "./gate";
import {
	buildOutputState,
	evaluateOutput,
	OUTPUT_QUESTIONS,
	outputKey,
	type OutputVerdict,
} from "./output";
import {
	capped,
	describeRecord,
	escalationRecord,
	gateRecord,
	JOURNAL_CAP,
	JOURNAL_TAIL,
	newest as newestRecord,
	outputRecord,
	recordsFromEntries,
	recordClock,
	writeRecord,
	type JournalRecord,
} from "./journal";

/**
 * pi-jev - a System One classifier (TypeSafe Jev by default) as a decision
 * layer for pi. The classifier is whatever `model` names, served by whichever
 * provider pi routes it to: TypeSafe, OpenRouter, Cloudflare Workers AI,
 * Vercel AI Gateway, OpenCode, or a custom provider.
 *
 * Four jobs, all decided by typed questions rather than by prompt text:
 *
 *   1. Gate. Before a mutating tool runs, ask Jev whether the action is
 *      destructive, exfiltrating, or outside scope, plus how reversible it is.
 *      Shadow mode (default) reports. Enforce mode asks the user to confirm.
 *      Escalate mode asks the orchestrator managing this agent (Pi parent over
 *      RPC, Traycer, A2A) and waits for its decision.
 *   2. Output judge. After a tool runs, ask whether its output carries a
 *      secret and what kind of failure it reports. Never blocks; it appends a
 *      line to the tool result the model reads.
 *   3. jev_ask. A model-facing tool for decisions that should be typed and
 *      calibrated instead of written: classification, relevance, yes/no checks.
 *
 * Fails open. An API outage must never stop the agent from working, so every
 * error path returns "no verdict" instead of a block.
 */

const STATUS_KEY = "jev";
const ESCALATE_TOOL = "jev_escalate";
const ERROR_NOTIFY_INTERVAL_MS = 60_000;
/** Identical output is judged once per window, keyed by tool and output hash. */
const OUTPUT_CACHE_SECONDS = 120;

const QuestionParam = Type.Object({
	id: Type.String({
		description: "Short key for this question. The answer comes back under it.",
	}),
	type: StringEnum(["bool", "noul", "choice", "score"] as const, {
		description:
			"bool (or noul) = yes/no probability, choice = pick one option, score = value on a rubric",
	}),
	instructions: Type.String({
		description:
			"The one thing to judge. One specific, well-scoped gut-check per question.",
	}),
	options: Type.Optional(
		Type.Array(
			Type.Object({
				name: Type.String({ description: "Option key" }),
				description: Type.Optional(
					Type.String({ description: "When this option applies" }),
				),
			}),
			{ description: "choice only: the options to choose between" },
		),
	),
	levels: Type.Optional(
		Type.Array(Type.String(), {
			description: "score only: ordered rubric levels, lowest first, at least two",
		}),
	),
});

const EscalateParams = Type.Object({
	question: Type.String({
		description:
			"The decision you need from your orchestrator, in one or two sentences.",
	}),
	action: Type.Optional(
		Type.String({
			description:
				"The action you intend to take if approved, e.g. the command or file.",
		}),
	),
});

const AskParams = Type.Object({
	state: Type.String({
		description:
			"The text to judge: tool output, a diff, a message, a document excerpt.",
	}),
	questions: Type.Array(QuestionParam, {
		description:
			"One or more questions. All are evaluated in parallel against the same state.",
	}),
});

export default function jevExtension(pi: ExtensionAPI): void {
	let loaded: LoadedJevConfig = loadJevConfig(process.cwd());
	let config: JevConfig = loaded.config;
	rememberSecret(config.apiKey);

	let gateOn = config.gate.enabled;
	let outputOn = config.output.enabled;
	let mode: GateMode = config.gate.mode;
	/**
	 * Why the judges are inactive, or undefined when they can run: no
	 * classifier runtime on this host, a model the catalog does not know, or a
	 * provider with no credentials. Set at session_start.
	 */
	let inactive: string | undefined = "not started";

	const cache = new Map<string, { at: number; verdict: GateVerdict }>();
	const inflight = new Map<string, Promise<GateVerdict | undefined>>();
	const outputCache = new Map<string, { at: number; verdict: OutputVerdict }>();
	const outputInflight = new Map<string, Promise<OutputVerdict | undefined>>();
	/** One orchestrator question per identical pending call, shared by siblings. */
	const escalations = new Map<string, Promise<EscalationOutcome | undefined>>();
	/**
	 * `/jev last` and `/jev output` read these; they are journal records rather
	 * than live verdicts so a rehydrated session renders the same text as a live
	 * one. `journal` holds the records written this session (or reloaded from it).
	 */
	let last: JournalRecord | undefined;
	let lastOutput: JournalRecord | undefined;
	let journal: JournalRecord[] = [];
	let lastErrorAt = 0;
	const warnedOnce = new Set<string>();

	function reload(cwd: string): void {
		loaded = loadJevConfig(cwd);
		config = loaded.config;
		rememberSecret(config.apiKey);
		gateOn = config.gate.enabled;
		outputOn = config.output.enabled;
		mode = config.gate.mode;
	}

	/** Persist a record and keep it in memory. Writing must never break a call. */
	function remember(record: JournalRecord): void {
		journal = capped([...journal, record]);
		writeRecord(pi, record);
	}

	/** Session entries are hand-editable, so a bad read yields an empty journal. */
	function readJournal(ctx: ExtensionContext): JournalRecord[] {
		try {
			return recordsFromEntries(ctx.sessionManager.getEntries());
		} catch {
			return [];
		}
	}

	function warnOnce(ctx: ExtensionContext, key: string, message: string): void {
		if (warnedOnce.has(key)) return;
		warnedOnce.add(key);
		ctx.ui.notify(message, "warning");
	}

	function registryOf(ctx: ExtensionContext): ClassifierRegistry | undefined {
		const registry: unknown = ctx.modelRegistry;
		return hasClassifierRuntime(registry) ? registry : undefined;
	}

	/** Why the judges cannot run with this host and config, or undefined. */
	function checkReady(ctx: ExtensionContext): string | undefined {
		const registry = registryOf(ctx);
		if (!registry) {
			return "this host has no classifier runtime (pi 0.99 or later is required)";
		}
		if (!resolveModel(registry, config.model)) {
			return `classifier ${config.model} is not in the model catalog (check the provider/id spelling, or add it in models.json)`;
		}
		if (config.apiKey) return undefined;
		const { provider } = parseModelSpec(config.model);
		const status = registry.getProviderAuthStatus?.(provider);
		if (status && !status.configured) {
			return `no credentials for ${provider}: ${authHint(provider)}`;
		}
		return undefined;
	}

	function statusText(): string {
		return `jev: ${gateOn ? mode : "off"}${outputOn ? "" : " (out off)"}`;
	}

	/** One classifier request with this session's model, timeout, and key override. */
	async function ask(
		ctx: ExtensionContext,
		state: JevState,
		questions: Record<string, JevQuestion>,
		signal: AbortSignal | undefined,
	): Promise<JevResponse> {
		const registry = registryOf(ctx);
		if (!registry) throw new JevError("no classifier runtime on this host");
		return classify(registry, {
			state,
			questions,
			model: config.model,
			timeoutMs: config.timeoutMs,
			retries: config.retries,
			apiKey: config.apiKey,
			signal,
		});
	}

	/** The escalator for this process, or undefined when none applies. */
	function escalatorFor(ctx: ExtensionContext): Escalator | undefined {
		const transport = resolveTransport(config.escalation, {
			mode: ctx.mode,
			env: process.env,
		});
		switch (transport) {
			case "traycer":
				return traycerEscalator(
					(command, args, options) => pi.exec(command, args, options),
					{
						command: config.escalation.traycer.command,
						parentAgentId: config.escalation.traycer.parentAgentId,
						pollMs: config.escalation.pollMs,
						env: process.env,
					},
				);
			case "a2a": {
				const url = config.escalation.a2a.url;
				if (!url) return undefined;
				const { tokenEnv, tokenFile } = config.escalation.a2a;
				const token =
					(tokenEnv ? process.env[tokenEnv]?.trim() : undefined) ||
					(tokenFile ? readSecretFile(tokenFile) : undefined);
				rememberSecret(token);
				return a2aEscalator({ url, token, pollMs: config.escalation.pollMs });
			}
			case "pi-rpc":
				return ctx.hasUI ? piRpcEscalator(ctx.ui) : undefined;
			default:
				return undefined;
		}
	}

	/** jev_escalate is declared to the model only when an orchestrator exists. */
	function syncEscalateTool(ctx: ExtensionContext): void {
		try {
			const active = pi.getActiveTools();
			const want = escalatorFor(ctx) !== undefined;
			const has = active.includes(ESCALATE_TOOL);
			if (want && !has) pi.setActiveTools([...active, ESCALATE_TOOL]);
			if (!want && has) pi.setActiveTools(active.filter((name) => name !== ESCALATE_TOOL));
		} catch {
			// Tool activation is a convenience; never let it break session start.
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		reload(ctx.cwd);
		// A reload, resume, or fork rebuilds this closure from nothing, so the
		// session's own entries are the only record of what already fired.
		journal = readJournal(ctx);
		last = newestRecord(journal, "gate");
		lastOutput = newestRecord(journal, "output");
		for (const warning of loaded.warnings) {
			ctx.ui.notify(`pi-jev: ${redact(warning)}`, "warning");
		}
		inactive = checkReady(ctx);
		syncEscalateTool(ctx);
		if (inactive) {
			warnOnce(ctx, inactive, `pi-jev: ${inactive}; the judges are inactive until then.`);
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		if (mode !== "shadow" && !isCalibratedModel(config.model)) {
			warnOnce(
				ctx,
				`uncalibrated:${config.model}`,
				`pi-jev: ${config.model} is not a Jev model; the thresholds were measured on Jev, so it may flag too much or too little. Run \`npm run calibrate -- --model ${config.model}\` before relying on ${mode}.`,
			);
		}
		if (mode === "escalate" && !escalatorFor(ctx)) {
			warnOnce(
				ctx,
				"no-transport",
				"pi-jev: escalate mode has no orchestrator here (no Traycer env, no escalation.a2a.url, not in RPC mode); flagged calls use the enforce rule.",
			);
		}
		ctx.ui.setStatus(STATUS_KEY, statusText());
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!gateOn || inactive) return;
		if (!config.gate.tools.includes(event.toolName)) return;

		const key = judgmentKey(event.toolName, event.input);
		const verdict = await verdictFor(key, event, ctx);
		if (!verdict) return;

		last = gateRecord(event.toolName, verdict, Date.now());
		ctx.ui.setStatus(
			STATUS_KEY,
			verdict.flagged
				? `jev: ${summarizeVerdict(verdict)}`
				: `jev: clear (${mode})`,
		);
		if (!verdict.flagged) return;
		// A clear call is not journaled: the flag is the record worth keeping.
		remember(last);

		const reason = `pi-jev: ${summarizeVerdict(verdict)}`;
		if (mode === "shadow") {
			ctx.ui.notify(
				`jev shadow: ${event.toolName} - ${summarizeVerdict(verdict)}`,
				"warning",
			);
			return;
		}
		if (mode === "escalate") {
			const outcome = await escalationFor(key, event, verdict, ctx);
			if (outcome) {
				if (outcome.decision === "approve") {
					ctx.ui.notify(
						`jev: ${event.toolName} ${describeOutcome(outcome)}`,
						"info",
					);
					return;
				}
				return { block: true, reason: `${reason} (${describeOutcome(outcome)})` };
			}
			// No answer from the orchestrator: the enforce rule below decides.
		}
		return localDecision(event.toolName, verdict, reason, ctx);
	});

	/** The enforce rule: ask the local user, or apply blockWithoutUI headless. */
	async function localDecision(
		toolName: string,
		verdict: GateVerdict,
		reason: string,
		ctx: ExtensionContext,
	): Promise<{ block: true; reason: string } | undefined> {
		if (!ctx.hasUI) {
			if (config.gate.blockWithoutUI) return { block: true, reason };
			// No UI means no way to approve a flagged call. Degrade to shadow
			// rather than deadlocking a headless run on a classifier's opinion.
			ctx.ui.notify(
				`jev: ${toolName} - ${summarizeVerdict(verdict)} (headless: not blocking; set gate.blockWithoutUI to block)`,
				"warning",
			);
			return undefined;
		}
		const allow = await ctx.ui.confirm(
			"Jev flagged this tool call",
			`${toolName}\n${summarizeVerdict(verdict)}\n\nRun it anyway?`,
		);
		return allow ? undefined : { block: true, reason: `${reason} (declined)` };
	}

	/**
	 * Ask the orchestrator about a flagged call. Identical sibling calls share
	 * one request; a decision is not cached past it, because an approval is
	 * for this call, not for every later call that looks the same.
	 */
	async function escalationFor(
		key: string,
		event: { toolName: string; input: unknown },
		verdict: GateVerdict,
		ctx: ExtensionContext,
	): Promise<EscalationOutcome | undefined> {
		const pending = escalations.get(key);
		if (pending) return pending;
		const promise = runEscalation(
			gateRequest(event, verdict, ctx),
			event.toolName,
			ctx,
			ctx.signal,
		).finally(() => escalations.delete(key));
		escalations.set(key, promise);
		return promise;
	}

	/** Escalate and journal the outcome; undefined means fall back locally. */
	async function runEscalation(
		request: EscalationRequest,
		toolName: string,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
	): Promise<EscalationOutcome | undefined> {
		const escalator = escalatorFor(ctx);
		if (!escalator) return undefined;
		const started = Date.now();
		ctx.ui.setStatus(STATUS_KEY, `jev: waiting on ${escalator.name}`);
		try {
			const outcome = await escalate(escalator, request, config.escalation, {
				signal,
				onEscalated: () => {
					ctx.ui.setStatus(STATUS_KEY, `jev: ${escalator.name} escalated to a human`);
					ctx.ui.notify(
						`jev: ${toolName} escalated to a human by the orchestrator; waiting`,
						"info",
					);
				},
			});
			remember(escalationRecord(toolName, outcome, Date.now()));
			ctx.ui.setStatus(STATUS_KEY, statusText());
			return outcome;
		} catch (error) {
			const message = redact(error instanceof Error ? error.message : String(error));
			remember(
				escalationRecord(
					toolName,
					{ fallback: message, transport: escalator.name, latencyMs: Date.now() - started },
					Date.now(),
				),
			);
			ctx.ui.setStatus(STATUS_KEY, statusText());
			notifyError(ctx, new Error(`escalation over ${escalator.name}: ${message}; using the local rule`));
			return undefined;
		}
	}

	function gateRequest(
		event: { toolName: string; input: unknown },
		verdict: GateVerdict,
		ctx: ExtensionContext,
	): EscalationRequest {
		return {
			schema: ESCALATION_SCHEMA,
			id: newRequestId(),
			source: "gate",
			tool: event.toolName,
			arguments: summarizeArguments(event.input, config.gate.argumentChars),
			verdict: {
				summary: summarizeVerdict(verdict),
				reasons: verdict.reasons,
				scores: {
					destructive: verdict.destructive,
					exfiltration: verdict.exfiltration,
					beyond_scope: verdict.beyondScope,
					impact: verdict.impact,
				},
				model: verdict.model,
			},
			userRequest: truncateUser(lastUserRequest(ctx)),
			cwd: ctx.cwd,
			at: Date.now(),
		};
	}

	pi.on("tool_result", async (event, ctx) => {
		if (!outputOn || inactive) return;
		if (!config.output.tools.includes(event.toolName)) return;
		if (event.parentToolCallId) return;
		const text = contentText(event.content);
		if (!text.trim()) return;

		const verdict = await outputVerdictFor(
			outputKey(event.toolName, text),
			{
				toolName: event.toolName,
				input: event.input,
				output: text,
				isError: event.isError,
			},
			ctx,
		);
		if (!verdict?.notice) return;

		lastOutput = outputRecord(event.toolName, verdict, Date.now());
		remember(lastOutput);
		ctx.ui.setStatus(STATUS_KEY, `jev: ${verdict.kind} (${event.toolName})`);
		if (verdict.kind === "leak") {
			ctx.ui.notify(
				`jev: ${event.toolName} output may carry a secret (${verdict.leaksSecret.toFixed(2)})`,
				"warning",
			);
		}
		// The model reads the tool result, so the notice rides with it.
		return {
			content: [
				...event.content,
				{ type: "text" as const, text: `[pi-jev] ${verdict.notice}` },
			],
			structuredContent: event.structuredContent,
		};
	});

	async function outputVerdictFor(
		key: string,
		event: { toolName: string; input: unknown; output: string; isError: boolean },
		ctx: ExtensionContext,
	): Promise<OutputVerdict | undefined> {
		const cached = outputCache.get(key);
		if (
			cached &&
			(Date.now() - cached.at) / 1000 <= OUTPUT_CACHE_SECONDS
		) {
			return cached.verdict;
		}
		const pending = outputInflight.get(key);
		if (pending) return pending;

		const promise = judgeOutput(event, ctx).finally(() =>
			outputInflight.delete(key),
		);
		outputInflight.set(key, promise);
		const verdict = await promise;
		if (verdict) {
			outputCache.set(key, { at: Date.now(), verdict });
			if (outputCache.size > 64) outputCache.clear();
		}
		return verdict;
	}

	async function judgeOutput(
		event: { toolName: string; input: unknown; output: string; isError: boolean },
		ctx: ExtensionContext,
	): Promise<OutputVerdict | undefined> {
		try {
			const response = await ask(
				ctx,
				buildOutputState({
					cwd: ctx.cwd,
					toolName: event.toolName,
					input: event.input,
					output: event.output,
					isError: event.isError,
					argumentChars: config.gate.argumentChars,
					outputChars: config.output.outputChars,
				}),
				OUTPUT_QUESTIONS,
				ctx.signal,
			);
			return evaluateOutput(response, config);
		} catch (error) {
			notifyError(ctx, error);
			return undefined;
		}
	}

	async function verdictFor(
		key: string,
		event: { toolName: string; input: unknown },
		ctx: ExtensionContext,
	): Promise<GateVerdict | undefined> {
		const cached = cache.get(key);
		if (
			cached &&
			(Date.now() - cached.at) / 1000 <= config.gate.cacheSeconds
		) {
			return cached.verdict;
		}
		const pending = inflight.get(key);
		if (pending) return pending;

		const promise = judge(event, ctx).finally(() => inflight.delete(key));
		inflight.set(key, promise);
		const verdict = await promise;
		if (verdict) {
			cache.set(key, { at: Date.now(), verdict });
			prune();
		}
		return verdict;
	}

	async function judge(
		event: { toolName: string; input: unknown },
		ctx: ExtensionContext,
	): Promise<GateVerdict | undefined> {
		try {
			const response = await ask(
				ctx,
				buildGateState({
					cwd: ctx.cwd,
					toolName: event.toolName,
					input: event.input,
					userRequest: lastUserRequest(ctx),
					argumentChars: config.gate.argumentChars,
				}),
				GATE_QUESTIONS,
				ctx.signal,
			);
			return evaluateGate(response, config);
		} catch (error) {
			notifyError(ctx, error);
			return undefined;
		}
	}

	function notifyError(ctx: ExtensionContext, error: unknown): void {
		const at = Date.now();
		if (at - lastErrorAt < ERROR_NOTIFY_INTERVAL_MS) return;
		lastErrorAt = at;
		ctx.ui.notify(
			`pi-jev: ${redact(error instanceof Error ? error.message : String(error))} (failing open)`,
			"error",
		);
	}

	function prune(): void {
		if (cache.size <= 64) return;
		const cutoff = Date.now() - config.gate.cacheSeconds * 1000;
		for (const [key, entry] of cache) {
			if (entry.at < cutoff) cache.delete(key);
		}
		while (cache.size > 64) {
			const oldest = cache.keys().next().value;
			if (oldest === undefined) break;
			cache.delete(oldest);
		}
	}

	pi.registerCommand("jev", {
		description:
			"pi-jev: status, mode shadow|enforce|escalate, on/off, last verdict, last judged output, journal log, check",
		handler: async (args, ctx) => {
			const [sub, value] = args.trim().toLowerCase().split(/\s+/);
			if (sub === "on" || sub === "off") {
				const on = sub === "on";
				gateOn = on;
				outputOn = on;
				ctx.ui.setStatus(STATUS_KEY, on ? `jev: ${mode}` : "jev: off");
				ctx.ui.notify(`pi-jev: gate ${sub}`, "info");
				return;
			}
			if (sub === "mode") {
				if (!GATE_MODES.includes(value as GateMode)) {
					ctx.ui.notify(
						`pi-jev: mode is ${mode} (usage: /jev mode ${GATE_MODES.join("|")})`,
						"warning",
					);
					return;
				}
				mode = value as GateMode;
				ctx.ui.setStatus(STATUS_KEY, statusText());
				const detail =
					mode === "shadow"
						? "reports, never blocks"
						: mode === "enforce"
							? "asks before running flagged calls"
							: `asks the orchestrator (${escalatorFor(ctx)?.name ?? "none found: enforce rule"})`;
				ctx.ui.notify(`pi-jev: ${mode} (${detail})`, "info");
				return;
			}
			if (sub === "last") {
				if (last?.kind !== "gate") {
					ctx.ui.notify("pi-jev: no verdicts yet", "info");
					return;
				}
				ctx.ui.notify(`pi-jev: ${describeRecord(last)}`, "info");
				return;
			}
			if (sub === "output") {
				if (lastOutput?.kind !== "output") {
					ctx.ui.notify("pi-jev: no tool output judged yet", "info");
					return;
				}
				ctx.ui.notify(`pi-jev output: ${describeRecord(lastOutput)}`, "info");
				return;
			}
			if (sub === "log") {
				if (journal.length === 0) {
					ctx.ui.notify(
						"pi-jev: journal is empty (nothing flagged yet)",
						"info",
					);
					return;
				}
				const shown = journal.slice(-JOURNAL_TAIL);
				const lines = shown.map(
					(record) =>
						`${recordClock(record)} ${record.kind} ${describeRecord(record)}`,
				);
				ctx.ui.notify(
					`pi-jev log: ${shown.length} of ${journal.length} kept (cap ${JOURNAL_CAP})\n${lines.join("\n")}`,
					"info",
				);
				return;
			}
			if (sub === "check") {
				const text = args.trim().slice("check".length).trim();
				if (!text) {
					ctx.ui.notify("pi-jev: usage /jev check <text>", "warning");
					return;
				}
				const why = checkReady(ctx);
				if (why) {
					ctx.ui.notify(`pi-jev: ${why}`, "warning");
					return;
				}
				try {
					const response = await ask(ctx, { text }, GATE_QUESTIONS, ctx.signal);
					const verdict = evaluateGate(response, config);
					// A manual probe, not a field observation, so it is shown but
					// not journaled: the journal is the record of what actually fired.
					last = gateRecord("check", verdict, Date.now());
					ctx.ui.notify(
						`pi-jev check: ${summarizeVerdict(verdict)} | ${describeAnswers(response)}`,
						"info",
					);
				} catch (error) {
					ctx.ui.notify(
						`pi-jev: ${redact(error instanceof Error ? error.message : String(error))}`,
						"error",
					);
				}
				return;
			}

			const { provider } = parseModelSpec(config.model);
			const auth = config.apiKey
				? config.apiKeyFile
					? `apiKeyFile ${config.apiKeyFile}`
					: "apiKey (inline)"
				: describeAuth(registryOf(ctx), provider);
			const transport = resolveTransport(config.escalation, {
				mode: ctx.mode,
				env: process.env,
			});
			ctx.ui.notify(
				`pi-jev: ${inactive ? `inactive (${inactive})` : gateOn ? "on" : "off"}, out ${outputOn ? "on" : "off"}, mode ${mode}, model ${config.model}${isCalibratedModel(config.model) ? "" : " (uncalibrated)"}, auth ${auth}, escalation ${transport}, judging ${config.gate.tools.join("/")}, out tools ${config.output.tools.join("/")}, cache ${cache.size}/${outputCache.size}, journal ${journal.length}`,
				"info",
			);
		},
	});

	pi.registerTool({
		name: ESCALATE_TOOL,
		label: "Escalate",
		description:
			"Ask the orchestrator managing this agent (a Pi parent, Traycer, or an A2A orchestrator) to decide something before you act. Blocks until it approves or denies; it may hand the question to a human first.",
		promptSnippet:
			"Ask your orchestrator to approve or deny an action before you take it",
		promptGuidelines: [
			"Use jev_escalate when an action needs a decision from whoever is managing you (scope changes, irreversible operations, conflicting instructions), not for questions you can answer yourself.",
			"If jev_escalate returns a denial, do not take the action; adjust the plan or ask the user.",
		],
		parameters: EscalateParams,
		defaultActive: false,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const escalator = escalatorFor(ctx);
			if (!escalator) {
				return {
					content: [
						{ type: "text" as const, text: "jev_escalate: no orchestrator is reachable from this session; ask the user instead." },
					],
					details: { ok: false },
				};
			}
			const request: EscalationRequest = {
				schema: ESCALATION_SCHEMA,
				id: newRequestId(),
				source: "agent",
				tool: ESCALATE_TOOL,
				arguments: summarizeArguments({ action: params.action }, config.gate.argumentChars),
				question: params.question,
				userRequest: truncateUser(lastUserRequest(ctx)),
				cwd: ctx.cwd,
				at: Date.now(),
			};
			const outcome = await runEscalation(request, ESCALATE_TOOL, ctx, signal);
			const text = outcome
				? `${describeOutcome(outcome)}.`
				: "no decision: the orchestrator did not answer in time. Ask the user before taking the action.";
			return {
				content: [{ type: "text" as const, text: `jev_escalate: ${text}` }],
				details: { ok: outcome !== undefined, outcome },
			};
		},
	});

	pi.registerTool({
		name: "jev_ask",
		label: "Jev Ask",
		description:
			"Ask a System One classifier (TypeSafe Jev by default) typed questions about a piece of text and get calibrated answers (probabilities, a chosen option, a rubric score) instead of prose.",
		promptSnippet:
			"Ask Jev typed questions (yes/no, choice, rubric) about text and get calibrated answers",
		promptGuidelines: [
			"Use jev_ask when a judgement must be typed and calibrated rather than written: classification, relevance, yes/no checks, rubric scores.",
			"Ask one specific question per entry in jev_ask; split multi-factor judgements into separate questions and combine the answers yourself.",
		],
		parameters: AskParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const why = checkReady(ctx);
			if (why) {
				return {
					content: [{ type: "text" as const, text: `jev_ask: ${why}` }],
					details: { ok: false },
				};
			}
			const questions: Record<string, JevQuestion> = {};
			for (const question of params.questions) {
				const built = toQuestion(question);
				if (typeof built === "string") {
					return {
						content: [
							{ type: "text" as const, text: `jev_ask: ${built}` },
						],
						details: { ok: false },
					};
				}
				questions[question.id] = built;
			}

			try {
				const response = await ask(ctx, { text: params.state }, questions, signal);
				return {
					content: [
						{
							type: "text" as const,
							text: renderAnswers(response, questions),
						},
					],
					details: {
						ok: true,
						model: response.model,
						usage: response.usage,
						answers: response.answers,
					},
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: `jev_ask: ${redact(error instanceof Error ? error.message : String(error))}`,
						},
					],
					details: { ok: false },
				};
			}
		},
	});
}

function describeAuth(registry: ClassifierRegistry | undefined, provider: string): string {
	const status = registry?.getProviderAuthStatus?.(provider);
	if (!status) return "unknown";
	if (!status.configured) return `missing (${authHint(provider)})`;
	return status.label ?? status.source ?? "configured";
}

function truncateUser(text: string | undefined): string | undefined {
	return text && text.length > 1200 ? `${text.slice(0, 1200)}…[truncated]` : text;
}

/** Text of a tool result, so the output judge sees what the model will see. */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const text = Reflect.get(block, "text");
		if (typeof text === "string") parts.push(text);
	}
	return parts.join("\n");
}

interface QuestionParamValue {
	id: string;
	type: "bool" | "noul" | "choice" | "score";
	instructions: string;
	options?: { name: string; description?: string }[];
	levels?: string[];
}

/** Returns a Jev question, or a message explaining why the shape is invalid. */
function toQuestion(question: QuestionParamValue): JevQuestion | string {
	const { id, instructions } = question;
	if (question.type === "choice") {
		if (!question.options || question.options.length === 0) {
			return `question "${id}": choice needs at least one option`;
		}
		const criteria: Record<string, string> = {};
		for (const option of question.options) {
			criteria[option.name] = option.description ?? option.name;
		}
		return { type: "choice", instructions, criteria };
	}
	if (question.type === "score") {
		if (!question.levels || question.levels.length < 2) {
			return `question "${id}": score needs at least two levels`;
		}
		return { type: "score", instructions, criteria: question.levels };
	}
	return { type: "bool", instructions, criteria: { true: "Yes", false: "No" } };
}

function renderAnswers(
	response: JevResponse,
	questions: Record<string, JevQuestion>,
): string {
	const lines = [`model ${response.model}`];
	for (const [id, answer] of Object.entries(response.answers)) {
		const question = questions[id];
		const tail = question ? `  <- ${question.instructions}` : "";
		lines.push(
			`${id}: ${answer.type === "choice" ? formatChoice(answer) : describeAnswer(answer, question)}${tail}`,
		);
	}
	if (response.usage) {
		lines.push(
			`tokens ${response.usage.input ?? 0} in / ${response.usage.output ?? 0} out`,
		);
	}
	return lines.join("\n");
}

function formatChoice(answer: {
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}): string {
	const ranked = Object.entries(answer.probabilities)
		.sort(([, a], [, b]) => b - a)
		.map(([option, probability]) => `${option} ${probability.toFixed(2)}`)
		.join(", ");
	return `${answer.choice} (conf ${answer.confidence.toFixed(2)}) [${ranked}]`;
}

/** Latest user text in the branch, so scope questions can weigh intent. */
function lastUserRequest(ctx: ExtensionContext): string | undefined {
	const entries = ctx.sessionManager.buildContextEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user") continue;
		const text = messageText(message.content);
		if (text) return text;
	}
	return undefined;
}

function messageText(content: unknown): string | undefined {
	if (typeof content === "string") return content.trim() || undefined;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const type = Reflect.get(block, "type");
		const text = Reflect.get(block, "text");
		if (type === "text" && typeof text === "string") parts.push(text);
	}
	const joined = parts.join("\n").trim();
	return joined || undefined;
}
