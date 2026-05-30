import { describe, expect, it } from "bun:test";
import { extractLeadingCd } from "@oh-my-pi/pi-coding-agent/tools/bash-cwd";

describe("extractLeadingCd", () => {
	it("extracts a leading `cd <path> && ...` prefix", () => {
		expect(extractLeadingCd("cd /etc && touch x")).toEqual({ cd: "/etc", command: "touch x" });
	});

	it("unquotes a quoted path", () => {
		expect(extractLeadingCd('cd "/some dir" && ls')).toEqual({ cd: "/some dir", command: "ls" });
		expect(extractLeadingCd("cd 'my dir' && ls")).toEqual({ cd: "my dir", command: "ls" });
	});

	it("returns the command unchanged when there is no leading cd", () => {
		expect(extractLeadingCd("ls -la")).toEqual({ cd: undefined, command: "ls -la" });
	});

	it("does not capture an `&&` that sits on a later line of a multiline script", () => {
		const command = "cd /etc\necho hi && touch x";
		expect(extractLeadingCd(command)).toEqual({ cd: undefined, command });
	});

	it("extracts a relative cd path", () => {
		expect(extractLeadingCd("cd src && ls")).toEqual({ cd: "src", command: "ls" });
	});
});
