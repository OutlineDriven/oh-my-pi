/**
 * Extract the target file path from `edit`-tool arguments across all edit
 * modes (hashline `¶PATH#…` header, apply-patch `*** Update File:` header, or a
 * plain `path` field). Returns `"(unknown)"` when no path can be determined.
 *
 * This is a pure, dependency-free helper shared by the edit tool's own approval
 * logic and the permission heuristic, so neither has to reimplement the
 * mode-specific extraction (which would risk drift).
 */
export function extractApprovalPath(args: unknown): string {
	const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	const input = typeof record.input === "string" ? record.input : undefined;
	if (input) {
		const hashlineMatch = /^(?:¶|§|@)([^\s#]+)/m.exec(input);
		if (hashlineMatch?.[1]) return hashlineMatch[1];

		const applyPatchMatch = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/m.exec(input);
		if (applyPatchMatch?.[1]) return applyPatchMatch[1].trim();
	}

	const targetPath = record.path;
	return typeof targetPath === "string" && targetPath.length > 0 ? targetPath : "(unknown)";
}
