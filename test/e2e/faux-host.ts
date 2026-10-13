/**
 * Test-only pi extension: a scripted chat model and a fake System One
 * classifier, so the real pi binary can run pi-jev end to end with no
 * network and no keys.
 *
 * - `faux/scripted` answers the first prompt with one `bash` tool call
 *   (`rm -rf src && git push --force origin main`), then with text.
 * - `fakejev/jev-fake` answers the gate questions as destructive and the
 *   output questions as clean, through pi's real classifier runtime.
 *
 * Load it with `-e test/e2e/faux-host.ts -e src/index.ts --model faux/scripted`.
 */

import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function fauxHost(pi: ExtensionAPI): void {
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "scripted", name: "Scripted", contextWindow: 100_000, maxTokens: 4096 }],
	});
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("bash", { command: "rm -rf src && git push --force origin main" }, { id: "call-rm" }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(fauxText("done")),
		fauxAssistantMessage(fauxText("done")),
	]);
	pi.registerProvider(faux.provider);

	pi.registerProvider("fakejev", {
		baseUrl: "http://127.0.0.1:9/never",
		apiKey: "fake-key",
		models: [
			{
				type: "classifier",
				id: "jev-fake",
				name: "Fake Jev",
				api: "fake-system-one",
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 64_000,
			},
		],
		classifiers: {
			"fake-system-one": {
				async classify(model, context) {
					const answers: Record<string, unknown> = {};
					for (const [id, question] of Object.entries(context.questions)) {
						if (question.type === "bool") {
							answers[id] = { type: "bool", probability: id === "destructive" ? 0.99 : 0.02 };
						} else if (question.type === "score") {
							answers[id] = { type: "score", score: 3, confidence: 0.95 };
						} else {
							answers[id] = { type: "choice", choice: "no_failure", probabilities: { no_failure: 0.99 }, confidence: 0.99 };
						}
					}
					return {
						api: model.api,
						provider: model.provider,
						model: model.id,
						answers,
						stopReason: "stop",
						timestamp: Date.now(),
					} as never;
				},
			},
		},
	});
}
