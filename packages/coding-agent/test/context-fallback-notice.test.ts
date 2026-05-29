import { describe, expect, it } from "bun:test";
import { formatContextFallbackNotice } from "@oh-my-pi/pi-coding-agent/session/context-fallback-notice";

describe("formatContextFallbackNotice", () => {
	it("names both models and explains the switch", () => {
		const msg = formatContextFallbackNotice("openai/gpt-5.5", "openai/gpt-5.4");
		expect(msg).toContain("openai/gpt-5.5");
		expect(msg).toContain("openai/gpt-5.4");
		expect(msg.toLowerCase()).toContain("context");
	});
});
