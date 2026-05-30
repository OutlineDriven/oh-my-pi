import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { classifyRiskyPath } from "@oh-my-pi/pi-coding-agent/tools/permission/risky-paths";

const ROOT = "/home/user/project";

describe("classifyRiskyPath", () => {
	it("allows ordinary in-workspace paths", () => {
		expect(classifyRiskyPath("src/index.ts", ROOT)).toBeNull();
		expect(classifyRiskyPath("./README.md", ROOT)).toBeNull();
	});

	it("blocks paths outside the workspace", () => {
		expect(classifyRiskyPath("../../etc/hosts", ROOT)?.block).toBe(true);
	});

	it("blocks sensitive dotfiles and system paths", () => {
		expect(classifyRiskyPath("~/.ssh/id_rsa", ROOT)?.block).toBe(true);
		expect(classifyRiskyPath("/etc/passwd", ROOT)?.block).toBe(true);
		expect(classifyRiskyPath(".env", ROOT)?.block).toBe(true);
		expect(classifyRiskyPath(".env.local", ROOT)?.block).toBe(true);
	});
});

describe("classifyRiskyPath — symlink resolution", () => {
	let ws: string;
	let outside: string;

	beforeAll(() => {
		ws = fs.mkdtempSync(path.join(os.tmpdir(), "omp-risky-ws-"));
		outside = fs.mkdtempSync(path.join(os.tmpdir(), "omp-risky-out-"));
		fs.mkdirSync(path.join(ws, "sub"));
		fs.symlinkSync("sub", path.join(ws, "inside-link")); // dir symlink that stays in the workspace
		fs.symlinkSync("/etc", path.join(ws, "escape-sys")); // dir symlink to a system root
		fs.symlinkSync(outside, path.join(ws, "escape-out")); // dir symlink outside the workspace
		fs.symlinkSync(path.join(outside, "secret"), path.join(ws, "link-file")); // file symlink outside
		// Multi-hop: chain -> hop/x, hop -> outside; writing chain/* lands outside.
		fs.symlinkSync(outside, path.join(ws, "hop"));
		fs.symlinkSync("hop/nested", path.join(ws, "chain"));
	});

	afterAll(() => {
		fs.rmSync(ws, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	});

	it("still allows a real in-workspace subdir path", () => {
		expect(classifyRiskyPath("sub/new.txt", ws)).toBeNull();
	});

	it("blocks writing through a symlink into a system root", () => {
		expect(classifyRiskyPath("escape-sys/passwd", ws)?.block).toBe(true);
	});

	it("blocks writing through a symlink that escapes the workspace", () => {
		expect(classifyRiskyPath("escape-out/file.txt", ws)?.block).toBe(true);
	});

	it("blocks a file symlink whose target is outside the workspace", () => {
		expect(classifyRiskyPath("link-file", ws)?.block).toBe(true);
	});

	it("blocks a multi-hop symlink chain that escapes the workspace", () => {
		// chain -> hop/nested, hop -> outside  ⇒  chain/file lands in outside/.
		expect(classifyRiskyPath("chain/file.txt", ws)?.block).toBe(true);
	});
});
