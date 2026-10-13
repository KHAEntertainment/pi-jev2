/**
 * The real pi binary, in RPC mode, with pi-jev in escalate mode and a parent
 * process answering over the extension UI subprotocol. Slow-ish (a pi
 * process per case), so each case gets a generous timeout.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");

function run(decision: "approve" | "deny" | "silent") {
	const result = spawnSync("bun", [join(repo, "test/e2e/rpc-parent.ts"), decision], { encoding: "utf8", timeout: 40_000 });
	try {
		return JSON.parse(result.stdout);
	} catch {
		throw new Error(`harness output was not JSON:\n${result.stdout}\n${result.stderr}`);
	}
}

describe("pi --mode rpc escalation", () => {
	test("parent deny blocks the call with the parent's reason", () => {
		const report = run("deny");
		expect(report.end).toBe("agent_end");
		expect(report.escalations).toBe(1);
		expect(report.request.tool).toBe("bash");
		expect(report.toolResult.text).toContain("denied by e2e-parent: parent says deny");
	}, 45_000);

	test("parent approve lets the call run", () => {
		const report = run("approve");
		expect(report.end).toBe("agent_end");
		expect(report.toolResult.text).not.toContain("pi-jev:");
		expect(report.toolResult.text).toContain("not a git repository");
	}, 45_000);

	test("silent parent falls back to the local confirm", () => {
		const report = run("silent");
		expect(report.end).toBe("agent_end");
		expect(report.fallbackConfirm).toBe("Jev flagged this tool call");
		expect(report.toolResult.text).toContain("(declined)");
	}, 45_000);
});
