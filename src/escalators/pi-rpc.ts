/**
 * Escalate to a Pi parent that drives this agent with `pi --mode rpc`.
 *
 * In RPC mode every `ctx.ui` dialog becomes an `extension_ui_request` line on
 * stdout and blocks until the parent writes the matching
 * `extension_ui_response` to stdin (pi docs/rpc-extension-ui.md). Of the four
 * dialogs only `input` carries both a payload field and a timeout, so the
 * request travels as `input`:
 *
 *   child -> {"type":"extension_ui_request","id":"…","method":"input",
 *             "title":"pi-jev escalation",
 *             "placeholder":"{\"schema\":\"pi-jev.escalation/v1\",…}",
 *             "timeout":300000}
 *   parent -> {"type":"extension_ui_response","id":"…",
 *              "value":"{\"decision\":\"deny\",\"reason\":\"…\",\"by\":\"parent\"}"}
 *
 * `value` may also be a bare word (approve / deny / escalate). A cancel, a
 * timeout, or an unparseable value is "no answer" and falls back locally.
 * `escalate` means the parent passed it to its own human or orchestrator: the
 * deadline extends and the child asks again.
 *
 * `relayChildEscalation` is the parent half, for an extension that spawns
 * children over RPC.
 */

import {
	ESCALATION_SCHEMA,
	EscalationError,
	parseDecision,
	type EscalationDecision,
	type EscalationRequest,
	type EscalationWait,
	type Escalator,
} from "../escalation";

export const RPC_ESCALATION_TITLE = "pi-jev escalation";

export interface InputDialog {
	input(
		title: string,
		placeholder?: string,
		opts?: { signal?: AbortSignal; timeout?: number },
	): Promise<string | undefined>;
}

export function piRpcEscalator(
	ui: InputDialog,
	now: () => number = Date.now,
): Escalator {
	return {
		name: "pi-rpc",
		async request(req: EscalationRequest, wait: EscalationWait) {
			let title = RPC_ESCALATION_TITLE;
			for (;;) {
				const remaining = wait.deadline - now();
				if (remaining <= 0) throw new EscalationError("escalation timed out");
				if (wait.signal?.aborted) throw new EscalationError("escalation aborted");
				const value = await ui.input(title, JSON.stringify(req), {
					signal: wait.signal,
					timeout: remaining,
				});
				if (value === undefined) {
					throw new EscalationError("parent did not answer (cancelled or timed out)");
				}
				const decision = parseDecision(value);
				if (!decision) {
					throw new EscalationError(`parent answered something that is not a decision: ${value.slice(0, 120)}`);
				}
				if (decision.decision === "approve" || decision.decision === "deny") {
					return { ...decision, decision: decision.decision, by: decision.by ?? "pi parent" };
				}
				wait.onEscalated?.(decision);
				title = `${RPC_ESCALATION_TITLE} (awaiting human)`;
			}
		},
	};
}

/** An `extension_ui_request` line as the parent reads it from a child's stdout. */
export interface ChildUiRequest {
	type: "extension_ui_request";
	id: string;
	method: string;
	title?: string;
	placeholder?: string;
	timeout?: number;
}

/** The slice of a parent ExtensionContext the relay needs. */
export interface RelayContext {
	hasUI: boolean;
	ui: {
		confirm(
			title: string,
			message: string,
			opts?: { signal?: AbortSignal; timeout?: number },
		): Promise<boolean>;
	};
	signal?: AbortSignal;
}

/** Whether a child's UI request is a pi-jev escalation, and its payload. */
export function readChildEscalation(
	line: ChildUiRequest,
): EscalationRequest | undefined {
	if (line.type !== "extension_ui_request" || line.method !== "input") return undefined;
	if (!line.title?.startsWith(RPC_ESCALATION_TITLE) || !line.placeholder) return undefined;
	try {
		const payload: unknown = JSON.parse(line.placeholder);
		if (
			typeof payload === "object" &&
			payload !== null &&
			Reflect.get(payload, "schema") === ESCALATION_SCHEMA
		) {
			return payload as EscalationRequest;
		}
	} catch {
		// not ours
	}
	return undefined;
}

/**
 * Parent half: turn a child's escalation into a decision and the response
 * line to write back to the child's stdin. With a UI the parent's user
 * decides; without one, `fallback` (another escalator, e.g. this parent's own
 * orchestrator) decides, and with neither the answer is a cancel - which the
 * child treats as "no answer" and handles with its own local rule.
 */
export async function relayChildEscalation(
	line: ChildUiRequest,
	ctx: RelayContext,
	fallback?: (req: EscalationRequest) => Promise<EscalationDecision | undefined>,
): Promise<{ decision: EscalationDecision | undefined; response: Record<string, unknown> } | undefined> {
	const req = readChildEscalation(line);
	if (!req) return undefined;
	let decision: EscalationDecision | undefined;
	if (ctx.hasUI) {
		const summary = req.verdict?.summary ?? req.question ?? "flagged";
		const approved = await ctx.ui.confirm(
			"A sub-agent's tool call needs approval",
			`${req.tool}\n${summary}\n\n${JSON.stringify(req.arguments, null, 2).slice(0, 2000)}\n\nRun it?`,
			{ signal: ctx.signal, timeout: line.timeout },
		);
		decision = { decision: approved ? "approve" : "deny", by: "parent user" };
	} else if (fallback) {
		decision = await fallback(req);
	}
	const response: Record<string, unknown> = decision
		? { type: "extension_ui_response", id: line.id, value: JSON.stringify(decision) }
		: { type: "extension_ui_response", id: line.id, cancelled: true };
	return { decision, response };
}
