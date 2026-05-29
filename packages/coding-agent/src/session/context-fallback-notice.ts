/**
 * Why the session fell back to a larger-context model:
 * - `overflow`  — the input context exceeded the model's window.
 * - `length`    — the model stopped at its output-length limit.
 * - `threshold` — the context crossed the proactive-compaction threshold.
 */
export type ContextFallbackTrigger = "overflow" | "length" | "threshold";

/**
 * Format the user-facing notice emitted when the session falls back to a
 * larger-context model. `from` / `to` are `provider/id` model identifiers; the
 * lead-in is tailored to `trigger` so a threshold/length switch is not labeled
 * as an overflow.
 */
export function formatContextFallbackNotice(from: string, to: string, trigger: ContextFallbackTrigger): string {
	const lead =
		trigger === "overflow"
			? `Context limit reached on ${from}`
			: trigger === "length"
				? `${from} stopped at its output-length limit`
				: `${from} is nearing its context limit`;
	return `${lead}; switched to ${to} for a larger context window.`;
}
