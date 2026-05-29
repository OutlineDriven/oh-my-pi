/**
 * Permission orchestrator. Maps a tool call + approval mode to a concrete
 * action (`allow` / `deny` / `prompt`), layering the heuristic blacklist and
 * the Guardian LLM judge on top of the existing tier-based approval engine.
 */
import type { ToolTier } from "@oh-my-pi/pi-agent-core";
import {
	type ApprovalSubject,
	getToolDecision,
	isTierMode,
	normalizePolicy,
	type PermissionMode,
	resolveApproval,
} from "../approval";
import type { GuardianJudge } from "./guardian";
import { classifyHeuristic } from "./heuristic";

export type PermissionAction =
	| { action: "allow" }
	| { action: "deny"; reason: string }
	| { action: "prompt"; reason?: string };

const EXEC_TIER: ToolTier = "exec";

export interface EvaluatePermissionInput {
	tool: ApprovalSubject;
	args: unknown;
	mode: PermissionMode;
	/** User per-tool policies (`tools.approval`), authoritative in every mode. */
	userPolicies: Record<string, unknown>;
	workspaceRoot: string;
	/** Whether an interactive UI exists to prompt the user. */
	hasUI: boolean;
	guardian?: GuardianJudge;
	signal?: AbortSignal;
}

function failSafe(hasUI: boolean, reason?: string): PermissionAction {
	if (hasUI) return reason ? { action: "prompt", reason } : { action: "prompt" };
	return {
		action: "deny",
		reason: reason ? `Guardian unavailable: ${reason}` : "Guardian unavailable; denying to fail safe.",
	};
}

/**
 * Resolve the permission action for a tool call.
 *
 * - Tier modes (`always-ask` / `write` / `yolo`) delegate to the tier engine,
 *   which already honors user per-tool policy.
 * - The non-tier modes apply user policy first (explicit `deny` blocks,
 *   explicit `allow` bypasses heuristic + guardian), then:
 *   - `heuristic`: block on a blacklist hit, otherwise allow.
 *   - `guardian`: ask the LLM judge for exec-tier calls; auto-allow others.
 *   - `hybrid`: run the heuristic; escalate only blocked calls to the judge.
 */
export async function evaluatePermission(input: EvaluatePermissionInput): Promise<PermissionAction> {
	const { tool, args, mode, userPolicies, workspaceRoot, hasUI, guardian, signal } = input;

	if (isTierMode(mode)) {
		const resolved = resolveApproval(tool, args, mode, userPolicies);
		if (resolved.policy === "allow") return { action: "allow" };
		if (resolved.policy === "deny") {
			return { action: "deny", reason: resolved.reason ?? `Blocked by user policy for ${tool.name}.` };
		}
		return resolved.reason ? { action: "prompt", reason: resolved.reason } : { action: "prompt" };
	}

	// User per-tool policy is authoritative and bypasses heuristic + guardian.
	const userPolicy = Object.hasOwn(userPolicies, tool.name) ? normalizePolicy(userPolicies[tool.name]) : undefined;
	if (userPolicy === "deny") return { action: "deny", reason: `Blocked by user policy for ${tool.name}.` };
	if (userPolicy === "allow") return { action: "allow" };

	const runGuardian = async (reason?: string): Promise<PermissionAction> => {
		if (!guardian) return failSafe(hasUI, reason);
		const verdict = await guardian.evaluate({ toolName: tool.name, args, reason, cwd: workspaceRoot }, signal);
		if (verdict.decision === "allow") return { action: "allow" };
		if (verdict.decision === "deny") return { action: "deny", reason: verdict.reason };
		return failSafe(hasUI, reason);
	};

	if (mode === "guardian") {
		const tier = getToolDecision(tool, args).tier;
		return tier === EXEC_TIER ? runGuardian() : { action: "allow" };
	}

	const block = classifyHeuristic(tool.name, args, { workspaceRoot });
	if (mode === "heuristic") {
		return block ? { action: "deny", reason: block.reason } : { action: "allow" };
	}
	// hybrid
	return block ? runGuardian(block.reason) : { action: "allow" };
}
