/**
 * Config for the Jev extensions.
 *
 * Which classifier answers, and how flagged calls escalate, live here. The
 * provider's endpoint and credentials do not: pi's model runtime resolves both
 * from the model spec (env, auth.json, `/login`), so this file only carries an
 * optional key override.
 *
 * Layering: built-in defaults <- ~/.pi/agent/pi-jev.json <- <cwd>/.pi/pi-jev.json.
 * Project settings win. Only keys actually present in a file override, so a
 * project file can set one field without restating the rest.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as host from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MODEL,
	DEFAULT_RETRIES,
	DEFAULT_TIMEOUT_MS,
	parseModelSpec,
} from "./classifier";

export const CONFIG_FILE = "pi-jev.json";

/**
 * The host's per-project config dir name, read off a plain-data view of its
 * exports. Hosts before 0.79.7 do not export it, and a named import there
 * binds `undefined` and kills the agent at startup (upstream issue #1). Such
 * a host also has no classifier runtime, so the extension must load far
 * enough to say "needs pi 0.99" and stay inactive; `.pi` is the default name.
 */
function configDirName(): string {
	const exports: Record<string, unknown> = { ...host };
	const name = exports.CONFIG_DIR_NAME;
	return typeof name === "string" && name.length > 0 ? name : ".pi";
}

/**
 * shadow reports but never blocks; enforce asks the local user; escalate asks
 * the orchestrator (Pi parent, Traycer, A2A) and falls back to enforce when it
 * cannot answer.
 */
export type GateMode = "shadow" | "enforce" | "escalate";
export const GATE_MODES: readonly GateMode[] = ["shadow", "enforce", "escalate"];

export type EscalationTransport = "auto" | "pi-rpc" | "traycer" | "a2a" | "none";
const TRANSPORTS: readonly EscalationTransport[] = [
	"auto",
	"pi-rpc",
	"traycer",
	"a2a",
	"none",
];

export interface GateThresholds {
	/** Bool probability at or above which the dimension counts as triggered. */
	destructive: number;
	exfiltration: number;
	beyondScope: number;
	/** Score on the 4-level damage rubric. */
	impact: number;
}

export interface GateConfig {
	enabled: boolean;
	mode: GateMode;
	/** Tool names to judge. Everything else runs unjudged. */
	tools: string[];
	/** Elide string fields longer than this from the state sent to Jev. */
	argumentChars: number;
	/** Reuse a verdict for identical tool input within this window. */
	cacheSeconds: number;
	blockOn: GateThresholds;
	/** Minimum confidence on the impact answer before a block is allowed. */
	minConfidence: number;
	/**
	 * Block in non-interactive runs. Off by default: with no UI there is no way
	 * to approve a flagged call, so enforcement would deadlock automation on a
	 * classifier's opinion.
	 */
	blockWithoutUI: boolean;
}

/**
 * The output judge runs after a tool finishes, so its questions are about text
 * that exists: a credential echoed into the transcript, a failure to classify.
 * It never blocks, so there is no mode and no confirmation.
 */
export interface OutputConfig {
	enabled: boolean;
	/** Tool names whose output is judged. Everything else passes through. */
	tools: string[];
	/** Elide output longer than this from the state sent to Jev. */
	outputChars: number;
	/** Bool probability at or above which output counts as carrying a secret. */
	leakThreshold: number;
	/** Minimum confidence on the failure class before advice is attached. */
	minConfidence: number;
}

export interface TraycerConfig {
	/** CLI to run. Traycer installs it as `traycer`. */
	command: string;
	/** Agent to escalate to. Falls back to TRAYCER_PARENT_AGENT_ID, then lookup. */
	parentAgentId: string | undefined;
}

export interface A2AConfig {
	/** JSON-RPC endpoint, or a base URL whose agent card names one. */
	url: string | undefined;
	/** Env var holding a bearer token for the orchestrator. */
	tokenEnv: string | undefined;
	/** File holding a bearer token, with `~/` expanded. */
	tokenFile: string | undefined;
}

/**
 * Where a flagged call goes in `escalate` mode. Every failure - no transport,
 * unreachable orchestrator, timeout - falls back to `enforce` behaviour, so an
 * orchestrator outage never blocks more than the local rule would.
 */
export interface EscalationConfig {
	transport: EscalationTransport;
	/** How long to wait for a first decision. */
	timeoutSeconds: number;
	/** How long to keep waiting once the orchestrator hands it to a human. */
	humanTimeoutSeconds: number;
	/** Poll interval for transports without push (Traycer inbox, A2A GetTask). */
	pollMs: number;
	traycer: TraycerConfig;
	a2a: A2AConfig;
}

export interface JevConfig {
	/** `provider/id` of the classifier, e.g. `openrouter/typesafe/jev-1.13`. */
	model: string;
	/** Optional key override; pi resolves the provider's credentials otherwise. */
	apiKey: string | undefined;
	apiKeyFile: string | undefined;
	timeoutMs: number;
	retries: number;
	gate: GateConfig;
	output: OutputConfig;
	escalation: EscalationConfig;
}

export interface LoadedJevConfig {
	config: JevConfig;
	warnings: string[];
}

/** A config file with only the keys it actually declared. */
interface ParsedGate extends Partial<Omit<GateConfig, "blockOn">> {
	blockOn?: Partial<GateThresholds>;
}

type ParsedOutput = Partial<OutputConfig>;

interface ParsedEscalation
	extends Partial<Omit<EscalationConfig, "traycer" | "a2a">> {
	traycer?: Partial<TraycerConfig>;
	a2a?: Partial<A2AConfig>;
}

interface ParsedConfigFile
	extends Partial<Omit<JevConfig, "gate" | "output" | "escalation">> {
	gate?: ParsedGate;
	output?: ParsedOutput;
	escalation?: ParsedEscalation;
}

export function defaultJevConfig(): JevConfig {
	return {
		model: DEFAULT_MODEL,
		apiKey: undefined,
		apiKeyFile: undefined,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		retries: DEFAULT_RETRIES,
		gate: {
			enabled: true,
			mode: "shadow",
			tools: ["bash", "write", "edit"],
			argumentChars: 400,
			cacheSeconds: 120,
			blockOn: { destructive: 0.9, exfiltration: 0.7, beyondScope: 0.85, impact: 2.5 },
			minConfidence: 0.5,
			blockWithoutUI: false,
		},
		output: {
			enabled: true,
			tools: ["bash", "codemode"],
			outputChars: 2000,
			leakThreshold: 0.9,
			minConfidence: 0.6,
		},
		escalation: {
			transport: "auto",
			timeoutSeconds: 300,
			humanTimeoutSeconds: 1800,
			pollMs: 2000,
			traycer: { command: "traycer", parentAgentId: undefined },
			a2a: { url: undefined, tokenEnv: undefined, tokenFile: undefined },
		},
	};
}

export function loadJevConfig(cwd: string): LoadedJevConfig {
	const defaults = defaultJevConfig();
	const warnings: string[] = [];
	const global = readConfigFile(join(host.getAgentDir(), CONFIG_FILE), warnings);
	const project = readConfigFile(join(cwd, configDirName(), CONFIG_FILE), warnings);
	restrictProjectEscalation(project, warnings);

	const config: JevConfig = {
		...defaults,
		...global,
		...project,
		gate: {
			...defaults.gate,
			...global.gate,
			...project.gate,
			blockOn: {
				...defaults.gate.blockOn,
				...global.gate?.blockOn,
				...project.gate?.blockOn,
			},
			tools: project.gate?.tools ?? global.gate?.tools ?? defaults.gate.tools,
		},
		output: {
			...defaults.output,
			...global.output,
			...project.output,
			tools:
				project.output?.tools ?? global.output?.tools ?? defaults.output.tools,
		},
		escalation: {
			...defaults.escalation,
			...global.escalation,
			...project.escalation,
			traycer: {
				...defaults.escalation.traycer,
				...global.escalation?.traycer,
				...project.escalation?.traycer,
			},
			a2a: {
				...defaults.escalation.a2a,
				...global.escalation?.a2a,
				...project.escalation?.a2a,
			},
		},
	};
	// A bare id keeps meaning TypeSafe; store the qualified form so status
	// lines and journal records name the provider.
	const spec = parseModelSpec(config.model);
	config.model = `${spec.provider}/${spec.id}`;

	const key = resolveApiKey(config, warnings);
	return { config: { ...config, apiKey: key }, warnings };
}

/**
 * An explicit override only. Without one, pi resolves the provider's own
 * credentials (its env var, auth.json, `/login`), so nothing here reads env.
 * apiKeyFile supports "~/" because keys usually live outside the repo.
 */
export function resolveApiKey(
	config: Pick<JevConfig, "apiKey" | "apiKeyFile">,
	warnings: string[] = [],
): string | undefined {
	if (config.apiKey?.trim()) return config.apiKey.trim();
	if (!config.apiKeyFile) return undefined;
	return readSecretFile(config.apiKeyFile, warnings);
}

/** A one-line secret from a file, or undefined with a warning on failure. */
export function readSecretFile(
	file: string,
	warnings: string[] = [],
): string | undefined {
	const path = expandHome(file);
	try {
		const contents = readFileSync(path, "utf8").trim();
		return contents.length > 0 ? contents : undefined;
	} catch (error) {
		warnings.push(
			`${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return undefined;
	}
}

export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function readConfigFile(path: string, warnings: string[]): ParsedConfigFile {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		// Missing file is the normal case; anything else is worth reporting.
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
			warnings.push(
				`${path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return {};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		warnings.push(
			`${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
		);
		return {};
	}
	if (typeof parsed !== "object" || parsed === null) {
		warnings.push(`${path}: expected a JSON object`);
		return {};
	}

	const out: ParsedConfigFile = {};

	const model = asString(Reflect.get(parsed, "model"));
	if (model) out.model = model;
	const apiKey = asString(Reflect.get(parsed, "apiKey"));
	if (apiKey) out.apiKey = apiKey;
	const apiKeyFile = asString(Reflect.get(parsed, "apiKeyFile"));
	if (apiKeyFile) out.apiKeyFile = apiKeyFile;
	const timeoutMs = asPositiveInt(Reflect.get(parsed, "timeoutMs"));
	if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;
	const retries = asNonNegativeInt(Reflect.get(parsed, "retries"));
	if (retries !== undefined) out.retries = retries;

	const gate = Reflect.get(parsed, "gate");
	if (typeof gate === "object" && gate !== null) {
		const parsedGate: ParsedGate = {};
		const enabled = Reflect.get(gate, "enabled");
		if (typeof enabled === "boolean") parsedGate.enabled = enabled;
		const mode = Reflect.get(gate, "mode");
		if (GATE_MODES.includes(mode as GateMode)) parsedGate.mode = mode as GateMode;
		const tools = asToolNames(Reflect.get(gate, "tools"));
		if (tools) parsedGate.tools = tools;
		const cacheSeconds = asNonNegativeInt(Reflect.get(gate, "cacheSeconds"));
		if (cacheSeconds !== undefined) parsedGate.cacheSeconds = cacheSeconds;
		const argumentChars = asPositiveInt(Reflect.get(gate, "argumentChars"));
		if (argumentChars !== undefined) parsedGate.argumentChars = argumentChars;
		const blockWithoutUI = Reflect.get(gate, "blockWithoutUI");
		if (typeof blockWithoutUI === "boolean") {
			parsedGate.blockWithoutUI = blockWithoutUI;
		}
		const minConfidence = asRatio(Reflect.get(gate, "minConfidence"));
		if (minConfidence !== undefined) parsedGate.minConfidence = minConfidence;

		const blockOn = Reflect.get(gate, "blockOn");
		if (typeof blockOn === "object" && blockOn !== null) {
			const thresholds: Partial<GateThresholds> = {};
			const destructive = asRatio(Reflect.get(blockOn, "destructive"));
			if (destructive !== undefined) thresholds.destructive = destructive;
			const exfiltration = asRatio(Reflect.get(blockOn, "exfiltration"));
			if (exfiltration !== undefined) thresholds.exfiltration = exfiltration;
			const beyondScope = asRatio(Reflect.get(blockOn, "beyondScope"));
			if (beyondScope !== undefined) thresholds.beyondScope = beyondScope;
			const impact = Reflect.get(blockOn, "impact");
			if (typeof impact === "number" && Number.isFinite(impact) && impact >= 0) {
				thresholds.impact = impact;
			}
			parsedGate.blockOn = thresholds;
		}
		out.gate = parsedGate;
	}

	const output = Reflect.get(parsed, "output");
	if (typeof output === "object" && output !== null) {
		const parsedOutput: ParsedOutput = {};
		const enabled = Reflect.get(output, "enabled");
		if (typeof enabled === "boolean") parsedOutput.enabled = enabled;
		const tools = asToolNames(Reflect.get(output, "tools"));
		if (tools) parsedOutput.tools = tools;
		const outputChars = asPositiveInt(Reflect.get(output, "outputChars"));
		if (outputChars !== undefined) parsedOutput.outputChars = outputChars;
		const leakThreshold = asRatio(Reflect.get(output, "leakThreshold"));
		if (leakThreshold !== undefined) parsedOutput.leakThreshold = leakThreshold;
		const minConfidence = asRatio(Reflect.get(output, "minConfidence"));
		if (minConfidence !== undefined) parsedOutput.minConfidence = minConfidence;
		out.output = parsedOutput;
	}

	const escalation = Reflect.get(parsed, "escalation");
	if (typeof escalation === "object" && escalation !== null) {
		out.escalation = parseEscalation(escalation);
	}

	for (const key of ignoredKeys(parsed, out)) {
		warnings.push(`${path}: ignored ${key} (${IGNORED_HINTS[key] ?? "unknown key or unusable value"})`);
	}
	return out;
}

/**
 * A repository's own `.pi/pi-jev.json` must not choose where escalations go or
 * what runs: an A2A URL plus `tokenEnv`/`tokenFile` would send a local secret
 * as a bearer token to a server that can then approve flagged calls, and the
 * Traycer command is executed. Those come from the user's global file only.
 */
function restrictProjectEscalation(project: ParsedConfigFile, warnings: string[]): void {
	const escalation = project.escalation;
	if (!escalation) return;
	if (escalation.a2a) {
		delete escalation.a2a;
		warnings.push(
			"project pi-jev.json: escalation.a2a is ignored; set it in the global ~/.pi/agent/pi-jev.json",
		);
	}
	if (escalation.traycer?.command) {
		delete escalation.traycer.command;
		warnings.push(
			"project pi-jev.json: escalation.traycer.command is ignored; set it in the global ~/.pi/agent/pi-jev.json",
		);
	}
}

/** Keys 0.3 understood, with what replaced them. */
const IGNORED_HINTS: Record<string, string> = {
	endpoint:
		"the endpoint now follows the model's provider; set model to provider/id, e.g. openrouter/typesafe/jev-1.13",
};

function parseEscalation(raw: object): ParsedEscalation {
	const out: ParsedEscalation = {};
	const transport = Reflect.get(raw, "transport");
	if (TRANSPORTS.includes(transport as EscalationTransport)) {
		out.transport = transport as EscalationTransport;
	}
	const timeoutSeconds = asPositiveInt(Reflect.get(raw, "timeoutSeconds"));
	if (timeoutSeconds !== undefined) out.timeoutSeconds = timeoutSeconds;
	const humanTimeoutSeconds = asPositiveInt(Reflect.get(raw, "humanTimeoutSeconds"));
	if (humanTimeoutSeconds !== undefined) {
		out.humanTimeoutSeconds = humanTimeoutSeconds;
	}
	const pollMs = asPositiveInt(Reflect.get(raw, "pollMs"));
	if (pollMs !== undefined) out.pollMs = pollMs;

	const traycer = Reflect.get(raw, "traycer");
	if (typeof traycer === "object" && traycer !== null) {
		const parsed: Partial<TraycerConfig> = {};
		const command = asString(Reflect.get(traycer, "command"));
		if (command) parsed.command = command;
		const parentAgentId = asString(Reflect.get(traycer, "parentAgentId"));
		if (parentAgentId) parsed.parentAgentId = parentAgentId;
		out.traycer = parsed;
	}

	const a2a = Reflect.get(raw, "a2a");
	if (typeof a2a === "object" && a2a !== null) {
		const parsed: Partial<A2AConfig> = {};
		const url = asString(Reflect.get(a2a, "url"));
		if (url && /^https?:\/\//.test(url)) parsed.url = url;
		const tokenEnv = asString(Reflect.get(a2a, "tokenEnv"));
		if (tokenEnv) parsed.tokenEnv = tokenEnv;
		const tokenFile = asString(Reflect.get(a2a, "tokenFile"));
		if (tokenFile) parsed.tokenFile = tokenFile;
		out.a2a = parsed;
	}
	return out;
}

function ignoredKeys(raw: object, kept: object, prefix = ""): string[] {
	const ignored: string[] = [];
	for (const [key, value] of Object.entries(raw)) {
		const parsed: unknown = Reflect.get(kept, key);
		if (parsed === undefined) {
			ignored.push(`${prefix}${key}`);
		} else if (isPlainObject(value) && isPlainObject(parsed)) {
			ignored.push(...ignoredKeys(value, parsed, `${prefix}${key}.`));
		}
	}
	return ignored;
}

function isPlainObject(value: unknown): value is object {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asToolNames(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const names = value.filter(
		(item): item is string => typeof item === "string" && item.length > 0,
	);
	return names.length > 0 ? names : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function asPositiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: undefined;
}

function asNonNegativeInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
		? value
		: undefined;
}

function asRatio(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
		? value
		: undefined;
}
