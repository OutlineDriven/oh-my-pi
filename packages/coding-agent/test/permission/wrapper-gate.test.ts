import { describe, expect, it } from "bun:test";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";

let executed = 0;

const bashTool = {
	name: "bash",
	description: "run a command",
	label: "Bash",
	strict: false,
	parameters: { type: "object", properties: {} },
	approval: "exec",
	formatApprovalDetails: () => [],
	execute: async () => {
		executed++;
		return { content: [{ type: "text", text: "ok" }] };
	},
} as unknown as AgentTool;

const fakeRunner = {
	hasUI: () => false,
	hasHandlers: () => false,
	getUIContext: () => ({ select: async () => "Deny" }),
} as unknown as ExtensionRunner;

function contextWithMode(mode: string): AgentToolContext {
	return {
		settings: {
			get: (key: string) => {
				if (key === "tools.approvalMode") return mode;
				if (key === "tools.approval") return {};
				return undefined;
			},
		},
		autoApprove: false,
		cwd: "/home/user/project",
		guardian: undefined,
	} as unknown as AgentToolContext;
}

describe("ExtensionToolWrapper gate (heuristic mode, end-to-end)", () => {
	it("blocks a destructive bash command through the real analyzer", async () => {
		executed = 0;
		const wrapper = new ExtensionToolWrapper(bashTool, fakeRunner);
		await expect(
			wrapper.execute("call-1", { command: "rm -rf /" }, undefined, undefined, contextWithMode("heuristic")),
		).rejects.toThrow(/denied/i);
		expect(executed).toBe(0);
	});

	it("allows a benign bash command to execute", async () => {
		executed = 0;
		const wrapper = new ExtensionToolWrapper(bashTool, fakeRunner);
		const result = await wrapper.execute(
			"call-2",
			{ command: "ls -la" },
			undefined,
			undefined,
			contextWithMode("heuristic"),
		);
		expect(executed).toBe(1);
		expect(result.content).toBeDefined();
	});
});
