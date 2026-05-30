import { extractAllApprovalPaths } from "../../edit/approval-path";
import type { ToolTier } from "../approval";
import { extractLeadingCd } from "../bash-cwd";
import { matchCriticalBashPattern } from "../critical-bash-patterns";
import { isInternalUrlPath } from "../path-utils";
import { classifyRiskyPath, isPathInside, realpathOrSelf, resolveTargetPath } from "./risky-paths";
import { analyzeBashCommand, containsDangerousCode } from "./safety-net/index";

/**
 * Heuristic verdict — a THREE-state decision, deliberately not a boolean.
 *
 * The previous binary `block | null` overloaded `null` to mean BOTH "proven
 * workspace-safe" AND "found nothing wrong" — and every shell/tool construct
 * that relocated the effective target (mid-command `cd`, subshell, `lsp request`,
 * the next exec tool) slipped through the second meaning, generating an
 * open-ended stream of bypasses. The fix is prove-or-block: `allow` requires
 * POSITIVE proof of a recognized-safe shape; anything that cannot be proven safe
 * is `uncertain` and fails safe at the orchestrator (heuristic → deny, hybrid →
 * escalate to the Guardian judge). `deny` is reserved for proven-dangerous /
 * proven-out-of-workspace calls.
 */
export type HeuristicDecision = "allow" | "deny" | "uncertain";

export interface HeuristicVerdict {
	decision: HeuristicDecision;
	reason?: string;
}

const ALLOW: HeuristicVerdict = { decision: "allow" };
const deny = (reason: string): HeuristicVerdict => ({ decision: "deny", reason });
const uncertain = (reason: string): HeuristicVerdict => ({ decision: "uncertain", reason });

/** Context required to evaluate path-based heuristics. */
export interface HeuristicContext {
	workspaceRoot: string;
	/** Resolved tool tier; lets the classifier fail safe on unknown write-tier tools. */
	tier?: ToolTier;
}

/**
 * LSP `request` forwards a caller-chosen JSON-RPC method + payload straight to
 * the language server, so it is only provably safe for a frozen set of read-only
 * methods. Everything else (notably `workspace/executeCommand` /
 * `workspace/applyEdit` and any unknown/custom method) is `uncertain`. Adding a
 * method here is a reviewed one-line change — the DEFAULT is fail-safe.
 */
const SAFE_LSP_REQUEST_METHODS: ReadonlySet<string> = new Set([
	"textDocument/hover",
	"textDocument/definition",
	"textDocument/typeDefinition",
	"textDocument/declaration",
	"textDocument/implementation",
	"textDocument/references",
	"textDocument/documentSymbol",
	"textDocument/documentHighlight",
	"textDocument/completion",
	"textDocument/signatureHelp",
	"textDocument/foldingRange",
	"textDocument/selectionRange",
	"textDocument/semanticTokens/full",
	"textDocument/inlayHint",
	"workspace/symbol",
]);

/** Commands that change the working directory the rest of the line runs in. */
const RELOCATORS: ReadonlySet<string> = new Set(["cd", "pushd", "popd", "chdir", "chroot"]);

/** Compound / control-flow keywords whose cwd cannot be tracked by flat segmentation. */
const CONTROL_FLOW = /(?:^|[;&|\n\r({]\s*)(?:if|then|elif|else|fi|for|while|until|do|done|case|esac|select|function)\b/;

/** A `-C` / `--directory` style chdir flag on any tool (git, make, tar, env, rsync, …). */
const CHDIR_FLAG = /(?:^|\s)(?:-C|--directory|--chdir|--working-directory)(?:[=\s]|$)/;

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** A path argument as a string list (a bare string or an array of strings). */
function stringValues(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
	return [];
}

/**
 * Risky-path reason for a single target, or `null` when it is an in-workspace /
 * internal-URL / unknown path that carries no escape risk. Mirrors the skip rules
 * the edit tool's own approval uses.
 */
function riskyPathReason(targetPath: string, ctx: HeuristicContext): string | null {
	if (!targetPath || targetPath === "(unknown)" || isInternalUrlPath(targetPath)) return null;
	return classifyRiskyPath(targetPath, ctx.workspaceRoot)?.reason ?? null;
}

/**
 * Verdict for a set of caller-supplied write paths. An EMPTY list is `uncertain`
 * ("no path to check" ≠ "proven safe"), NOT `allow` — closing the overloaded-null
 * leak. A risky path → `deny`; all in-workspace → `allow`.
 */
function classifyPathsOrUncertain(paths: string[], ctx: HeuristicContext, label: string): HeuristicVerdict {
	if (paths.length === 0) return uncertain(`${label} has no checkable in-workspace path`);
	for (const p of paths) {
		const reason = riskyPathReason(p, ctx);
		if (reason) return deny(reason);
	}
	return ALLOW;
}

/** True when a `cd` argument is a workspace-relative or absolute literal we can resolve statically. */
function isLiteralPath(target: string): boolean {
	if (!target) return false;
	if (target.includes("$") || target.includes("`")) return false; // variable / command substitution
	if (target.includes("~")) return false; // home expansion — not provably in-workspace
	return !/[*?[]/.test(target); // globs are not a single literal target
}

/**
 * Prove-or-block predicate for the bash tool. Returns `allow` ONLY for a flat,
 * statically-analyzable command that provably stays in the workspace and carries
 * no dangerous effect; `deny` for proven-dangerous / proven-escape; `uncertain`
 * for every construct that defeats static cwd-tracking (subshell, substitution,
 * control flow, shell re-entry, here-doc, background, non-leading / dynamic `cd`,
 * tool chdir flags). First firing rule wins.
 */
function proveBashSafe(rawCommand: string, rawCwdArg: string | undefined, ctx: HeuristicContext): HeuristicVerdict {
	if (rawCommand.trim() === "") return ALLOW;
	const root = ctx.workspaceRoot;
	const realRoot = realpathOrSelf(root);

	// STEP 1: explicit cwd arg. Provable escape → deny. When present it pins the
	// effective cwd and SUPPRESSES leading-cd proving (matching BashTool's `if (!cwd)`).
	let effectiveCwd = root;
	const hasExplicitCwd = typeof rawCwdArg === "string" && rawCwdArg.length > 0;
	if (hasExplicitCwd) {
		const resolved = realpathOrSelf(resolveTargetPath(rawCwdArg as string, root));
		if (!isPathInside(resolved, realRoot)) {
			return deny(`Refusing to run bash outside the workspace root: ${resolved}`);
		}
		effectiveCwd = resolved;
	}

	// STEP 2: constructs that defeat static segmentation / cwd-tracking → uncertain.
	if (/\$\(|`/.test(rawCommand))
		return uncertain("Cannot prove bash command stays in workspace: command substitution");
	if (/[<>]\(/.test(rawCommand))
		return uncertain("Cannot prove bash command stays in workspace: process substitution");
	if (/(?:^|[;&|\n\r]\s*)\(/.test(rawCommand))
		return uncertain("Cannot prove bash command stays in workspace: subshell");
	if (/(?:^|[;&|\n\r]\s*)\{\s/.test(rawCommand))
		return uncertain("Cannot prove bash command stays in workspace: brace group");
	if (CONTROL_FLOW.test(rawCommand))
		return uncertain("Cannot prove bash compound/control-flow command stays in workspace");
	if (/<</.test(rawCommand)) return uncertain("Cannot prove bash command stays in workspace: here-document");
	// Background `&` (not part of `&&`, and not a `>&` / `&>` / `&digit` redirection).
	if (/(?<![>&])&(?!&|>|\d)/.test(rawCommand))
		return uncertain("Cannot prove bash command stays in workspace: background job");

	// STEP 3: segment split (INCLUDING newlines) + relocation scan.
	const segments = rawCommand.split(/&&|\|\||[;|\n\r]+/);
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i]!.trim();
		if (!seg) continue;
		const tokens = seg.split(/\s+/);
		const head = tokens[0]!;
		if (RELOCATORS.has(head)) {
			const target = tokens[1] ?? "";
			const isLeadingCd = i === 0 && head === "cd" && !hasExplicitCwd;
			if (isLeadingCd && isLiteralPath(target)) {
				const resolved = realpathOrSelf(resolveTargetPath(target, root));
				if (!isPathInside(resolved, realRoot)) {
					return deny(`Refusing to run bash outside the workspace root: ${resolved}`);
				}
				effectiveCwd = resolved; // proven in-workspace relocation
				continue;
			}
			// Non-leading, dynamic, or non-cd relocator. A non-leading literal cd
			// that resolves outside is a proven escape; everything else is unprovable.
			if (head === "cd" && isLiteralPath(target)) {
				const resolved = realpathOrSelf(resolveTargetPath(target, root));
				if (!isPathInside(resolved, realRoot)) {
					return deny(`Refusing to run bash outside the workspace root: ${resolved}`);
				}
			}
			return uncertain(`Cannot prove bash '${head}' keeps execution in the workspace`);
		}
		if (CHDIR_FLAG.test(seg)) {
			return uncertain(`Cannot prove tool chdir flag in '${head}' stays in workspace`);
		}
	}

	// STEP 4: proven-dangerous EFFECT → deny. A proven leading `cd X && …` is
	// stripped (via the SAME helper BashTool uses, so the two can't drift) so the
	// analyzer sees the remaining command in its effective cwd.
	const commandForAnalysis = hasExplicitCwd ? rawCommand : extractLeadingCd(rawCommand).command;
	const result = analyzeBashCommand(commandForAnalysis, effectiveCwd);
	if (result) return deny(result.reason);
	if (matchCriticalBashPattern(rawCommand)) return deny("Critical bash pattern detected.");

	// STEP 5: proven safe.
	return ALLOW;
}

/**
 * Classify a tool call by tool name under prove-or-block semantics.
 *
 * - `bash`: `proveBashSafe` (see there) — allow only a flat in-workspace command
 *   with no dangerous effect; uncertain for anything that relocates execution.
 * - `eval`: dangerous-code in any cell → deny; otherwise allow.
 * - `write` / `edit` / `ast_edit` / `tts`: every caller-supplied path proved
 *   in-workspace → allow; a risky one → deny; NO path supplied → uncertain.
 * - `lsp`: read-tier → allow; `request` allowed only for a frozen read-only
 *   method set; write actions via the path rule.
 * - `generate_image` / `report_tool_issue`: fixed write target, no caller path → allow.
 * - any other write/exec-tier tool → uncertain (cannot introspect); read-tier → allow.
 */
export function classifyHeuristic(toolName: string, args: unknown, ctx: HeuristicContext): HeuristicVerdict {
	const record = asRecord(args);
	switch (toolName) {
		case "bash": {
			const command = typeof record.command === "string" ? record.command : "";
			const rawCwd = typeof record.cwd === "string" && record.cwd.length > 0 ? record.cwd : undefined;
			return proveBashSafe(command, rawCwd, ctx);
		}
		case "eval": {
			const cells = Array.isArray(record.cells) ? record.cells : [];
			for (const cell of cells) {
				const code = asRecord(cell).code;
				if (typeof code === "string" && containsDangerousCode(code)) {
					return deny("Detected a potentially destructive command in eval cell code.");
				}
			}
			return ALLOW;
		}
		case "write":
		case "edit":
			// `extractAllApprovalPaths` covers the plain `path` field AND every
			// apply-patch / hashline section and rename destination. An empty list
			// (e.g. `write { path: "" }`) is uncertain, not allow.
			return classifyPathsOrUncertain(extractAllApprovalPaths(args), ctx, toolName);
		case "ast_edit":
			return classifyPathsOrUncertain(stringValues(record.paths), ctx, "ast_edit");
		case "tts":
			return classifyPathsOrUncertain(stringValues(record.output_path), ctx, "tts");
		case "lsp": {
			const action = typeof record.action === "string" ? record.action : "";
			if (action === "request") {
				const method = typeof record.query === "string" ? record.query : "";
				return SAFE_LSP_REQUEST_METHODS.has(method)
					? ALLOW
					: uncertain(`lsp request method not provably safe: ${method || "(none)"}`);
			}
			if (ctx.tier !== "write") return ALLOW;
			return classifyPathsOrUncertain(
				[...stringValues(record.file), ...stringValues(record.new_name)],
				ctx,
				`lsp ${action || "write action"}`,
			);
		}
		case "generate_image":
		case "report_tool_issue":
			// Write-tier, but the write target is fixed / tool-allocated with no
			// caller-controlled path (`generate_image.input[].path` is a read source).
			return ALLOW;
		default:
			// An unrecognized write- or exec-tier tool cannot be introspected for
			// safety, so it is uncertain — heuristic mode denies, hybrid escalates to
			// the judge. This is why a future exec tool (or `task`, which spawns yolo
			// subagents) cannot silently bypass the mode. Read-tier carries no risk.
			return ctx.tier === "write" || ctx.tier === "exec"
				? uncertain(`Un-vetted ${ctx.tier}-tier tool: ${toolName}`)
				: ALLOW;
	}
}
