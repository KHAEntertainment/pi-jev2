/**
 * Escalate to the managing agent inside Traycer.
 *
 * Traycer exposes no public A2A endpoint; its agent-to-agent channel is the
 * `traycer` CLI that it installs and configures for every agent it launches
 * (TRAYCER_EPIC_ID and TRAYCER_AGENT_ID in the environment):
 *
 *   traycer agent send --to <parent> --message <text> --expect-reply --json
 *     -> NDJSON: progress lines, then one {"type":"result",…} carrying a responseId
 *   traycer agent inbox [--after <cursor>] --json
 *     -> NDJSON result with the messages addressed to this agent
 *
 * The reply to an --expect-reply message comes back to this agent's inbox
 * carrying the same responseId, so the escalator sends once and polls the
 * inbox for that id. The managing agent sees the message as
 * `[traycer:agent-message]` text and answers with its `traycer_send_message`
 * tool, so the message is written for an LLM reader and asks for JSON back.
 *
 * UNVERIFIED (needs a local Traycer session; see docs/SESSION-NOTES.md):
 *   - the exact field names in the `send` and `inbox` result lines; the
 *     parsers here search the result object for them rather than assume a path
 *   - how the parent id is exposed by `traycer agent list --json`
 */

import {
	EscalationError,
	pollUntil,
	type EscalationDecision,
	type EscalationRequest,
	type EscalationWait,
	type Escalator,
	parseDecision,
} from "../escalation";

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
}

export type Exec = (
	command: string,
	args: string[],
	options?: { signal?: AbortSignal; timeout?: number },
) => Promise<ExecResult>;

export interface TraycerOptions {
	command: string;
	parentAgentId: string | undefined;
	pollMs: number;
	env: Record<string, string | undefined>;
	now?: () => number;
}

const CLI_TIMEOUT_MS = 30_000;

export function traycerEscalator(exec: Exec, options: TraycerOptions): Escalator {
	const now = options.now ?? Date.now;
	const self = options.env.TRAYCER_AGENT_ID;

	async function run(args: string[], signal?: AbortSignal): Promise<unknown[]> {
		const result = await exec(options.command, [...args, "--json"], {
			signal,
			timeout: CLI_TIMEOUT_MS,
		});
		if (result.code !== 0) {
			const detail = (result.stderr || result.stdout).trim().slice(0, 300);
			throw new EscalationError(`traycer ${args.slice(0, 2).join(" ")} exited ${result.code}${detail ? `: ${detail}` : ""}`);
		}
		return parseNdjson(result.stdout);
	}

	async function parentId(signal?: AbortSignal): Promise<string> {
		const configured = options.parentAgentId ?? options.env.TRAYCER_PARENT_AGENT_ID;
		if (configured) return configured;
		if (!self) throw new EscalationError("TRAYCER_AGENT_ID is not set");
		const lines = await run(["agent", "list"], signal);
		const parent = findParentId(lines, self);
		if (!parent) {
			throw new EscalationError(
				"could not find this agent's parent in `traycer agent list`; set escalation.traycer.parentAgentId",
			);
		}
		return parent;
	}

	return {
		name: "traycer",
		async request(req: EscalationRequest, wait: EscalationWait) {
			if (!self || !options.env.TRAYCER_EPIC_ID) {
				throw new EscalationError("not running under Traycer (TRAYCER_EPIC_ID/TRAYCER_AGENT_ID unset)");
			}
			const to = await parentId(wait.signal);
			// Read the cursor first so a stale reply in the inbox cannot answer us.
			let cursor = inboxCursor(await run(["agent", "inbox"], wait.signal));
			const sent = await run(
				["agent", "send", "--to", to, "--message", traycerMessage(req, self), "--expect-reply"],
				wait.signal,
			);
			const responseId = findString(resultOf(sent), ["responseId", "response_id"]);
			if (!responseId) throw new EscalationError("traycer send returned no responseId");

			return pollUntil(
				async () => {
					const args = ["agent", "inbox"];
					if (cursor) args.push("--after", cursor);
					const lines = await run(args, wait.signal);
					cursor = inboxCursor(lines) ?? cursor;
					for (const message of inboxMessages(lines)) {
						if (findString(message, ["responseId", "response_id"]) !== responseId) continue;
						const decision = parseDecision(messageText(message));
						if (!decision) continue;
						if (decision.decision === "escalate") {
							wait.onEscalated?.(decision);
							continue;
						}
						return {
							...decision,
							decision: decision.decision,
							by: decision.by ?? findString(message, ["senderAgentId", "sender", "from"]) ?? to,
						} as EscalationDecision & { decision: "approve" | "deny" };
					}
					return undefined;
				},
				{ intervalMs: options.pollMs, wait, now },
			);
		},
	};
}

/** Written for an LLM manager: what is asked, and the exact reply shape. */
export function traycerMessage(req: EscalationRequest, self: string): string {
	const what = req.verdict
		? `the pi-jev safety gate flagged a \`${req.tool}\` call (${req.verdict.summary}).`
		: `it asks for a decision before \`${req.tool}\`: ${req.question ?? "(no question given)"}`;
	return [
		`[pi-jev escalation] Agent ${self} is paused: ${what}`,
		"It will not continue until you reply to this message.",
		'Reply with JSON: {"decision":"approve"|"deny"|"escalate","reason":"<one line>"}.',
		'Use "escalate" if a human should decide; then send the final approve/deny when they have.',
		"",
		"Request:",
		JSON.stringify(req, null, 2),
	].join("\n");
}

export function parseNdjson(text: string): unknown[] {
	const out: unknown[] = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
		try {
			out.push(JSON.parse(trimmed));
		} catch {
			// a progress line that is not JSON
		}
	}
	return out;
}

/** The `result` line, or the last object when the CLI prints no type field. */
function resultOf(lines: unknown[]): unknown {
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index];
		if (typeof line === "object" && line !== null && Reflect.get(line, "type") === "result") return line;
	}
	return lines.at(-1);
}

function inboxMessages(lines: unknown[]): object[] {
	const out: object[] = [];
	const visit = (value: unknown, depth: number): void => {
		if (depth > 5 || typeof value !== "object" || value === null) return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item, depth + 1);
			return;
		}
		if (findString(value, ["responseId", "response_id"], 0) && messageText(value)) {
			out.push(value);
			return;
		}
		for (const item of Object.values(value)) visit(item, depth + 1);
	};
	visit(resultOf(lines), 0);
	return out;
}

function inboxCursor(lines: unknown[]): string | undefined {
	return findString(resultOf(lines), ["nextCursor", "next_cursor", "cursor"], 2);
}

function messageText(message: object): string {
	for (const key of ["prompt", "message", "text", "content", "body"]) {
		const value = Reflect.get(message, key);
		if (typeof value === "string") return value;
	}
	return "";
}

/** First string under any of `keys`, searching nested objects to `depth`. */
export function findString(value: unknown, keys: string[], depth = 3): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	for (const key of keys) {
		const found = Reflect.get(value, key);
		if (typeof found === "string" && found) return found;
	}
	if (depth <= 0) return undefined;
	for (const item of Object.values(value)) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
		const found = findString(item, keys, depth - 1);
		if (found) return found;
	}
	return undefined;
}

function findParentId(lines: unknown[], self: string): string | undefined {
	let parent: string | undefined;
	const visit = (value: unknown, depth: number): void => {
		if (parent || depth > 5 || typeof value !== "object" || value === null) return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item, depth + 1);
			return;
		}
		const id = Reflect.get(value, "id") ?? Reflect.get(value, "agentId");
		if (id === self) {
			parent = findString(value, ["parentAgentId", "parentId", "parent_agent_id", "parent"], 0);
			return;
		}
		for (const item of Object.values(value)) visit(item, depth + 1);
	};
	for (const line of lines) visit(line, 0);
	return parent;
}
