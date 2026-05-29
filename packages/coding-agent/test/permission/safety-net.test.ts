import { describe, expect, it } from "bun:test";
import { analyzeBashCommand, containsDangerousCode } from "@oh-my-pi/pi-coding-agent/tools/permission/safety-net/index";

const CWD = "/home/user/project";

describe("analyzeBashCommand (vendored cc-safety-net)", () => {
	it.each([
		"rm -rf /",
		"rm -rf ~",
		"git push --force origin main",
		"git push -f",
		"git reset --hard HEAD~5",
		"git clean -fd",
		"git reset --hard HEAD~5 && rm -rf .git",
	])("blocks destructive command: %s", cmd => {
		const result = analyzeBashCommand(cmd, CWD);
		expect(result).not.toBeNull();
		expect(result?.reason.length).toBeGreaterThan(0);
		expect(typeof result?.segment).toBe("string");
	});

	it.each([
		"ls -la",
		"git status",
		"echo hi",
		"rm ./build/tmp.txt",
		"cat package.json",
	])("allows benign command: %s", cmd => {
		expect(analyzeBashCommand(cmd, CWD)).toBeNull();
	});
});

describe("containsDangerousCode (interpreter one-liners)", () => {
	it("flags inline destructive shell calls", () => {
		expect(containsDangerousCode('os.system("rm -rf /")')).toBe(true);
		expect(containsDangerousCode("git reset --hard")).toBe(true);
	});
	it("allows ordinary code", () => {
		expect(containsDangerousCode('print("hello")')).toBe(false);
		expect(containsDangerousCode("x = 1 + 2")).toBe(false);
	});
});
