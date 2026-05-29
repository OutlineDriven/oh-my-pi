import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { GuardianJudge } from "@oh-my-pi/pi-coding-agent/tools/permission/guardian";

const FAKE_MODEL = { provider: "fake", id: "fake", reasoning: false, contextWindow: 100_000 };

function fakeRegistry(): ModelRegistry {
	return {
		getAvailable: () => [FAKE_MODEL],
		find: (provider: string, id: string) => (provider === "fake" && id === "fake" ? FAKE_MODEL : undefined),
		getApiKey: async () => "test-key",
	} as unknown as ModelRegistry;
}

function fakeSettings(): Settings {
	return {
		get: (key: string) => {
			if (key === "tools.guardian.model") return "fake/fake";
			if (key === "tools.guardian.maxRetries") return 3;
			return undefined;
		},
	} as unknown as Settings;
}

function verdictResponse(decision: "allow" | "deny", reason?: string) {
	return {
		role: "assistant",
		stopReason: "tool_use",
		content: [{ type: "toolCall", name: "verdict", arguments: { decision, reason } }],
	} as unknown as ai.AssistantMessage;
}

function judge(options?: { maxAttempts?: number }) {
	return new GuardianJudge(fakeRegistry(), fakeSettings(), () => FAKE_MODEL as unknown as ai.Model<ai.Api>, "s1", {
		baseBackoffMs: 0,
		...options,
	});
}

describe("GuardianJudge", () => {
	afterEach(() => {
		spyOn(ai, "completeSimple").mockRestore();
	});

	it("returns allow when the judge approves", async () => {
		spyOn(ai, "completeSimple").mockResolvedValue(verdictResponse("allow"));
		const verdict = await judge().evaluate({ toolName: "bash", args: { command: "ls" } });
		expect(verdict).toEqual({ decision: "allow" });
	});

	it("returns deny with the judge's reason", async () => {
		spyOn(ai, "completeSimple").mockResolvedValue(verdictResponse("deny", "destroys the repo"));
		const verdict = await judge().evaluate({ toolName: "bash", args: { command: "rm -rf /" } });
		expect(verdict).toEqual({ decision: "deny", reason: "destroys the repo" });
	});

	it("retries on failure then fails with error after exhausting attempts", async () => {
		const spy = spyOn(ai, "completeSimple").mockRejectedValue(new Error("network down"));
		const verdict = await judge({ maxAttempts: 3 }).evaluate({ toolName: "bash", args: {} });
		expect(verdict).toEqual({ decision: "error" });
		expect(spy.mock.calls.length).toBe(3);
	});

	it("stops immediately when the signal is already aborted", async () => {
		const spy = spyOn(ai, "completeSimple").mockResolvedValue(verdictResponse("allow"));
		const verdict = await judge().evaluate({ toolName: "bash", args: {} }, AbortSignal.abort());
		expect(verdict).toEqual({ decision: "error" });
		expect(spy.mock.calls.length).toBe(0);
	});
});
