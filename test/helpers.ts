/**
 * Fakes for the slices of pi the extension touches: a classifier registry
 * that answers from a script, and an ExtensionAPI/ExtensionContext pair that
 * records handlers, notifications, and dialogs.
 */

import type { ClassifierResult } from "@earendil-works/pi-ai";
import type { ClassifierRegistry } from "../src/classifier";

export type Answers = ClassifierResult["answers"];

export function fakeRegistry(
	respond: (questions: Record<string, unknown>) => Partial<ClassifierResult> | Promise<Partial<ClassifierResult>>,
	options: { known?: string[]; configured?: boolean } = {},
): ClassifierRegistry & { calls: { model: string; state: unknown; apiKey?: string }[] } {
	const known = new Set(options.known ?? ["typesafe/jev-latest", "openrouter/typesafe/jev-1.13", "cloudflare-workers-ai/@cf/cloudflare/clef"]);
	const calls: { model: string; state: unknown; apiKey?: string }[] = [];
	return {
		calls,
		findOfType(_type, provider, id) {
			if (!known.has(`${provider}/${id}`)) return undefined;
			return {
				type: "classifier",
				id,
				name: id,
				api: "typesafe-system-one",
				provider,
				baseUrl: "https://example.invalid",
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 64000,
			};
		},
		async classify(model, context, opts) {
			calls.push({ model: `${model.provider}/${model.id}`, state: context.state, apiKey: opts?.apiKey });
			const partial = await respond(context.questions as Record<string, unknown>);
			return {
				api: model.api,
				provider: model.provider,
				model: model.id,
				answers: {},
				stopReason: "stop",
				timestamp: Date.now(),
				...partial,
			} as ClassifierResult;
		},
		getProviderAuthStatus() {
			return { configured: options.configured ?? true, source: "environment" };
		},
	};
}

/** Gate answers with every dimension clear unless overridden. */
export function gateAnswers(overrides: Partial<Record<"destructive" | "exfiltration" | "beyond_scope" | "impact", number>> = {}): Answers {
	return {
		destructive: { type: "bool", probability: overrides.destructive ?? 0.02 },
		exfiltration: { type: "bool", probability: overrides.exfiltration ?? 0.02 },
		beyond_scope: { type: "bool", probability: overrides.beyond_scope ?? 0.1 },
		impact: { type: "score", score: overrides.impact ?? 0.1, confidence: 0.9 },
	};
}

export function outputAnswers(leak = 0.01, failureClass = "no_failure", confidence = 0.95): Answers {
	return {
		leaks_secret: { type: "bool", probability: leak },
		failure_class: { type: "choice", choice: failureClass, probabilities: { [failureClass]: confidence }, confidence },
	};
}

type Handler = (event: any, ctx: any) => unknown;

export interface FakeContext {
	mode: string;
	hasUI: boolean;
	cwd: string;
	signal: AbortSignal | undefined;
	modelRegistry: unknown;
	notifications: { message: string; type?: string }[];
	statuses: (string | undefined)[];
	confirms: { title: string; message: string }[];
	inputs: { title: string; placeholder?: string }[];
	ui: any;
	sessionManager: any;
}

export function fakeContext(
	registry: unknown,
	options: {
		mode?: string;
		hasUI?: boolean;
		confirm?: boolean;
		input?: (title: string, placeholder?: string) => Promise<string | undefined>;
		userText?: string;
	} = {},
): FakeContext {
	const ctx: FakeContext = {
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		cwd: "/tmp/project",
		signal: undefined,
		modelRegistry: registry,
		notifications: [],
		statuses: [],
		confirms: [],
		inputs: [],
		ui: undefined,
		sessionManager: {
			getEntries: () => [],
			buildContextEntries: () =>
				options.userText
					? [{ type: "message", message: { role: "user", content: options.userText } }]
					: [],
		},
	};
	ctx.ui = {
		notify: (message: string, type?: string) => ctx.notifications.push({ message, type }),
		setStatus: (_key: string, text: string | undefined) => ctx.statuses.push(text),
		confirm: async (title: string, message: string) => {
			ctx.confirms.push({ title, message });
			return options.confirm ?? false;
		},
		input: async (title: string, placeholder?: string) => {
			ctx.inputs.push({ title, placeholder });
			return options.input ? options.input(title, placeholder) : undefined;
		},
	};
	return ctx;
}

export interface FakePi {
	api: any;
	handlers: Map<string, Handler[]>;
	tools: Map<string, any>;
	active: string[];
	entries: { customType: string; data: unknown }[];
	emit(name: string, event: any, ctx: any): Promise<unknown>;
	execCalls: { command: string; args: string[] }[];
}

export function fakePi(exec?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>): FakePi {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, any>();
	const entries: { customType: string; data: unknown }[] = [];
	const execCalls: { command: string; args: string[] }[] = [];
	const fake: FakePi = {
		handlers,
		tools,
		entries,
		execCalls,
		active: [],
		api: undefined,
		async emit(name, event, ctx) {
			let result: unknown;
			for (const handler of handlers.get(name) ?? []) {
				result = await handler(event, ctx);
				if (result) return result;
			}
			return result;
		},
	};
	fake.api = {
		on: (name: string, handler: Handler) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			return () => undefined;
		},
		registerTool: (tool: any) => {
			tools.set(tool.name, tool);
			if (tool.defaultActive !== false) fake.active.push(tool.name);
		},
		registerCommand: () => undefined,
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		getActiveTools: () => [...fake.active],
		setActiveTools: (names: string[]) => {
			fake.active = names;
		},
		exec: async (command: string, args: string[]) => {
			execCalls.push({ command, args });
			if (!exec) return { stdout: "", stderr: "no exec", code: 1, killed: false };
			return { killed: false, ...(await exec(command, args)) };
		},
	};
	return fake;
}
