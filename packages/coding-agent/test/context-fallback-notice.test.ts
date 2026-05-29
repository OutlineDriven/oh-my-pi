import { describe, expect, it } from "bun:test";
import { formatContextFallbackNotice } from "@oh-my-pi/pi-coding-agent/session/context-fallback-notice";

describe("formatContextFallbackNotice", () => {
	it("names both models and the larger window for every trigger", () => {
		for (const trigger of ["overflow", "length", "threshold"] as const) {
			const msg = formatContextFallbackNotice("openai/gpt-5.5", "openai/gpt-5.4", trigger);
			expect(msg).toContain("openai/gpt-5.5");
			expect(msg).toContain("openai/gpt-5.4");
			expect(msg).toContain("larger context window");
		}
	});

	it("only the overflow trigger claims the context limit was reached", () => {
		const overflow = formatContextFallbackNotice("a", "b", "overflow");
		const length = formatContextFallbackNotice("a", "b", "length");
		const threshold = formatContextFallbackNotice("a", "b", "threshold");

		expect(overflow).toContain("Context limit reached");
		expect(length).not.toContain("Context limit reached");
		expect(length).toContain("output-length limit");
		expect(threshold).not.toContain("Context limit reached");
		expect(threshold).toContain("nearing its context limit");
	});
});
