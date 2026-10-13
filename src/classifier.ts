/**
 * Classification through the host's model runtime.
 *
 * pi 0.99 ships classifier support in `ctx.modelRegistry.classify()`: the same
 * System One request (`{ model, state, questions }`) TypeSafe Jev takes, routed
 * to whichever provider serves the model - TypeSafe, OpenRouter, Cloudflare
 * Workers AI, Vercel AI Gateway, OpenCode Zen, or a custom provider from
 * models.json - with credentials pi already holds (env, auth.json, `/login`).
 * So this module owns no HTTP, no endpoint, and no key lookup: it names a
 * model, hands the registry the questions, and checks the answers.
 *
 * It imports only types from pi, and takes the registry as a parameter, so it
 * runs against a fake registry in tests.
 */

import type {
	ClassifierAnswer,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierQuestion,
	ClassifierResult,
	ModelsClassifierOptions,
} from "@earendil-works/pi-ai";

export const DEFAULT_PROVIDER = "typesafe";
export const DEFAULT_MODEL = "typesafe/jev-latest";
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_RETRIES = 2;

/** Structured data the questions are judged against. */
export type JevState = ClassifierContext["state"];
export type JevQuestion = ClassifierQuestion;
export type JevAnswer = ClassifierAnswer;

export interface JevUsage {
	input?: number;
	output?: number;
}

export interface JevResponse {
	/** `provider/id` of the model that answered. */
	model: string;
	answers: Record<string, JevAnswer>;
	usage?: JevUsage;
}

/** The slice of pi's ModelRegistry this module needs. */
export interface ClassifierRegistry {
	findOfType(
		type: "classifier",
		provider: string,
		modelId: string,
	): ClassifierModel<ClassifierApi> | undefined;
	classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ModelsClassifierOptions,
	): Promise<ClassifierResult>;
	getProviderAuthStatus?(provider: string): {
		configured: boolean;
		source?: string;
		label?: string;
	};
}

export interface ModelSpec {
	provider: string;
	id: string;
}

export interface ClassifyCall {
	state: JevState;
	questions: Record<string, JevQuestion>;
	/** `provider/id`, or a bare id meaning TypeSafe. */
	model: string;
	timeoutMs?: number;
	retries?: number;
	/** Optional override; without it pi resolves the provider's credentials. */
	apiKey?: string;
	/** Nested work should pass the extension context signal so Esc cancels it. */
	signal?: AbortSignal;
}

export class JevError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "JevError";
	}
}

/**
 * `typesafe/jev-latest` -> typesafe + jev-latest. The split is at the first
 * slash because provider ids have none and model ids often do
 * (`openrouter/typesafe/jev-1.13`). A bare id keeps the 0.3 meaning: TypeSafe.
 */
export function parseModelSpec(spec: string): ModelSpec {
	const trimmed = spec.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) {
		return { provider: DEFAULT_PROVIDER, id: trimmed };
	}
	return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}

export function formatModelSpec(spec: ModelSpec): string {
	return `${spec.provider}/${spec.id}`;
}

/** Whether the host exposes the classifier runtime at all (pi >= 0.99). */
export function hasClassifierRuntime(
	registry: unknown,
): registry is ClassifierRegistry {
	return (
		typeof registry === "object" &&
		registry !== null &&
		typeof Reflect.get(registry, "classify") === "function" &&
		typeof Reflect.get(registry, "findOfType") === "function"
	);
}

export function resolveModel(
	registry: ClassifierRegistry,
	spec: string,
): ClassifierModel<ClassifierApi> | undefined {
	const { provider, id } = parseModelSpec(spec);
	return registry.findOfType("classifier", provider, id);
}

/**
 * Jev models are what the thresholds in README `## Calibration` were measured
 * on. Any other System One model may sit on a different scale, so callers warn
 * before letting it block anything.
 */
export function isCalibratedModel(spec: string): boolean {
	const { id } = parseModelSpec(spec);
	return /(^|\/|~)jev([-.]|$)/.test(id);
}

/**
 * Evaluate every question against the state in one request. The runtime never
 * rejects, so an error result is turned into a throw here: callers keep one
 * catch path that fails open, as they did with the 0.3 HTTP client.
 */
export async function classify(
	registry: ClassifierRegistry,
	call: ClassifyCall,
): Promise<JevResponse> {
	validateQuestions(call.questions);
	const spec = parseModelSpec(call.model);
	const model = registry.findOfType("classifier", spec.provider, spec.id);
	if (!model) {
		throw new JevError(
			`classifier ${formatModelSpec(spec)} is not in the model catalog`,
		);
	}
	const options: ModelsClassifierOptions = {
		signal: call.signal,
		timeoutMs: call.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		maxRetries: call.retries ?? DEFAULT_RETRIES,
	};
	if (call.apiKey) options.apiKey = call.apiKey;

	let result: ClassifierResult;
	try {
		result = await registry.classify(
			model,
			{ state: call.state, questions: call.questions },
			options,
		);
	} catch (error) {
		// Documented as never rejecting; a host bug must still fail open.
		throw new JevError(error instanceof Error ? error.message : String(error));
	}
	if (result.stopReason === "aborted") throw new JevError("request aborted");
	if (result.stopReason !== "stop") {
		throw new JevError(result.errorMessage ?? "classifier returned an error");
	}
	return normalizeResult(result, call.questions);
}

/** Fail early with a useful message instead of paying for a rejected request. */
function validateQuestions(questions: Record<string, JevQuestion>): void {
	const entries = Object.entries(questions);
	if (entries.length === 0) {
		throw new JevError("no questions provided");
	}
	for (const [id, question] of entries) {
		if (typeof question?.instructions !== "string" || !question.instructions.trim()) {
			throw new JevError(`question "${id}": instructions are required`);
		}
		if (question.type === "score" && question.criteria.length < 2) {
			throw new JevError(`question "${id}": score needs at least two levels`);
		}
		if (
			question.type === "choice" &&
			Object.keys(question.criteria ?? {}).length === 0
		) {
			throw new JevError(`question "${id}": choice needs at least one option`);
		}
	}
}

/**
 * A response must answer every question it was asked, with the asked type.
 * A missing answer is not a zero: callers that default absent probabilities to
 * 0 would read it as "certainly not", so it fails here and reaches the same
 * error path as a timeout. The runtime checks this too; keeping it here makes
 * the guarantee independent of the host version.
 */
function normalizeResult(
	result: ClassifierResult,
	questions: Record<string, JevQuestion>,
): JevResponse {
	const answers: unknown = result.answers;
	if (typeof answers !== "object" || answers === null) {
		throw new JevError("response is missing the answers map");
	}
	for (const [id, question] of Object.entries(questions)) {
		const answer: unknown = Reflect.get(answers, id);
		if (!isAnswer(answer)) {
			throw new JevError(`response did not answer "${id}"`);
		}
		if (answer.type !== question.type) {
			throw new JevError(`answer "${id}" is not a ${question.type}`);
		}
	}
	const usage = result.usage
		? { input: result.usage.input, output: result.usage.output }
		: undefined;
	return {
		model: `${result.provider}/${result.model}`,
		answers: result.answers,
		usage,
	};
}

function isAnswer(value: unknown): value is JevAnswer {
	if (typeof value !== "object" || value === null) return false;
	const type: unknown = Reflect.get(value, "type");
	if (type === "bool") return isProbability(Reflect.get(value, "probability"));
	if (type === "choice") {
		return (
			typeof Reflect.get(value, "choice") === "string" &&
			typeof Reflect.get(value, "confidence") === "number"
		);
	}
	if (type === "score") {
		return (
			typeof Reflect.get(value, "score") === "number" &&
			typeof Reflect.get(value, "confidence") === "number"
		);
	}
	return false;
}

function isProbability(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value);
}

export function answerFor(
	response: JevResponse,
	id: string,
): JevAnswer | undefined {
	return response.answers[id];
}

/** Probability that a bool answered yes, or undefined if the id is not a bool. */
export function boolValue(response: JevResponse, id: string): number | undefined {
	const answer = response.answers[id];
	return answer?.type === "bool" ? answer.probability : undefined;
}

/** Bool answers carry no confidence; only choice and score do. */
export function confidenceFor(
	response: JevResponse,
	id: string,
): number | undefined {
	const answer = response.answers[id];
	return answer && answer.type !== "bool" ? answer.confidence : undefined;
}

/**
 * Compact single-line rendering for notify()/status text. The runtime's score
 * answer carries no legend, so the level count comes from the question.
 */
export function describeAnswer(
	answer: JevAnswer | undefined,
	question?: JevQuestion,
): string {
	if (!answer) return "no answer";
	if (answer.type === "bool") return `yes ${answer.probability.toFixed(2)}`;
	if (answer.type === "choice") {
		return `${answer.choice} (conf ${answer.confidence.toFixed(2)})`;
	}
	const levels = question?.type === "score" ? question.criteria.length - 1 : 0;
	return `${answer.score.toFixed(2)}${levels > 0 ? `/${levels}` : ""} (conf ${answer.confidence.toFixed(2)})`;
}

/**
 * Secrets observed this process, so no notification or state string can leak an
 * API key or orchestrator token back into the session transcript.
 */
const secrets = new Set<string>();

export function rememberSecret(secret: string | undefined): void {
	if (secret && secret.trim().length >= 8) secrets.add(secret.trim());
}

export function redact(text: string): string {
	let out = text;
	for (const secret of secrets) out = out.split(secret).join("[redacted]");
	return out;
}

/** Provider-specific hint for a classifier without credentials. */
export function authHint(provider: string): string {
	switch (provider) {
		case "typesafe":
			return "set TYPESAFE_API_KEY, run /login typesafe, or set apiKeyFile in pi-jev.json";
		case "openrouter":
			return "run /login openrouter (OAuth) or set OPENROUTER_API_KEY";
		case "cloudflare-workers-ai":
			return "set CLOUDFLARE_API_KEY and CLOUDFLARE_ACCOUNT_ID, or run /login cloudflare-workers-ai";
		case "vercel-ai-gateway":
			return "set AI_GATEWAY_API_KEY or run /login vercel-ai-gateway";
		case "opencode":
			return "set OPENCODE_API_KEY or run /login opencode";
		case "openai":
			return "set OPENAI_API_KEY (an OpenAI API key; ChatGPT sign-in is rejected for classifiers)";
		default:
			return `configure credentials for ${provider} (/login ${provider}, its env var, or models.json)`;
	}
}
