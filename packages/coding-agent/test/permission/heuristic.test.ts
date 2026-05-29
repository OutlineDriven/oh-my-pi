import { describe, expect, it } from "bun:test";
import { classifyHeuristic } from "@oh-my-pi/pi-coding-agent/tools/permission/heuristic";

const CTX = { workspaceRoot: "/home/user/project" };

describe("classifyHeuristic", () => {
	it("blocks destructive bash commands", () => {
		expect(classifyHeuristic("bash", { command: "rm -rf /" }, CTX)?.block).toBe(true);
		expect(classifyHeuristic("bash", { command: "git push --force" }, CTX)?.block).toBe(true);
	});

	it("allows benign bash commands", () => {
		expect(classifyHeuristic("bash", { command: "ls -la" }, CTX)).toBeNull();
		expect(classifyHeuristic("bash", { command: "" }, CTX)).toBeNull();
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

	it("allows unknown tools", () => {
		expect(classifyHeuristic("read", { path: "/etc/hosts" }, CTX)).toBeNull();
		expect(classifyHeuristic("ssh", { command: "rm -rf /" }, CTX)).toBeNull();
	});
});
