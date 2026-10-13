/**
 * A minimal Pi "parent": spawns `pi --mode rpc` with pi-jev in escalate mode,
 * sends one prompt, answers the child's pi-jev escalation with a scripted
 * decision, and reports what happened to the gated tool call.
 *
 *   bun test/e2e/rpc-parent.ts deny|approve|silent
 *
 * This doubles as the reference for how a real parent extension drives the
 * child side of the pi-rpc transport (see relayChildEscalation).
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { readChildEscalation } from "../../src/escalators/pi-rpc";

const decision = process.argv[2] ?? "deny";
const repo = resolve(import.meta.dir, "../..");
const root = mkdtempSync(join(tmpdir(), "pi-jev-e2e-"));
const agentDir = join(root, "agent");
const project = join(root, "project");
mkdirSync(agentDir, { recursive: true });
mkdirSync(join(project, "src"), { recursive: true });
writeFileSync(join(project, "src", "keep.txt"), "do not delete\n");
writeFileSync(
	join(agentDir, "pi-jev.json"),
	JSON.stringify({ model: "fakejev/jev-fake", gate: { mode: "escalate" }, escalation: { timeoutSeconds: 5 } }),
);

const child = spawn(
	join(repo, "node_modules/.bin/pi"),
	[
		"--mode", "rpc",
		"--no-session",
		"-e", join(repo, "test/e2e/faux-host.ts"),
		"-e", join(repo, "src/index.ts"),
		"--model", "faux/scripted",
	],
	{ cwd: project, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: ["pipe", "pipe", "pipe"] },
);

const report: Record<string, unknown> = { decision, escalations: 0, notifications: [] as string[] };
let stderr = "";
child.stderr.on("data", (chunk) => (stderr += chunk));
const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
const timer = setTimeout(() => finish("timeout"), 20_000);

function finish(reason: string) {
	clearTimeout(timer);
	report.end = reason;
	if (reason !== "agent_end") report.stderr = stderr.slice(-2000);
	console.log(JSON.stringify(report, null, 2));
	child.kill();
	rmSync(root, { recursive: true, force: true });
	process.exit(reason === "agent_end" ? 0 : 1);
}

let prompted = false;
createInterface({ input: child.stdout }).on("line", (line) => {
	let event: any;
	try {
		event = JSON.parse(line);
	} catch {
		return;
	}
	if (event.type === "extension_ui_request") {
		if (event.method === "notify") (report.notifications as string[]).push(event.message);
		const escalation = readChildEscalation(event);
		if (escalation) {
			report.escalations = (report.escalations as number) + 1;
			report.request = { tool: escalation.tool, summary: escalation.verdict?.summary, arguments: escalation.arguments };
			if (decision === "silent") send({ type: "extension_ui_response", id: event.id, cancelled: true });
			else send({ type: "extension_ui_response", id: event.id, value: JSON.stringify({ decision, reason: `parent says ${decision}`, by: "e2e-parent" }) });
		} else if (event.method === "confirm") {
			// The enforce fallback: this parent declines.
			report.fallbackConfirm = event.title;
			send({ type: "extension_ui_response", id: event.id, confirmed: false });
		}
	}
	if (event.type === "tool_execution_end") {
		report.toolResult = { isError: event.isError, text: JSON.stringify(event.result).slice(0, 300) };
	}
	if (!prompted && (event.type === "extension_ui_request" && event.method === "setStatus")) {
		prompted = true;
		send({ id: "p1", type: "prompt", message: "clean up the repo" });
	}
	if (event.type === "agent_end") finish("agent_end");
});

// Fallback in case no status line arrives (e.g. pi-jev inactive).
setTimeout(() => {
	if (!prompted) {
		prompted = true;
		send({ id: "p1", type: "prompt", message: "clean up the repo" });
	}
}, 3000);
