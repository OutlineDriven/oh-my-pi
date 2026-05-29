/**
 * Format the user-facing notice emitted when the session falls back to a
 * larger-context model on context overflow.
 *
 * `from` / `to` are `provider/id` model identifiers.
 */
export function formatContextFallbackNotice(from: string, to: string): string {
	return `Context limit reached on ${from}; switched to ${to} for a larger context window.`;
}
