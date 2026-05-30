import { extractAllApprovalPaths } from "../../edit/approval-path";
import type { ToolTier } from "../approval";
import { matchCriticalBashPattern } from "../critical-bash-patterns";
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
	/** Resolved tool tier; lets the classifier fail safe on unknown write-tier tools. */
	tier?: ToolTier;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function classifyFilePath(targetPath: string, ctx: HeuristicContext): HeuristicBlock | null {
	if (!targetPath || targetPath === "(unknown)" || isInternalUrlPath(targetPath)) return null;
	return classifyRiskyPath(targetPath, ctx.workspaceRoot);
}

/** Block on the first risky path among a list (e.g. every section of a patch). */
function classifyFirstRiskyPath(paths: Iterable<string>, ctx: HeuristicContext): HeuristicBlock | null {
	for (const p of paths) {
		const block = classifyFilePath(p, ctx);
		if (block) return block;
	}
	return null;
}

/** Normalize a path argument to a string list (a bare string or an array of strings). */
function stringValues(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
	return [];
}

/**
 * Blacklist heuristic for tool calls, dispatched by tool name:
 * - `bash`: the vendored command analyzer (destructive `rm`/`git`/`find`/…), plus
 *   the bash tool's own critical-pattern override, so commands the analyzer misses
 *   but the tier engine always blocks (e.g. `sudo rm`) are caught here too rather
 *   than auto-approved by this mode.
 * - `eval`: interpreter dangerous-code detection over each cell's source.
 * - `write` / `edit`: risky-path rule on EVERY caller target — the plain `path`
 *   plus every apply-patch / hashline section and `*** Move to:` rename
 *   destination (an edit applies all sections, so a later escape must not hide
 *   behind an in-workspace first section).
 * - `lsp` / `ast_edit` / `tts`: risky-path rule on the caller-supplied write paths
 *   (`lsp` `rename_file` resolves `new_name` against cwd and can escape; likewise
 *   `ast_edit`'s `paths` and `tts`'s `output_path`).
 * - `image_gen` / `report_tool_issue`: write-tier, but the write target is fixed /
 *   allocated with no caller-controlled write path (`image_gen.input[].path` is a
 *   read source), so there is nothing to escape with — allowed.
 * - any OTHER write-tier tool: cannot be introspected for a write path, so fail
 *   safe — block (which `hybrid` escalates to the judge). Non-write tiers allowed.
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
			if (result) return { block: true, reason: result.reason };
			// Also honor the bash tool's critical-pattern override: the tier engine
			// always blocks these (override: true), so this mode must not let one
			// through just because the vendored analyzer didn't flag it.
			if (matchCriticalBashPattern(command)) {
				return { block: true, reason: "Critical bash pattern detected." };
			}
			return null;
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
		case "write":
		case "edit":
			// `extractAllApprovalPaths` covers the plain `path` field AND every
			// apply-patch / hashline section and rename destination.
			return classifyFirstRiskyPath(extractAllApprovalPaths(args), ctx);
		case "lsp":
			// Only the caller-supplied `file` / `new_name` paths can escape; other
			// write actions stay in-workspace via the language server, and read-tier
			// lsp actions are not write escapes.
			if (ctx.tier !== "write") return null;
			return classifyFirstRiskyPath([...stringValues(record.file), ...stringValues(record.new_name)], ctx);
		case "ast_edit":
			return classifyFirstRiskyPath(stringValues(record.paths), ctx);
		case "tts":
			return classifyFirstRiskyPath(stringValues(record.output_path), ctx);
		case "image_gen":
		case "report_tool_issue":
			// Write-tier, but the write target is fixed / allocated (no caller path
			// to escape with), so there is nothing to classify.
			return null;
		default:
			// An unrecognized write- or exec-tier tool can't be introspected for
			// safety, so fail safe by returning a block: `heuristic` mode (no judge)
			// turns that into a deny, while `hybrid` escalates it to the Guardian.
			// exec is included so a delegating tool like `task` — which launches yolo
			// subagents — can't slip past the mode by allow-on-default; like
			// `guardian` mode, no exec-tier call is silently allowed here.
			// `read`-tier tools carry no write/exec risk and are allowed.
			return ctx.tier === "write" || ctx.tier === "exec"
				? { block: true, reason: `Refusing un-vetted ${ctx.tier}-tier tool: ${toolName}` }
				: null;
	}
}
