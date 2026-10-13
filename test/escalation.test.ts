import { describe, expect, test } from "bun:test";
import { defaultJevConfig } from "../src/config";
import {
	ESCALATION_SCHEMA,
	escalate,
	EscalationError,
	extractJsonObject,
	parseDecision,
	pollUntil,
	resolveTransport,
	type EscalationRequest,
	type Escalator,
} from "../src/escalation";

export function sampleRequest(): EscalationRequest {
	return {
		schema: ESCALATION_SCHEMA,
		id: "req-1",
		source: "gate",
		tool: "bash",
		arguments: { command: "rm -rf src && git push --force" },
		verdict: { summary: "destructive 0.99", reasons: ["destructive 0.99"], scores: { destructive: 0.99 }, model: "typesafe/jev-latest" },
		cwd: "/tmp/project",
		at: 1,
	};
}

describe("parseDecision", () => {
	test.each([
		['{"decision":"approve","reason":"looks fine","by":"lead"}', { decision: "approve", reason: "looks fine", by: "lead" }],
		['Sure. {"decision": "deny", "reason": "not in scope"} thanks', { decision: "deny", reason: "not in scope" }],
		["approve", { decision: "approve" }],
		["**DENY** - touches prod", { decision: "deny", reason: "touches prod" }],
		["Escalate: waiting on the user", { decision: "escalate", reason: "waiting on the user" }],
		["yes", { decision: "approve" }],
	])("%s", (input, expected) => expect(parseDecision(input)).toEqual(expected as never));

	test("objects with approved boolean", () => {
		expect(parseDecision({ approved: false, reason: "no" })).toEqual({ decision: "deny", reason: "no" });
	});

	test.each([
		"Run this past the user first",
		"OK, but deny - too risky",
		"Yes, but only after the tests pass",
		"Allow me to check with the user",
		"approve because it looks fine",
		"approvedly",
		"No idea, ask someone else",
	])("ambiguous prose is no answer: %s", (input) => expect(parseDecision(input)).toBeUndefined());

	test.each([
		["ok", "approve"],
		["Y", "approve"],
		['"no."', "deny"],
		["Approved!", "approve"],
	])("a one-word reply decides: %s", (input, decision) => expect(parseDecision(input)?.decision).toBe(decision as never));

	test("non-decisions are undefined, never deny", () => {
		expect(parseDecision("let me think about it")).toBeUndefined();
		expect(parseDecision("")).toBeUndefined();
		expect(parseDecision({ foo: 1 })).toBeUndefined();
		expect(parseDecision(42)).toBeUndefined();
	});

	test("extractJsonObject skips braces inside strings", () => {
		expect(extractJsonObject('x {"a":"}{","decision":"approve"} y')).toEqual({ a: "}{", decision: "approve" });
	});
});

describe("resolveTransport", () => {
	const config = defaultJevConfig().escalation;
	test("Traycer env wins under auto", () => {
		expect(resolveTransport(config, { mode: "rpc", env: { TRAYCER_AGENT_ID: "a", TRAYCER_EPIC_ID: "e" } })).toBe("traycer");
	});
	test("A2A url next", () => {
		expect(resolveTransport({ ...config, a2a: { ...config.a2a, url: "https://x" } }, { mode: "rpc", env: {} })).toBe("a2a");
	});
	test("RPC mode next, else none", () => {
		expect(resolveTransport(config, { mode: "rpc", env: {} })).toBe("pi-rpc");
		expect(resolveTransport(config, { mode: "tui", env: {} })).toBe("none");
	});
	test("explicit transport is honoured", () => {
		expect(resolveTransport({ ...config, transport: "none" }, { mode: "rpc", env: { TRAYCER_AGENT_ID: "a", TRAYCER_EPIC_ID: "e" } })).toBe("none");
	});
});

describe("escalate", () => {
	const timing = { timeoutSeconds: 10, humanTimeoutSeconds: 100 };

	test("approve outcome carries transport and latency", async () => {
		const escalator: Escalator = { name: "a2a", request: async () => ({ decision: "approve", by: "lead" }) };
		const outcome = await escalate(escalator, sampleRequest(), timing);
		expect(outcome).toMatchObject({ decision: "approve", by: "lead", transport: "a2a", viaHuman: false });
	});

	test("onEscalated extends the deadline once and marks viaHuman", async () => {
		let clock = 0;
		const deadlines: number[] = [];
		const escalator: Escalator = {
			name: "traycer",
			async request(_req, wait) {
				deadlines.push(wait.deadline);
				clock = 5_000;
				wait.onEscalated?.({ decision: "escalate" });
				wait.onEscalated?.({ decision: "escalate" });
				deadlines.push(wait.deadline);
				return { decision: "deny", reason: "user said no" };
			},
		};
		let notified = 0;
		const outcome = await escalate(escalator, sampleRequest(), timing, { now: () => clock, onEscalated: () => notified++ });
		expect(deadlines).toEqual([10_000, 105_000]);
		expect(notified).toBe(1);
		expect(outcome).toMatchObject({ decision: "deny", viaHuman: true, latencyMs: 5_000 });
	});

	test("transport failure propagates for the caller's fallback", async () => {
		const escalator: Escalator = {
			name: "a2a",
			request: async () => {
				throw new EscalationError("unreachable");
			},
		};
		await expect(escalate(escalator, sampleRequest(), timing)).rejects.toThrow("unreachable");
	});
});

describe("pollUntil", () => {
	test("returns the first value", async () => {
		let n = 0;
		const value = await pollUntil(async () => (++n >= 3 ? "done" : undefined), { intervalMs: 1, wait: { deadline: Date.now() + 1000 } });
		expect(value).toBe("done");
		expect(n).toBe(3);
	});
	test("times out", async () => {
		await expect(pollUntil(async () => undefined, { intervalMs: 5, wait: { deadline: Date.now() + 20 } })).rejects.toThrow("timed out");
	});
	test("aborts", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 10);
		await expect(
			pollUntil(async () => undefined, { intervalMs: 5, wait: { deadline: Date.now() + 5000, signal: controller.signal } }),
		).rejects.toThrow("aborted");
	});
});
