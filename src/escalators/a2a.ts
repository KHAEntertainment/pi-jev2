/**
 * Escalate to any orchestrator that speaks A2A v1.0 (a2a-protocol.org,
 * JSON-RPC binding). Zero dependencies: fetch plus types.
 *
 *   SendMessage  {message:{role:"ROLE_USER", parts:[{data:<request>}, {text}]},
 *                 configuration:{returnImmediately:true}}
 *   GetTask      {id}   polled every pollMs until a decision
 *   CancelTask   {id}   on abort, best effort
 *
 * Task state -> decision:
 *   TASK_STATE_INPUT_REQUIRED   escalated to a human: keep waiting
 *   TASK_STATE_COMPLETED        the decision in the status message or an
 *                               artifact (data part, else text); a task that
 *                               completes without one is no answer
 *   TASK_STATE_REJECTED         deny
 *   FAILED / CANCELED / AUTH_REQUIRED, or an error   no answer -> local fallback
 *
 * A server that answers SendMessage with a Message rather than a Task is
 * read the same way, once. The URL may be the JSON-RPC endpoint itself or a
 * bare origin, in which case `/.well-known/agent-card.json` names the
 * endpoint.
 */

import {
	ESCALATION_SCHEMA,
	EscalationError,
	newRequestId,
	parseDecision,
	pollUntil,
	type EscalationDecision,
	type EscalationRequest,
	type EscalationWait,
	type Escalator,
} from "../escalation";

export const A2A_VERSION = "1.0";
const REQUEST_TIMEOUT_MS = 30_000;

export interface A2AOptions {
	url: string;
	token: string | undefined;
	pollMs: number;
	fetch?: typeof fetch;
	now?: () => number;
}

type Final = EscalationDecision & { decision: "approve" | "deny" };

export function a2aEscalator(options: A2AOptions): Escalator {
	const doFetch = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	let endpoint: string | undefined;
	let rpcId = 0;

	function headers(): Record<string, string> {
		const out: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json",
			"A2A-Version": A2A_VERSION,
		};
		if (options.token) out.Authorization = `Bearer ${options.token}`;
		return out;
	}

	async function resolveEndpoint(signal?: AbortSignal): Promise<string> {
		if (endpoint) return endpoint;
		const url = new URL(options.url);
		if (url.pathname !== "/" && url.pathname !== "") {
			endpoint = options.url;
			return endpoint;
		}
		const card = await getJson(new URL("/.well-known/agent-card.json", url).toString(), signal);
		endpoint = jsonRpcUrl(card) ?? options.url;
		return endpoint;
	}

	async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
		const response = await doFetch(url, {
			headers: headers(),
			signal: withTimeout(signal),
		});
		if (!response.ok) throw new EscalationError(`agent card HTTP ${response.status}`);
		return response.json();
	}

	async function call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
		const target = await resolveEndpoint(signal);
		rpcId += 1;
		let response: Response;
		try {
			response = await doFetch(target, {
				method: "POST",
				headers: headers(),
				body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
				signal: withTimeout(signal),
			});
		} catch (error) {
			throw new EscalationError(`A2A ${method}: ${error instanceof Error ? error.message : String(error)}`);
		}
		const text = await response.text();
		if (!response.ok) {
			throw new EscalationError(`A2A ${method}: HTTP ${response.status} ${text.slice(0, 200)}`);
		}
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			throw new EscalationError(`A2A ${method}: response was not JSON`);
		}
		const error = typeof body === "object" && body !== null ? Reflect.get(body, "error") : undefined;
		if (error) {
			const message = typeof error === "object" && error !== null ? Reflect.get(error, "message") : error;
			throw new EscalationError(`A2A ${method}: ${String(message)}`);
		}
		return typeof body === "object" && body !== null ? Reflect.get(body, "result") : undefined;
	}

	return {
		name: "a2a",
		async request(req: EscalationRequest, wait: EscalationWait): Promise<Final> {
			const result = await call(
				"SendMessage",
				{
					message: {
						messageId: newRequestId(),
						role: "ROLE_USER",
						parts: [
							{ data: req, mediaType: "application/json" },
							{ text: summaryText(req) },
						],
						metadata: { schema: ESCALATION_SCHEMA },
					},
					configuration: { returnImmediately: true, acceptedOutputModes: ["application/json", "text/plain"] },
					metadata: { schema: ESCALATION_SCHEMA },
				},
				wait.signal,
			);

			const direct = Reflect.get(result ?? {}, "message");
			if (direct) {
				const decision = decisionFromParts(Reflect.get(direct, "parts"));
				if (decision?.decision === "approve" || decision?.decision === "deny") {
					return { ...decision, decision: decision.decision, by: decision.by ?? "a2a" };
				}
				throw new EscalationError("A2A reply was a message without a decision");
			}
			const task = Reflect.get(result ?? {}, "task") ?? result;
			const taskId = typeof task === "object" && task !== null ? Reflect.get(task, "id") : undefined;
			if (typeof taskId !== "string") throw new EscalationError("A2A SendMessage returned no task");

			try {
				// The task SendMessage returned may already be settled.
				const immediate = decisionFromTask(task, wait);
				if (immediate) return immediate;
				return await pollUntil<Final>(
					async () =>
						decisionFromTask(
							await call("GetTask", { id: taskId, historyLength: 1 }, wait.signal),
							wait,
						),
					{ intervalMs: options.pollMs, wait, now },
				);
			} catch (error) {
				// Withdraw the request so the orchestrator does not act on a stale ask.
				await call("CancelTask", { id: taskId }).catch(() => undefined);
				throw error;
			}
		},
	};
}

function withTimeout(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	// AbortSignal.any tracks the combined signal weakly, so polling for half
	// an hour does not pin a listener per request onto the session signal.
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** The decision a task carries, undefined while it is still open. */
export function decisionFromTask(task: unknown, wait: EscalationWait): Final | undefined {
	if (typeof task !== "object" || task === null) throw new EscalationError("A2A task is missing");
	const status = Reflect.get(task, "status");
	const state = normalizeState(typeof status === "object" && status !== null ? Reflect.get(status, "state") : undefined);
	const statusMessage = typeof status === "object" && status !== null ? Reflect.get(status, "message") : undefined;
	const fromMessage = decisionFromParts(statusMessage ? Reflect.get(statusMessage, "parts") : undefined);

	switch (state) {
		case "SUBMITTED":
		case "WORKING":
			return undefined;
		case "INPUT_REQUIRED":
			wait.onEscalated?.(fromMessage ?? { decision: "escalate" });
			return undefined;
		case "COMPLETED": {
			const decision = fromMessage ?? decisionFromArtifacts(Reflect.get(task, "artifacts"));
			// Completing without saying approve or deny is not an approval: the
			// local enforce rule decides, as for any other non-answer.
			if (!decision || decision.decision === "escalate") {
				throw new EscalationError("A2A task completed without an approve/deny decision");
			}
			return { ...decision, decision: decision.decision, by: decision.by ?? "a2a" };
		}
		case "REJECTED":
			return { decision: "deny", by: fromMessage?.by ?? "a2a", reason: fromMessage?.reason };
		case "FAILED":
		case "CANCELED":
		case "AUTH_REQUIRED":
			throw new EscalationError(`A2A task ended ${state.toLowerCase()}`);
		default:
			throw new EscalationError(`A2A task in unknown state ${String(state)}`);
	}
}

/** v1.0 uses TASK_STATE_*; v0.3 servers send lowercase kebab names. */
export function normalizeState(state: unknown): string | undefined {
	if (typeof state !== "string") return undefined;
	return state.replace(/^TASK_STATE_/, "").replace(/-/g, "_").toUpperCase();
}

function decisionFromArtifacts(artifacts: unknown): EscalationDecision | undefined {
	if (!Array.isArray(artifacts)) return undefined;
	for (const artifact of artifacts) {
		const decision = decisionFromParts(Reflect.get(artifact ?? {}, "parts"));
		if (decision) return decision;
	}
	return undefined;
}

export function decisionFromParts(parts: unknown): EscalationDecision | undefined {
	if (!Array.isArray(parts)) return undefined;
	// Structured data wins over prose.
	for (const part of parts) {
		const data = Reflect.get(part ?? {}, "data");
		const decision = data !== undefined ? parseDecision(data) : undefined;
		if (decision) return decision;
	}
	for (const part of parts) {
		const text = Reflect.get(part ?? {}, "text");
		const decision = typeof text === "string" ? parseDecision(text) : undefined;
		if (decision) return decision;
	}
	return undefined;
}

function jsonRpcUrl(card: unknown): string | undefined {
	const interfaces = Reflect.get(card ?? {}, "supportedInterfaces");
	if (Array.isArray(interfaces)) {
		for (const entry of interfaces) {
			const binding = Reflect.get(entry ?? {}, "protocolBinding");
			const url = Reflect.get(entry ?? {}, "url");
			if (binding === "JSONRPC" && typeof url === "string") return url;
		}
	}
	// v0.3 cards name the endpoint directly.
	const url = Reflect.get(card ?? {}, "url");
	return typeof url === "string" ? url : undefined;
}

function summaryText(req: EscalationRequest): string {
	const what = req.verdict
		? `pi-jev flagged a ${req.tool} call (${req.verdict.summary})`
		: `an agent asks for a decision before ${req.tool}: ${req.question ?? ""}`;
	return `${what}. The agent is paused until this task completes. Complete with {"decision":"approve"|"deny","reason":"..."}, reject the task to deny, or set input-required while a human decides.`;
}
