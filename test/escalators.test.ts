import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { EscalationWait } from "../src/escalation";
import { a2aEscalator, decisionFromTask, normalizeState } from "../src/escalators/a2a";
import { piRpcEscalator, readChildEscalation, relayChildEscalation, RPC_ESCALATION_TITLE } from "../src/escalators/pi-rpc";
import { parseNdjson, traycerEscalator, type Exec } from "../src/escalators/traycer";
import { sampleRequest } from "./escalation.test";

function wait(ms = 2000, extra: Partial<EscalationWait> = {}): EscalationWait {
	return { deadline: Date.now() + ms, ...extra };
}

describe("pi-rpc", () => {
	test("sends the request in the input placeholder and reads the decision", async () => {
		const seen: { title: string; placeholder?: string; timeout?: number }[] = [];
		const escalator = piRpcEscalator({
			input: async (title, placeholder, opts) => {
				seen.push({ title, placeholder, timeout: opts?.timeout });
				return '{"decision":"deny","reason":"out of scope"}';
			},
		});
		const decision = await escalator.request(sampleRequest(), wait());
		expect(decision).toEqual({ decision: "deny", reason: "out of scope", by: "pi parent" });
		expect(seen[0]?.title).toBe(RPC_ESCALATION_TITLE);
		expect(JSON.parse(seen[0]?.placeholder ?? "{}").schema).toBe("pi-jev.escalation/v1");
		expect(seen[0]?.timeout).toBeGreaterThan(0);
	});

	test("escalate asks again and marks the human hand-off", async () => {
		const answers = ["escalate", "approve"];
		let escalated = 0;
		const escalator = piRpcEscalator({ input: async () => answers.shift() });
		const decision = await escalator.request(sampleRequest(), wait(2000, { onEscalated: () => escalated++ }));
		expect(decision.decision).toBe("approve");
		expect(escalated).toBe(1);
	});

	test("cancel and gibberish are no answer", async () => {
		await expect(piRpcEscalator({ input: async () => undefined }).request(sampleRequest(), wait())).rejects.toThrow("did not answer");
		await expect(piRpcEscalator({ input: async () => "hmm" }).request(sampleRequest(), wait())).rejects.toThrow("not a decision");
	});

	test("parent relay: confirm with UI, cancel without", async () => {
		const line = {
			type: "extension_ui_request" as const,
			id: "ui-1",
			method: "input",
			title: RPC_ESCALATION_TITLE,
			placeholder: JSON.stringify(sampleRequest()),
		};
		expect(readChildEscalation(line)?.tool).toBe("bash");
		expect(readChildEscalation({ ...line, title: "something else" })).toBeUndefined();

		const withUi = await relayChildEscalation(line, { hasUI: true, ui: { confirm: async () => true } });
		expect(withUi?.response).toEqual({ type: "extension_ui_response", id: "ui-1", value: '{"decision":"approve","by":"parent user"}' });

		const headless = await relayChildEscalation(line, { hasUI: false, ui: { confirm: async () => true } });
		expect(headless?.response).toEqual({ type: "extension_ui_response", id: "ui-1", cancelled: true });

		const delegated = await relayChildEscalation(line, { hasUI: false, ui: { confirm: async () => true } }, async () => ({ decision: "deny", by: "grandparent" }));
		expect(delegated?.decision).toEqual({ decision: "deny", by: "grandparent" });
	});
});

describe("traycer", () => {
	const env = { TRAYCER_EPIC_ID: "epic-1", TRAYCER_AGENT_ID: "child-1" };

	function cli(inboxReplies: unknown[][]): { exec: Exec; calls: string[][] } {
		const calls: string[][] = [];
		const exec: Exec = async (_command, args) => {
			calls.push(args);
			if (args[1] === "send") {
				return { code: 0, stderr: "", stdout: '{"type":"progress","message":"sending"}\n{"type":"result","data":{"responseId":"resp-9"}}\n' };
			}
			if (args[1] === "list") {
				return { code: 0, stderr: "", stdout: JSON.stringify({ type: "result", agents: [{ id: "lead-1" }, { id: "child-1", parentAgentId: "lead-1" }] }) };
			}
			if (args[1] === "inbox") {
				const messages = inboxReplies.shift() ?? [];
				return { code: 0, stderr: "", stdout: JSON.stringify({ type: "result", data: { messages, nextCursor: `c${calls.length}` } }) };
			}
			return { code: 2, stderr: "unknown", stdout: "" };
		};
		return { exec, calls };
	}

	test("sends to the parent from agent list and waits for the matching reply", async () => {
		const { exec, calls } = cli([
			[{ responseId: "old", prompt: '{"decision":"approve"}' }],
			[],
			[{ responseId: "resp-9", senderAgentId: "lead-1", prompt: '{"decision":"escalate"}' }],
			[{ responseId: "resp-9", senderAgentId: "lead-1", prompt: 'The user decided. {"decision":"deny","reason":"no force pushes"}' }],
		]);
		let escalated = 0;
		const escalator = traycerEscalator(exec, { command: "traycer", parentAgentId: undefined, pollMs: 1, env });
		const decision = await escalator.request(sampleRequest(), wait(2000, { onEscalated: () => escalated++ }));
		expect(decision).toEqual({ decision: "deny", reason: "no force pushes", by: "lead-1" });
		expect(escalated).toBe(1);
		const send = calls.find((args) => args[1] === "send");
		expect(send?.slice(0, 4)).toEqual(["agent", "send", "--to", "lead-1"]);
		expect(send).toContain("--expect-reply");
		expect(send?.at(-1)).toBe("--json");
		// Polls after the initial cursor read pass --after.
		expect(calls.filter((args) => args[1] === "inbox").slice(1).every((args) => args.includes("--after"))).toBe(true);
	});

	test("configured parent skips the lookup", async () => {
		const { exec, calls } = cli([[], [{ responseId: "resp-9", prompt: "approve" }]]);
		const escalator = traycerEscalator(exec, { command: "traycer", parentAgentId: "boss", pollMs: 1, env });
		expect((await escalator.request(sampleRequest(), wait())).decision).toBe("approve");
		expect(calls.some((args) => args[1] === "list")).toBe(false);
	});

	test("outside Traycer, or a failing CLI, is no answer", async () => {
		const { exec } = cli([]);
		await expect(traycerEscalator(exec, { command: "traycer", parentAgentId: "x", pollMs: 1, env: {} }).request(sampleRequest(), wait())).rejects.toThrow("not running under Traycer");
		const failing: Exec = async () => ({ code: 1, stderr: "not logged in", stdout: "" });
		await expect(traycerEscalator(failing, { command: "traycer", parentAgentId: "x", pollMs: 1, env }).request(sampleRequest(), wait())).rejects.toThrow("not logged in");
	});

	test("times out when no reply arrives", async () => {
		const { exec } = cli([]);
		await expect(traycerEscalator(exec, { command: "traycer", parentAgentId: "x", pollMs: 5, env }).request(sampleRequest(), wait(40))).rejects.toThrow("timed out");
	});

	test("parseNdjson skips non-JSON progress", () => {
		expect(parseNdjson('progress...\n{"a":1}\n\n{"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
	});
});

describe("a2a state mapping", () => {
	test("normalizes v1 and v0.3 names", () => {
		expect(normalizeState("TASK_STATE_INPUT_REQUIRED")).toBe("INPUT_REQUIRED");
		expect(normalizeState("input-required")).toBe("INPUT_REQUIRED");
	});
	test("completed without a decision is no answer; rejected denies; failed is no answer", () => {
		expect(() => decisionFromTask({ id: "t", status: { state: "TASK_STATE_COMPLETED" } }, wait())).toThrow("without an approve/deny decision");
		expect(() =>
			decisionFromTask(
				{ id: "t", status: { state: "TASK_STATE_COMPLETED", message: { parts: [{ text: "I reviewed the request." }] } } },
				wait(),
			),
		).toThrow("without an approve/deny decision");
		expect(decisionFromTask({ id: "t", status: { state: "TASK_STATE_REJECTED" } }, wait())?.decision).toBe("deny");
		expect(() => decisionFromTask({ id: "t", status: { state: "TASK_STATE_FAILED" } }, wait())).toThrow("failed");
		expect(
			decisionFromTask(
				{ id: "t", status: { state: "TASK_STATE_COMPLETED" }, artifacts: [{ parts: [{ data: { decision: "deny", reason: "r" } }] }] },
				wait(),
			),
		).toEqual({ decision: "deny", reason: "r", by: "a2a" });
	});
});

describe("a2a against a local server", () => {
	type Script = (method: string, params: any, n: number) => unknown;
	let script: Script = () => ({});
	let seen: { method: string; params: any; headers: Headers }[] = [];
	let server: ReturnType<typeof Bun.serve>;
	let base = "";

	beforeAll(() => {
		server = Bun.serve({
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				if (url.pathname === "/.well-known/agent-card.json") {
					return Response.json({
						name: "orchestrator",
						supportedInterfaces: [
							{ url: `${base}/grpc`, protocolBinding: "GRPC", protocolVersion: "1.0" },
							{ url: `${base}/rpc`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
						],
					});
				}
				if (url.pathname !== "/rpc") return new Response("not found", { status: 404 });
				const body = (await request.json()) as { id: number; method: string; params: unknown };
				seen.push({ method: body.method, params: body.params, headers: request.headers });
				const result = script(body.method, body.params, seen.filter((s) => s.method === body.method).length);
				if (result instanceof Response) return result;
				return Response.json({ jsonrpc: "2.0", id: body.id, result });
			},
		});
		base = `http://127.0.0.1:${server.port}`;
	});
	afterAll(() => server.stop(true));

	function reset(next: Script) {
		seen = [];
		script = next;
	}

	test("discovers the JSON-RPC endpoint, waits through input-required, reads the final decision", async () => {
		reset((method, _params, n) => {
			if (method === "SendMessage") return { task: { id: "task-1", contextId: "c", status: { state: "TASK_STATE_SUBMITTED" } } };
			if (method === "GetTask" && n === 1) return { id: "task-1", status: { state: "TASK_STATE_WORKING" } };
			if (method === "GetTask" && n === 2) return { id: "task-1", status: { state: "TASK_STATE_INPUT_REQUIRED" } };
			return {
				id: "task-1",
				status: { state: "TASK_STATE_COMPLETED", message: { role: "ROLE_AGENT", parts: [{ data: { decision: "approve", by: "human:alice", reason: "ok for this branch" } }] } },
			};
		});
		let escalated = 0;
		const escalator = a2aEscalator({ url: base, token: "orch-token-123", pollMs: 1 });
		const decision = await escalator.request(sampleRequest(), wait(3000, { onEscalated: () => escalated++ }));
		expect(decision).toEqual({ decision: "approve", by: "human:alice", reason: "ok for this branch" });
		expect(escalated).toBe(1);
		const send = seen[0];
		expect(send?.method).toBe("SendMessage");
		expect(send?.headers.get("a2a-version")).toBe("1.0");
		expect(send?.headers.get("authorization")).toBe("Bearer orch-token-123");
		expect(send?.params.message.role).toBe("ROLE_USER");
		expect(send?.params.message.parts[0].data.schema).toBe("pi-jev.escalation/v1");
		expect(send?.params.configuration.returnImmediately).toBe(true);
	});

	test("a direct message reply is read once", async () => {
		reset(() => ({ message: { role: "ROLE_AGENT", parts: [{ text: "deny - not today" }] } }));
		const decision = await a2aEscalator({ url: `${base}/rpc`, token: undefined, pollMs: 1 }).request(sampleRequest(), wait());
		expect(decision).toEqual({ decision: "deny", reason: "not today", by: "a2a" });
	});

	test("JSON-RPC error and HTTP error are no answer", async () => {
		reset(() => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32009, message: "VersionNotSupported" } })));
		await expect(a2aEscalator({ url: `${base}/rpc`, token: undefined, pollMs: 1 }).request(sampleRequest(), wait())).rejects.toThrow("VersionNotSupported");
		reset(() => new Response("nope", { status: 503 }));
		await expect(a2aEscalator({ url: `${base}/rpc`, token: undefined, pollMs: 1 }).request(sampleRequest(), wait())).rejects.toThrow("HTTP 503");
	});

	test("timeout cancels the task", async () => {
		reset((method) => (method === "SendMessage" ? { task: { id: "task-2", status: { state: "TASK_STATE_WORKING" } } } : { id: "task-2", status: { state: "TASK_STATE_WORKING" } }));
		await expect(a2aEscalator({ url: `${base}/rpc`, token: undefined, pollMs: 5 }).request(sampleRequest(), wait(60))).rejects.toThrow("timed out");
		expect(seen.some((s) => s.method === "CancelTask" && s.params.id === "task-2")).toBe(true);
	});

	test("unreachable server is no answer", async () => {
		await expect(a2aEscalator({ url: "http://127.0.0.1:1/rpc", token: undefined, pollMs: 1 }).request(sampleRequest(), wait())).rejects.toThrow("A2A SendMessage");
	});
});
