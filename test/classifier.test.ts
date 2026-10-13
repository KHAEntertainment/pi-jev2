import { describe, expect, test } from "bun:test";
import {
	classify,
	describeAnswer,
	isCalibratedModel,
	JevError,
	parseModelSpec,
	redact,
	rememberSecret,
} from "../src/classifier";
import { GATE_QUESTIONS } from "../src/gate";
import { fakeRegistry, gateAnswers } from "./helpers";

describe("parseModelSpec", () => {
	test("a bare id means TypeSafe", () => {
		expect(parseModelSpec("jev-latest")).toEqual({ provider: "typesafe", id: "jev-latest" });
	});
	test("splits at the first slash only", () => {
		expect(parseModelSpec("openrouter/typesafe/jev-1.13")).toEqual({ provider: "openrouter", id: "typesafe/jev-1.13" });
		expect(parseModelSpec("cloudflare-workers-ai/@cf/cloudflare/clef")).toEqual({
			provider: "cloudflare-workers-ai",
			id: "@cf/cloudflare/clef",
		});
		expect(parseModelSpec("openrouter/~typesafe/jev-latest").id).toBe("~typesafe/jev-latest");
	});
});

describe("isCalibratedModel", () => {
	test.each([
		"typesafe/jev-latest",
		"openrouter/typesafe/jev-1.13",
		"openrouter/~typesafe/jev-latest",
		"cloudflare-workers-ai/typesafe/jev",
		"vercel-ai-gateway/typesafe-ai/jev",
		"opencode/jev-1.13-free",
	])("%s is Jev", (spec) => expect(isCalibratedModel(spec)).toBe(true));
	test.each(["cloudflare-workers-ai/@cf/cloudflare/clef", "openrouter/jaredpalmer/kev-4b", "openrouter/upstage/solar-decide"])(
		"%s is not",
		(spec) => expect(isCalibratedModel(spec)).toBe(false),
	);
});

describe("classify", () => {
	test("routes through the registry with the key override", async () => {
		const registry = fakeRegistry(() => ({ answers: gateAnswers() }));
		const response = await classify(registry, {
			model: "openrouter/typesafe/jev-1.13",
			state: { x: 1 },
			questions: GATE_QUESTIONS,
			apiKey: "sk-test",
		});
		expect(response.model).toBe("openrouter/typesafe/jev-1.13");
		expect(registry.calls[0]).toEqual({ model: "openrouter/typesafe/jev-1.13", state: { x: 1 }, apiKey: "sk-test" });
	});

	test("an error result throws so callers fail open", async () => {
		const registry = fakeRegistry(() => ({ stopReason: "error", errorMessage: "HTTP 401" }));
		await expect(classify(registry, { model: "typesafe/jev-latest", state: {}, questions: GATE_QUESTIONS })).rejects.toThrow("HTTP 401");
	});

	test("an unknown model throws", async () => {
		const registry = fakeRegistry(() => ({}));
		await expect(classify(registry, { model: "nope/x", state: {}, questions: GATE_QUESTIONS })).rejects.toBeInstanceOf(JevError);
	});

	test("a skipped question is a failure, not a zero", async () => {
		const answers = gateAnswers();
		delete answers.impact;
		const registry = fakeRegistry(() => ({ answers }));
		await expect(classify(registry, { model: "typesafe/jev-latest", state: {}, questions: GATE_QUESTIONS })).rejects.toThrow('did not answer "impact"');
	});

	test("a wrongly typed answer is a failure", async () => {
		const answers = gateAnswers();
		answers.destructive = { type: "score", score: 1, confidence: 1 };
		const registry = fakeRegistry(() => ({ answers }));
		await expect(classify(registry, { model: "typesafe/jev-latest", state: {}, questions: GATE_QUESTIONS })).rejects.toThrow("is not a bool");
	});

	test("a rejecting host still yields a JevError", async () => {
		const registry = fakeRegistry(() => {
			throw new Error("boom");
		});
		await expect(classify(registry, { model: "typesafe/jev-latest", state: {}, questions: GATE_QUESTIONS })).rejects.toBeInstanceOf(JevError);
	});
});

test("describeAnswer takes score levels from the question", () => {
	expect(describeAnswer({ type: "score", score: 2.5, confidence: 0.8 }, GATE_QUESTIONS.impact)).toBe("2.50/3 (conf 0.80)");
	expect(describeAnswer({ type: "bool", probability: 0.42 })).toBe("yes 0.42");
});

test("redact scrubs remembered secrets", () => {
	rememberSecret("sk-or-v1-abcdefgh");
	expect(redact("token sk-or-v1-abcdefgh here")).toBe("token [redacted] here");
});
