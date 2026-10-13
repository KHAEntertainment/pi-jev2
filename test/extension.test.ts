/**
 * The extension end to end against a fake pi host: session_start readiness,
 * the tool_call gate in each mode, the escalation fallback, the output judge,
 * and the two tools.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jevExtension from "../src/index";
import { fakeContext, fakePi, fakeRegistry, gateAnswers, outputAnswers } from "./helpers";

let root: string;
let saved: Record<string, string | undefined>;
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "TRAYCER_AGENT_ID", "TRAYCER_EPIC_ID", "TRAYCER_PARENT_AGENT_ID"];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-jev-ext-"));
	saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	for (const key of ENV_KEYS) delete process.env[key];
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	mkdirSync(join(root, "agent"), { recursive: true });
	mkdirSync(join(root, "project", ".pi"), { recursive: true });
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	rmSync(root, { recursive: true, force: true });
});

function configure(value: unknown) {
	writeFileSync(join(root, "agent", "pi-jev.json"), JSON.stringify(value));
}

const destructiveCall = { toolName: "bash", toolCallId: "call-1", input: { command: "rm -rf src && git push --force origin main" } };

async function start(
	pi: ReturnType<typeof fakePi>,
	ctxOptions: Parameters<typeof fakeContext>[1] = {},
	registry = fakeRegistry(() => ({ answers: gateAnswers({ destructive: 0.99, impact: 3 }) })),
) {
	jevExtension(pi.api);
	const ctx = fakeContext(registry, ctxOptions);
	ctx.cwd = join(root, "project");
	await pi.emit("session_start", { reason: "startup" }, ctx);
	return { ctx, registry };
}

describe("session_start", () => {
	test("a host without the classifier runtime stays inactive and says so", async () => {
		const pi = fakePi();
		jevExtension(pi.api);
		const ctx = fakeContext({ find: () => undefined });
		await pi.emit("session_start", {}, ctx);
		expect(ctx.notifications.some((n) => n.message.includes("pi 0.99 or later"))).toBe(true);
		expect(await pi.emit("tool_call", destructiveCall, ctx)).toBeUndefined();
	});

	test("missing credentials name the provider's login", async () => {
		configure({ model: "openrouter/typesafe/jev-1.13" });
		const pi = fakePi();
		const { ctx } = await start(pi, {}, fakeRegistry(() => ({}), { configured: false }));
		expect(ctx.notifications.some((n) => n.message.includes("/login openrouter"))).toBe(true);
	});

	test("an unknown model is reported", async () => {
		configure({ model: "openrouter/nobody/nothing" });
		const pi = fakePi();
		const { ctx } = await start(pi);
		expect(ctx.notifications.some((n) => n.message.includes("not in the model catalog"))).toBe(true);
	});

	test("an uncalibrated model warns before it can block", async () => {
		configure({ model: "cloudflare-workers-ai/@cf/cloudflare/clef", gate: { mode: "enforce" } });
		const pi = fakePi();
		const { ctx } = await start(pi);
		expect(ctx.notifications.some((n) => n.message.includes("not a Jev model"))).toBe(true);
	});

	test("jev_escalate is active only with an orchestrator", async () => {
		const tui = fakePi();
		await start(tui, { mode: "tui" });
		expect(tui.active).not.toContain("jev_escalate");
		const rpc = fakePi();
		await start(rpc, { mode: "rpc" });
		expect(rpc.active).toContain("jev_escalate");
		expect(rpc.active).toContain("jev_ask");
	});
});

describe("gate modes", () => {
	test("shadow reports and runs", async () => {
		const pi = fakePi();
		const { ctx, registry } = await start(pi);
		expect(await pi.emit("tool_call", destructiveCall, ctx)).toBeUndefined();
		expect(ctx.notifications.some((n) => n.message.startsWith("jev shadow: bash - destructive 0.99"))).toBe(true);
		expect(registry.calls[0]?.model).toBe("typesafe/jev-latest");
		expect(pi.entries.some((e) => (e.data as { kind: string }).kind === "gate")).toBe(true);
	});

	test("enforce asks locally and blocks on decline", async () => {
		configure({ gate: { mode: "enforce" } });
		const pi = fakePi();
		const { ctx } = await start(pi, { confirm: false });
		const result = (await pi.emit("tool_call", destructiveCall, ctx)) as { block: boolean; reason: string };
		expect(result.block).toBe(true);
		expect(result.reason).toContain("(declined)");
		expect(ctx.confirms).toHaveLength(1);
	});

	test("classifier error fails open", async () => {
		configure({ gate: { mode: "enforce" } });
		const pi = fakePi();
		const { ctx } = await start(pi, {}, fakeRegistry(() => ({ stopReason: "error", errorMessage: "HTTP 529" })));
		expect(await pi.emit("tool_call", destructiveCall, ctx)).toBeUndefined();
		expect(ctx.notifications.some((n) => n.type === "error" && n.message.includes("failing open"))).toBe(true);
	});
});

describe("escalate mode", () => {
	test("pi-rpc parent approves: the call runs, no local prompt", async () => {
		configure({ gate: { mode: "escalate" } });
		const pi = fakePi();
		const { ctx } = await start(pi, { mode: "rpc", input: async () => '{"decision":"approve","by":"parent"}' });
		expect(await pi.emit("tool_call", destructiveCall, ctx)).toBeUndefined();
		expect(ctx.inputs).toHaveLength(1);
		expect(JSON.parse(ctx.inputs[0]?.placeholder ?? "{}").verdict.summary).toContain("destructive 0.99");
		expect(ctx.confirms).toHaveLength(0);
		const record = pi.entries.map((e) => e.data as { kind: string; decision?: string }).find((r) => r.kind === "escalation");
		expect(record?.decision).toBe("approve");
	});

	test("pi-rpc parent denies: blocked with the parent's reason", async () => {
		configure({ gate: { mode: "escalate" } });
		const pi = fakePi();
		const { ctx } = await start(pi, { mode: "rpc", input: async () => "deny: no force pushes to main" });
		const result = (await pi.emit("tool_call", destructiveCall, ctx)) as { block: boolean; reason: string };
		expect(result.block).toBe(true);
		expect(result.reason).toContain("denied by pi parent: no force pushes to main");
	});

	test("no answer falls back to the enforce rule (local confirm)", async () => {
		configure({ gate: { mode: "escalate" } });
		const pi = fakePi();
		const { ctx } = await start(pi, { mode: "rpc", input: async () => undefined, confirm: true });
		expect(await pi.emit("tool_call", destructiveCall, ctx)).toBeUndefined();
		expect(ctx.confirms).toHaveLength(1);
		const record = pi.entries.map((e) => e.data as { kind: string; decision?: string }).find((r) => r.kind === "escalation");
		expect(record?.decision).toBe("fallback");
	});

	test("no transport, headless: warns and runs (fail open)", async () => {
		configure({ gate: { mode: "escalate" } });
		const pi = fakePi();
		const { ctx } = await start(pi, { mode: "json", hasUI: false });
		expect(await pi.emit("tool_call", destructiveCall, ctx)).toBeUndefined();
		expect(ctx.notifications.some((n) => n.message.includes("escalate mode has no orchestrator"))).toBe(true);
		expect(ctx.notifications.some((n) => n.message.includes("headless: not blocking"))).toBe(true);
	});

	test("Traycer env routes through the CLI", async () => {
		process.env.TRAYCER_AGENT_ID = "child-1";
		process.env.TRAYCER_EPIC_ID = "epic-1";
		configure({ gate: { mode: "escalate" }, escalation: { pollMs: 1, traycer: { parentAgentId: "lead-1" } } });
		let inboxReads = 0;
		const pi = fakePi(async (_command, args) => {
			if (args[1] === "send") return { code: 0, stderr: "", stdout: '{"type":"result","responseId":"r-1"}' };
			inboxReads += 1;
			const messages = inboxReads > 1 ? [{ responseId: "r-1", prompt: '{"decision":"deny","reason":"ask the user first"}' }] : [];
			return { code: 0, stderr: "", stdout: JSON.stringify({ type: "result", messages }) };
		});
		const { ctx } = await start(pi, { mode: "tui" });
		const result = (await pi.emit("tool_call", destructiveCall, ctx)) as { block: boolean; reason: string };
		expect(result.reason).toContain("denied by lead-1: ask the user first");
		expect(pi.execCalls.some((c) => c.command === "traycer" && c.args.includes("--to") && c.args.includes("lead-1"))).toBe(true);
	});

	test("sibling identical calls share one escalation", async () => {
		configure({ gate: { mode: "escalate" } });
		const pi = fakePi();
		let resolveInput: (value: string) => void = () => undefined;
		const { ctx } = await start(pi, { mode: "rpc", input: () => new Promise((resolve) => (resolveInput = resolve)) });
		const first = pi.emit("tool_call", destructiveCall, ctx);
		const second = pi.emit("tool_call", { ...destructiveCall, toolCallId: "call-2" }, ctx);
		await new Promise((resolve) => setTimeout(resolve, 10));
		resolveInput("approve");
		expect(await first).toBeUndefined();
		expect(await second).toBeUndefined();
		expect(ctx.inputs).toHaveLength(1);
	});
});

describe("output judge and tools", () => {
	test("leak notice rides on the tool result", async () => {
		const pi = fakePi();
		const { ctx } = await start(pi, {}, fakeRegistry(() => ({ answers: outputAnswers(0.97) })));
		const result = (await pi.emit(
			"tool_result",
			{ toolName: "bash", toolCallId: "c", input: { command: "cat .env" }, content: [{ type: "text", text: "OPENAI_API_KEY=sk-..." }], isError: false },
			ctx,
		)) as { content: { text: string }[] };
		expect(result.content.at(-1)?.text).toContain("[pi-jev] Jev flagged this output as containing a secret");
	});

	test("jev_ask wraps text state and accepts bool/noul", async () => {
		const pi = fakePi();
		const registry = fakeRegistry(() => ({ answers: { relevant: { type: "bool", probability: 0.8 } } }));
		const { ctx } = await start(pi, {}, registry);
		const tool = pi.tools.get("jev_ask");
		const result = await tool.execute(
			"t",
			{ state: "some text", questions: [{ id: "relevant", type: "noul", instructions: "Is it relevant?" }] },
			undefined,
			undefined,
			ctx,
		);
		expect(result.details.ok).toBe(true);
		expect(result.content[0].text).toContain("relevant: yes 0.80");
		expect(registry.calls.at(-1)?.state).toEqual({ text: "some text" });
	});

	test("jev_escalate returns the orchestrator's decision", async () => {
		const pi = fakePi();
		const { ctx } = await start(pi, { mode: "rpc", input: async () => '{"decision":"approve","reason":"go ahead"}' });
		const tool = pi.tools.get("jev_escalate");
		const result = await tool.execute("t", { question: "May I drop the staging DB?", action: "psql -c 'drop database staging'" }, undefined, undefined, ctx);
		expect(result.content[0].text).toBe("jev_escalate: approved by pi parent: go ahead.");
		expect(JSON.parse(ctx.inputs[0]?.placeholder ?? "{}").source).toBe("agent");
	});
});
