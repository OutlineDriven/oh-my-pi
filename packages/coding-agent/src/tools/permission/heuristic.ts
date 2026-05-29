import { extractApprovalPath } from "../../edit/approval-path";
import { isInternalUrlPath } from "../path-utils";
import { classifyRiskyPath, isPathInside, resolveTargetPath } from "./risky-paths";
import { analyzeBashCommand, containsDangerousCode } from "./safety-net/index";

/** A heuristic block decision with a human-readable reason. */
export interface HeuristicBlock {
	block: true;
	reason: string;
}

/** Context required to evaluate path-based heuristics. */
export interface HeuristicContext {
	workspaceRoot: string;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function classifyFilePath(targetPath: string, ctx: HeuristicContext): HeuristicBlock | null {
	if (!targetPath || targetPath === "(unknown)" || isInternalUrlPath(targetPath)) return null;
	return classifyRiskyPath(targetPath, ctx.workspaceRoot);
}

/**
 * Blacklist heuristic for tool calls, dispatched by tool tier:
 * - `bash`: the vendored command analyzer (destructive `rm`/`git`/`find`/…).
 * - `eval`: interpreter dangerous-code detection over each cell's source.
 * - `write` / `edit`: risky-path rules (outside workspace or sensitive paths).
 * - everything else: allowed (returns `null`).
 *
 * Returns a block decision or `null` when the call is considered safe.
 */
export function classifyHeuristic(toolName: string, args: unknown, ctx: HeuristicContext): HeuristicBlock | null {
	const record = asRecord(args);
	switch (toolName) {
		case "bash": {
			const command = typeof record.command === "string" ? record.command : "";
			if (!command) return null;
			// The bash tool resolves the command relative to an optional `cwd` arg, so
			// analysis MUST use that same cwd — otherwise `{ cwd: "/etc", command:
			// "rm -rf ./nginx" }` looks workspace-local but runs in /etc.
			const rawCwd = typeof record.cwd === "string" && record.cwd.length > 0 ? record.cwd : undefined;
			const effectiveCwd = rawCwd ? resolveTargetPath(rawCwd, ctx.workspaceRoot) : ctx.workspaceRoot;
			if (rawCwd && !isPathInside(effectiveCwd, ctx.workspaceRoot)) {
				return { block: true, reason: `Refusing to run bash outside the workspace root: ${effectiveCwd}` };
			}
			const result = analyzeBashCommand(command, effectiveCwd);
			return result ? { block: true, reason: result.reason } : null;
		}
		case "eval": {
			const cells = Array.isArray(record.cells) ? record.cells : [];
			for (const cell of cells) {
				const code = asRecord(cell).code;
				if (typeof code === "string" && containsDangerousCode(code)) {
					return {
						block: true,
						reason: "Detected a potentially destructive command in eval cell code.",
					};
				}
			}
			return null;
		}
		case "write": {
			const targetPath = typeof record.path === "string" ? record.path : "";
			return classifyFilePath(targetPath, ctx);
		}
		case "edit":
			return classifyFilePath(extractApprovalPath(args), ctx);
		default:
			return null;
	}
}
