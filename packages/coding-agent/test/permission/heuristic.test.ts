import { describe, expect, it } from "bun:test";
import { classifyHeuristic } from "@oh-my-pi/pi-coding-agent/tools/permission/heuristic";

const ROOT = "/home/user/project";
const CTX = { workspaceRoot: ROOT };
/** Context tagged with a resolved tool tier (for name-agnostic gating). */
const W = (tier: "read" | "write" | "exec") => ({ workspaceRoot: ROOT, tier });

const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");

describe("classifyHeuristic", () => {
	it("blocks destructive bash commands", () => {
		expect(classifyHeuristic("bash", { command: "rm -rf /" }, CTX)?.block).toBe(true);
		expect(classifyHeuristic("bash", { command: "git push --force" }, CTX)?.block).toBe(true);
	});

	it("allows benign bash commands", () => {
		expect(classifyHeuristic("bash", { command: "ls -la" }, CTX)).toBeNull();
		expect(classifyHeuristic("bash", { command: "" }, CTX)).toBeNull();
	});

	it("blocks bash whose cwd escapes the workspace", () => {
		expect(classifyHeuristic("bash", { command: "ls", cwd: "/etc" }, CTX)?.block).toBe(true);
		expect(classifyHeuristic("bash", { command: "ls", cwd: "../.." }, CTX)?.block).toBe(true);
	});

	it("analyzes bash relative to an in-workspace cwd arg", () => {
		// Safe relative to the given (in-workspace) cwd.
		expect(classifyHeuristic("bash", { command: "ls -la", cwd: "src" }, CTX)).toBeNull();
		// Destructive even when scoped to an in-workspace cwd.
		expect(classifyHeuristic("bash", { command: "rm -rf /", cwd: "src" }, CTX)?.block).toBe(true);
	});

	it("honors the bash critical-pattern override the analyzer misses", () => {
		// `sudo rm <path>` is stripped to `rm` by the analyzer (which ignores
		// non-`-rf` removals) but is a critical pattern the tier engine always
		// blocks; this mode must block it too rather than auto-approve.
		expect(classifyHeuristic("bash", { command: "sudo rm /etc/hosts" }, CTX)?.block).toBe(true);
	});

	it("blocks eval cells containing destructive code", () => {
		const args = { cells: [{ language: "py", code: 'os.system("rm -rf /tmp/x")' }] };
		expect(classifyHeuristic("eval", args, CTX)?.block).toBe(true);
	});

	it("allows ordinary eval cells", () => {
		const args = { cells: [{ language: "js", code: "const x = 1 + 2;" }] };
		expect(classifyHeuristic("eval", args, CTX)).toBeNull();
	});

	it("blocks writes outside the workspace", () => {
		expect(classifyHeuristic("write", { path: "../escape.txt" }, CTX)?.block).toBe(true);
		expect(classifyHeuristic("write", { path: "/etc/hosts" }, CTX)?.block).toBe(true);
	});

	it("allows in-workspace writes", () => {
		expect(classifyHeuristic("write", { path: "src/foo.ts" }, CTX)).toBeNull();
	});

	it("blocks risky edits via the hashline path header", () => {
		const args = { input: "¶../escape.ts#A1\n1 1\n+x" };
		expect(classifyHeuristic("edit", args, CTX)?.block).toBe(true);
	});

	it("allows in-workspace edits", () => {
		const args = { input: "¶src/foo.ts#A1\n1 1\n+x" };
		expect(classifyHeuristic("edit", args, CTX)).toBeNull();
	});

	it("allows unknown read/exec tools", () => {
		expect(classifyHeuristic("read", { path: "/etc/hosts" }, CTX)).toBeNull();
		expect(classifyHeuristic("ssh", { command: "rm -rf /" }, CTX)).toBeNull();
	});
});

describe("classifyHeuristic — multi-file edit", () => {
	it("blocks when a later patch section escapes the workspace", () => {
		const input = patch("*** Add File: safe.txt", "+ok", "*** Delete File: ../../outside.txt");
		expect(classifyHeuristic("edit", { input }, CTX)?.block).toBe(true);
	});

	it("blocks an apply-patch rename destination outside the workspace", () => {
		const input = patch("*** Update File: safe.txt", "*** Move to: ../../escape.txt", "@@");
		expect(classifyHeuristic("edit", { input }, CTX)?.block).toBe(true);
	});

	it("blocks a system-path section anywhere in the patch", () => {
		const input = patch("*** Add File: ok.txt", "+x", "*** Add File: /etc/cron.d/x");
		expect(classifyHeuristic("edit", { input }, CTX)?.block).toBe(true);
	});

	it("allows an all-in-workspace multi-file patch", () => {
		const input = patch("*** Add File: a.txt", "+a", "*** Add File: sub/b.txt", "+b");
		expect(classifyHeuristic("edit", { input }, CTX)).toBeNull();
	});
});

describe("classifyHeuristic — other write-tier tools", () => {
	it("blocks lsp rename_file escaping via new_name", () => {
		const args = { action: "rename_file", file: "a.ts", new_name: "../moved.ts" };
		expect(classifyHeuristic("lsp", args, W("write"))?.block).toBe(true);
	});

	it("allows in-workspace lsp rename_file", () => {
		const args = { action: "rename_file", file: "a.ts", new_name: "sub/b.ts" };
		expect(classifyHeuristic("lsp", args, W("write"))).toBeNull();
	});

	it("does not treat a read-tier lsp action as a write escape", () => {
		const args = { action: "hover", file: "../../outside.ts" };
		expect(classifyHeuristic("lsp", args, W("read"))).toBeNull();
	});

	it("blocks ast_edit targeting a path outside the workspace", () => {
		expect(classifyHeuristic("ast_edit", { paths: ["src/a.ts", "../../b.ts"] }, W("write"))?.block).toBe(true);
	});

	it("blocks tts writing its output outside the workspace", () => {
		expect(classifyHeuristic("tts", { output_path: "../../out.mp3" }, W("write"))?.block).toBe(true);
	});

	it("allows image_gen (no caller-controlled write path)", () => {
		expect(classifyHeuristic("image_gen", { input: [{ path: "/tmp/ref.png" }] }, W("write"))).toBeNull();
	});

	it("fails safe on an unrecognized write-tier tool", () => {
		expect(classifyHeuristic("mystery_writer", { foo: 1 }, W("write"))?.block).toBe(true);
	});

	it("allows an unrecognized non-write tool", () => {
		expect(classifyHeuristic("mystery_reader", { whatever: "../../x" }, W("read"))).toBeNull();
	});
});
