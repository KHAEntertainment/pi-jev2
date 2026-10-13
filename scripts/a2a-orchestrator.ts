/**
 * A minimal A2A v1.0 orchestrator for trying escalate mode by hand.
 *
 *   bun scripts/a2a-orchestrator.ts [--port 9911] [--token secret]
 *
 * Then point pi-jev at it:
 *
 *   { "gate": { "mode": "escalate" },
 *     "escalation": { "transport": "a2a", "a2a": { "url": "http://127.0.0.1:9911" } } }
 *
 * Each escalation prints here; type `a` (approve), `d` (deny), or `h`
 * (hand to a human: the task goes INPUT_REQUIRED, then answer again), with
 * an optional reason after a space. It serves the agent card, SendMessage,
 * GetTask, and CancelTask; nothing else.
 */

import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const flag = (name: string) => {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? undefined : args[index + 1];
};
const port = Number(flag("port") ?? 9911);
const token = flag("token");

interface Task {
	id: string;
	contextId: string;
	status: { state: string; message?: unknown; timestamp: string };
}

const tasks = new Map<string, Task>();
const queue: string[] = [];
const rl = createInterface({ input: process.stdin });

function prompt() {
	const id = queue[0];
	if (!id) return;
	process.stdout.write(`[${id}] a=approve d=deny h=human, then optional reason > `);
}

rl.on("line", (line) => {
	const id = queue[0];
	const task = id ? tasks.get(id) : undefined;
	if (!id || !task) return;
	const [choice, ...rest] = line.trim().split(" ");
	const reason = rest.join(" ") || undefined;
	const now = new Date().toISOString();
	if (choice === "h") {
		task.status = { state: "TASK_STATE_INPUT_REQUIRED", timestamp: now };
		console.log("  -> INPUT_REQUIRED (answer again for the human's decision)");
		prompt();
		return;
	}
	const decision = choice === "a" ? "approve" : choice === "d" ? "deny" : undefined;
	if (!decision) return prompt();
	task.status = {
		state: "TASK_STATE_COMPLETED",
		timestamp: now,
		message: { messageId: crypto.randomUUID(), role: "ROLE_AGENT", parts: [{ data: { decision, reason, by: "a2a-orchestrator" } }] },
	};
	queue.shift();
	console.log(`  -> ${decision}`);
	prompt();
});

const server = Bun.serve({
	port,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/.well-known/agent-card.json") {
			return Response.json({
				name: "pi-jev test orchestrator",
				description: "Approves or denies pi-jev escalations from a terminal",
				version: "0.1.0",
				supportedInterfaces: [{ url: `http://127.0.0.1:${port}/rpc`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
				capabilities: { streaming: false, pushNotifications: false },
				defaultInputModes: ["application/json", "text/plain"],
				defaultOutputModes: ["application/json"],
				skills: [{ id: "approve", name: "Approve tool calls", description: "Human approval for flagged agent actions", tags: ["approval"] }],
			});
		}
		if (url.pathname !== "/rpc" || request.method !== "POST") return new Response("not found", { status: 404 });
		if (token && request.headers.get("authorization") !== `Bearer ${token}`) {
			return new Response("unauthorized", { status: 401 });
		}
		const body = (await request.json()) as { id: unknown; method: string; params: any };
		const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
		const fail = (code: number, message: string) => Response.json({ jsonrpc: "2.0", id: body.id, error: { code, message } });

		if (body.method === "SendMessage") {
			const id = crypto.randomUUID();
			const task: Task = { id, contextId: crypto.randomUUID(), status: { state: "TASK_STATE_SUBMITTED", timestamp: new Date().toISOString() } };
			tasks.set(id, task);
			queue.push(id);
			const request = body.params?.message?.parts?.find((part: any) => part.data)?.data;
			console.log(`\n=== escalation ${id}\n${JSON.stringify(request, null, 2)}`);
			if (queue.length === 1) prompt();
			return reply({ task });
		}
		if (body.method === "GetTask") {
			const task = tasks.get(body.params?.id);
			return task ? reply(task) : fail(-32001, "TaskNotFound");
		}
		if (body.method === "CancelTask") {
			const task = tasks.get(body.params?.id);
			if (!task) return fail(-32001, "TaskNotFound");
			task.status = { state: "TASK_STATE_CANCELED", timestamp: new Date().toISOString() };
			const index = queue.indexOf(task.id);
			if (index !== -1) queue.splice(index, 1);
			console.log(`  (task ${task.id} cancelled by the agent)`);
			prompt();
			return reply(task);
		}
		return fail(-32601, `method not found: ${body.method}`);
	},
});

console.log(`A2A orchestrator on http://127.0.0.1:${server.port} (agent card at /.well-known/agent-card.json)`);
