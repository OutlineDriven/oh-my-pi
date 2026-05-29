import * as os from "node:os";
import * as path from "node:path";

/** A block decision with a human-readable reason. */
export interface RiskyPathBlock {
	block: true;
	reason: string;
}

/** System roots that should never be written to from a dev session. */
const SYSTEM_ROOTS = ["/etc", "/usr", "/bin", "/sbin", "/boot", "/sys", "/proc"] as const;

/**
 * Resolve a tool-supplied path against the workspace root, expanding a leading
 * `~` and normalizing the result to an absolute path.
 */
export function resolveTargetPath(targetPath: string, workspaceRoot: string): string {
	let p = targetPath;
	if (p === "~") {
		p = os.homedir();
	} else if (p.startsWith("~/")) {
		p = path.join(os.homedir(), p.slice(2));
	}
	if (!path.isAbsolute(p)) {
		p = path.resolve(workspaceRoot, p);
	}
	return path.normalize(p);
}

function isInside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Classify a write/edit target path as risky.
 *
 * A path is risky when it is outside the workspace root, or when it matches a
 * sensitive denylist (`.ssh`, `.env*`, `.git` internals, system roots, or a
 * dotfile directly under the user's home directory). Returns `null` for
 * ordinary in-workspace paths.
 */
export function classifyRiskyPath(targetPath: string, workspaceRoot: string): RiskyPathBlock | null {
	const resolved = resolveTargetPath(targetPath, workspaceRoot);
	const root = path.resolve(workspaceRoot);
	const segments = resolved.split(path.sep).filter(Boolean);
	const base = path.basename(resolved);
	const home = os.homedir();

	if (segments.includes(".ssh")) {
		return { block: true, reason: `Refusing to modify SSH path: ${resolved}` };
	}
	if (base === ".env" || base.startsWith(".env.")) {
		return { block: true, reason: `Refusing to modify environment file: ${resolved}` };
	}
	const gitIdx = segments.indexOf(".git");
	if (gitIdx !== -1 && gitIdx < segments.length - 1) {
		return { block: true, reason: `Refusing to modify .git internals: ${resolved}` };
	}
	for (const sys of SYSTEM_ROOTS) {
		if (resolved === sys || resolved.startsWith(`${sys}${path.sep}`)) {
			return { block: true, reason: `Refusing to modify system path: ${resolved}` };
		}
	}
	if (path.dirname(resolved) === home && base.startsWith(".")) {
		return { block: true, reason: `Refusing to modify home dotfile: ${resolved}` };
	}
	if (!isInside(resolved, root)) {
		return { block: true, reason: `Path is outside the workspace root: ${resolved}` };
	}
	return null;
}
