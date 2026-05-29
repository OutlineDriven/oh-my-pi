import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { classifyRiskyPath } from "@oh-my-pi/pi-coding-agent/tools/permission/risky-paths";

const ROOT = "/home/user/project";

describe("classifyRiskyPath", () => {
	it("allows ordinary in-workspace files", () => {
		expect(classifyRiskyPath("src/foo.ts", ROOT)).toBeNull();
		expect(classifyRiskyPath("src/a/b/c.ts", ROOT)).toBeNull();
		expect(classifyRiskyPath(`${ROOT}/lib/index.ts`, ROOT)).toBeNull();
	});

	it("blocks paths outside the workspace root", () => {
		expect(classifyRiskyPath("../outside.txt", ROOT)?.block).toBe(true);
		expect(classifyRiskyPath("/var/data/x", ROOT)?.block).toBe(true);
	});

	it("blocks SSH paths", () => {
		expect(classifyRiskyPath(path.join(os.homedir(), ".ssh/authorized_keys"), ROOT)?.block).toBe(true);
		expect(classifyRiskyPath(".ssh/id_rsa", ROOT)?.block).toBe(true);
	});

	it("blocks environment files even inside the workspace", () => {
		expect(classifyRiskyPath(".env", ROOT)?.block).toBe(true);
		expect(classifyRiskyPath("config/.env.production", ROOT)?.block).toBe(true);
	});

	it("blocks .git internals", () => {
		expect(classifyRiskyPath(".git/config", ROOT)?.block).toBe(true);
		expect(classifyRiskyPath(".git/hooks/pre-commit", ROOT)?.block).toBe(true);
	});

	it("blocks system roots", () => {
		expect(classifyRiskyPath("/etc/hosts", ROOT)?.block).toBe(true);
		expect(classifyRiskyPath("/usr/bin/x", ROOT)?.block).toBe(true);
	});

	it("blocks home-root dotfiles", () => {
		expect(classifyRiskyPath("~/.bashrc", ROOT)?.block).toBe(true);
		expect(classifyRiskyPath("~/.gitconfig", ROOT)?.block).toBe(true);
	});
});
