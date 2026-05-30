import { describe, expect, it } from "bun:test";
import type { ApprovalSubject } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { evaluatePermission, type PermissionAction } from "@oh-my-pi/pi-coding-agent/tools/permission/evaluate";
import type { GuardianJudge, GuardianVerdict } from "@oh-my-pi/pi-coding-agent/tools/permission/guardian";

const ROOT = "/home/user/project";

const bashTool: ApprovalSubject = { name: "bash", approval: "exec", formatApprovalDetails: () => [] };
const readTool: ApprovalSubject = { name: "read", approval: "read", formatApprovalDetails: () => [] };
const lspTool: ApprovalSubject = { name: "lsp", approval: () => ({ tier: "write" }), formatApprovalDetails: () => [] };
const writeTool: ApprovalSubject = { name: "write", approval: "write", formatApprovalDetails: () => [] };
// An exec-tier tool the heuristic does NOT special-case (like `ssh`/`task`); it must
// not slip through on allow-by-default in the non-tier modes.
const sshTool: ApprovalSubject = { name: "ssh", approval: "exec", formatApprovalDetails: () => [] };

function fakeGuardian(verdict: GuardianVerdict) {
	const guardian = {
		calls: 0,
		evaluate: async (): Promise<GuardianVerdict> => {
			guardian.calls++;
			return verdict;
		},
	};
	return guardian as unknown as GuardianJudge & { calls: number };
}

function run(over: Partial<Parameters<typeof evaluatePermission>[0]>): Promise<PermissionAction> {
	return evaluatePermission({
		tool: bashTool,
		args: { command: "ls" },
		mode: "yolo",
		userPolicies: {},
		workspaceRoot: ROOT,
		hasUI: true,
		...over,
	});
}

describe("evaluatePermission — tier modes", () => {
	it("yolo allows", async () => {
		expect(await run({ mode: "yolo" })).toEqual({ action: "allow" });
	});
	it("always-ask allows read, prompts exec", async () => {
		expect(await run({ mode: "always-ask", tool: readTool, args: {} })).toEqual({ action: "allow" });
		expect((await run({ mode: "always-ask" })).action).toBe("prompt");
	});
});

describe("evaluatePermission — user policy precedence", () => {
	for (const mode of ["heuristic", "guardian", "hybrid"] as const) {
		it(`explicit deny blocks in ${mode}`, async () => {
			const action = await run({ mode, userPolicies: { bash: "deny" }, args: { command: "ls" } });
			expect(action.action).toBe("deny");
		});
		it(`explicit allow bypasses checks in ${mode}`, async () => {
			const guardian = fakeGuardian({ decision: "deny", reason: "no" });
			const action = await run({
				mode,
				userPolicies: { bash: "allow" },
				args: { command: "rm -rf /" },
				guardian,
			});
			expect(action).toEqual({ action: "allow" });
			expect(guardian.calls).toBe(0);
		});
		it(`explicit prompt asks instead of auto-allowing in ${mode}`, async () => {
			const guardian = fakeGuardian({ decision: "allow" });
			const action = await run({ mode, userPolicies: { bash: "prompt" }, args: { command: "ls" }, guardian });
			expect(action.action).toBe("prompt");
			expect(guardian.calls).toBe(0);
		});
	}

	it("user allow is authoritative even for an uncertain construct in hybrid", async () => {
		const guardian = fakeGuardian({ decision: "deny", reason: "judge would deny" });
		const action = await run({
			mode: "hybrid",
			userPolicies: { bash: "allow" },
			args: { command: "true && cd /etc && rm x" },
			guardian,
		});
		expect(action).toEqual({ action: "allow" });
		expect(guardian.calls).toBe(0);
	});
});

describe("evaluatePermission — heuristic", () => {
	it("denies proven-destructive bash", async () => {
		expect((await run({ mode: "heuristic", args: { command: "rm -rf /" } })).action).toBe("deny");
	});
	it("allows benign bash", async () => {
		expect(await run({ mode: "heuristic", args: { command: "ls" } })).toEqual({ action: "allow" });
	});
	it("denies an uncertain construct (no judge available)", async () => {
		// BYPASS#3: control-flow command cannot be proven safe.
		expect((await run({ mode: "heuristic", args: { command: "if true; then cd /etc && touch x; fi" } })).action).toBe(
			"deny",
		);
	});
	it("BYPASS#1: denies a newline-reachable cd", async () => {
		expect((await run({ mode: "heuristic", args: { command: "pwd\ncd /etc && ls" } })).action).toBe("deny");
	});
	it("BYPASS#4: denies an empty write path", async () => {
		expect((await run({ mode: "heuristic", tool: writeTool, args: { path: "", content: "x" } })).action).toBe("deny");
	});
});

describe("evaluatePermission — guardian", () => {
	it("asks the judge for exec tools and honors allow", async () => {
		const guardian = fakeGuardian({ decision: "allow" });
		expect(await run({ mode: "guardian", guardian })).toEqual({ action: "allow" });
		expect(guardian.calls).toBe(1);
	});
	it("honors deny from the judge", async () => {
		const guardian = fakeGuardian({ decision: "deny", reason: "dangerous" });
		expect(await run({ mode: "guardian", guardian })).toEqual({ action: "deny", reason: "dangerous" });
	});
	it("auto-allows non-exec tiers without calling the judge", async () => {
		const guardian = fakeGuardian({ decision: "deny", reason: "x" });
		expect(await run({ mode: "guardian", tool: readTool, args: {}, guardian })).toEqual({ action: "allow" });
		expect(guardian.calls).toBe(0);
	});
});

describe("evaluatePermission — hybrid", () => {
	it("allows when the heuristic proves safe, without calling the judge", async () => {
		const guardian = fakeGuardian({ decision: "deny", reason: "x" });
		expect(await run({ mode: "hybrid", args: { command: "ls" }, guardian })).toEqual({ action: "allow" });
		expect(guardian.calls).toBe(0);
	});

	it("deny is terminal — a proven-destructive command is NOT escalated", async () => {
		const guardian = fakeGuardian({ decision: "allow" });
		const action = await run({ mode: "hybrid", args: { command: "rm -rf /" }, guardian });
		expect(action.action).toBe("deny");
		expect(guardian.calls).toBe(0);
	});

	it("escalates an uncertain construct; judge can overturn", async () => {
		const guardian = fakeGuardian({ decision: "allow" });
		expect(await run({ mode: "hybrid", args: { command: "true && cd /etc && touch x" }, guardian })).toEqual({
			action: "allow",
		});
		expect(guardian.calls).toBe(1);
	});

	it("escalates an uncertain construct; judge can confirm", async () => {
		const guardian = fakeGuardian({ decision: "deny", reason: "confirmed" });
		expect(await run({ mode: "hybrid", args: { command: "true && cd /etc && touch x" }, guardian })).toEqual({
			action: "deny",
			reason: "confirmed",
		});
	});

	it("BYPASS#1: escalates a newline-reachable cd to the judge", async () => {
		const guardian = fakeGuardian({ decision: "deny", reason: "judge denies" });
		const action = await run({ mode: "hybrid", args: { command: "pwd\ncd /etc && ls" }, guardian });
		expect(guardian.calls).toBe(1);
		expect(action).toEqual({ action: "deny", reason: "judge denies" });
	});

	it("BYPASS#3: escalates an lsp request executeCommand to the judge", async () => {
		const guardian = fakeGuardian({ decision: "allow" });
		const action = await run({
			mode: "hybrid",
			tool: lspTool,
			args: { action: "request", query: "workspace/executeCommand", payload: {} },
			guardian,
		});
		expect(guardian.calls).toBe(1);
		expect(action).toEqual({ action: "allow" });
	});

	it("BYPASS#4: escalates an empty write path to the judge", async () => {
		const guardian = fakeGuardian({ decision: "deny", reason: "no path" });
		const action = await run({ mode: "hybrid", tool: writeTool, args: { path: "", content: "x" }, guardian });
		expect(guardian.calls).toBe(1);
		expect(action).toEqual({ action: "deny", reason: "no path" });
	});
});

describe("evaluatePermission — other write-tier tools", () => {
	const renameArgs = { action: "rename_file", file: "a.ts", new_name: "../moved.ts" };
	it("heuristic denies an lsp rename that escapes the workspace", async () => {
		expect((await run({ tool: lspTool, args: renameArgs, mode: "heuristic" })).action).toBe("deny");
	});
	it("hybrid hard-denies the escaping lsp rename (proven escape is terminal)", async () => {
		const guardian = fakeGuardian({ decision: "allow" });
		const action = await run({ tool: lspTool, args: renameArgs, mode: "hybrid", guardian });
		expect(action.action).toBe("deny");
		expect(guardian.calls).toBe(0);
	});
	it("hybrid escalates an unhandled exec-tier tool to the judge", async () => {
		const guardian = fakeGuardian({ decision: "allow" });
		const action = await run({ tool: sshTool, args: { command: "echo hi" }, mode: "hybrid", guardian });
		expect(guardian.calls).toBe(1);
		expect(action).toEqual({ action: "allow" });
	});
});

describe("evaluatePermission — guardian fail-safe", () => {
	it("prompts on guardian error when a UI exists", async () => {
		const guardian = fakeGuardian({ decision: "error" });
		expect((await run({ mode: "guardian", guardian, hasUI: true })).action).toBe("prompt");
	});
	it("denies on guardian error when headless", async () => {
		const guardian = fakeGuardian({ decision: "error" });
		expect((await run({ mode: "guardian", guardian, hasUI: false })).action).toBe("deny");
	});
	it("fails safe when no guardian is wired", async () => {
		expect((await run({ mode: "guardian", guardian: undefined, hasUI: false })).action).toBe("deny");
		expect((await run({ mode: "guardian", guardian: undefined, hasUI: true })).action).toBe("prompt");
	});
});
