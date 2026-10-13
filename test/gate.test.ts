import { expect, test } from "bun:test";
import { defaultJevConfig } from "../src/config";
import { evaluateGate } from "../src/gate";
import { evaluateOutput } from "../src/output";
import { gateAnswers, outputAnswers } from "./helpers";

const config = defaultJevConfig();

test("clear call is not flagged", () => {
	const verdict = evaluateGate({ model: "typesafe/jev-latest", answers: gateAnswers() }, config);
	expect(verdict.flagged).toBe(false);
});

test("destructive above threshold flags", () => {
	const verdict = evaluateGate({ model: "m", answers: gateAnswers({ destructive: 0.99, impact: 3 }) }, config);
	expect(verdict.flagged).toBe(true);
	expect(verdict.reasons[0]).toBe("destructive 0.99");
	expect(verdict.reasons.some((r) => r.startsWith("impact 3.00/3"))).toBe(true);
});

test("a requested sed -i (0.77 destructive) passes", () => {
	const verdict = evaluateGate({ model: "m", answers: gateAnswers({ destructive: 0.77, beyond_scope: 0.74, impact: 1 }) }, config);
	expect(verdict.flagged).toBe(false);
});

test("output leak notice", () => {
	const verdict = evaluateOutput({ model: "m", answers: outputAnswers(0.97) }, config);
	expect(verdict.kind).toBe("leak");
});

test("output advice needs confidence", () => {
	expect(evaluateOutput({ model: "m", answers: outputAnswers(0.01, "transient", 1) }, config).kind).toBe("advice");
	expect(evaluateOutput({ model: "m", answers: outputAnswers(0.01, "environment", 0.42) }, config).kind).toBe("none");
});
