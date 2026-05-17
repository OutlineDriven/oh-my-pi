import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resolveXAIHttpCredentials } from "@oh-my-pi/pi-coding-agent/lib/xai-http";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { Snowflake } from "@oh-my-pi/pi-utils";

/**
 * Pins precedence in `resolveXAIBaseURL`: per-model override > provider-level
 * baseUrl > XAI_BASE_URL env > DEFAULT_BASE_URL.
 *
 * The bug Codex caught (PR #1127): tool calls with non-catalog modelIds — e.g.
 * `generate_image` with `grok-imagine-image`, which `applyXAIOAuthCuration`
 * filters out via XAI_NON_CHAT_PREFIXES — would skip the provider-level
 * `providers.xai-oauth.baseUrl` override and fall through to the env/default,
 * silently bypassing a configured proxy.
 */
describe("resolveXAIBaseURL precedence for tool calls", () => {
	let tempDir: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-xai-http-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		// Stored OAuth credential so the xai-oauth branch of
		// resolveXAIHttpCredentials stays active. Without this, the hasOAuth
		// gate (separate commit) routes credentials through plain `xai` and
		// the test would not exercise the xai-oauth resolution path.
		await authStorage.set("xai-oauth", {
			type: "oauth",
			refresh: "test-refresh",
			access: "test-access",
			expires: Date.now() + 3_600_000,
		});
	});

	afterEach(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("provider-level baseUrl applies to filtered tool-only modelId (grok-imagine-image)", async () => {
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.json"));
		registry.registerProvider("xai-oauth", { baseUrl: "https://provider.example/v1" }, "ext://test");

		// `grok-imagine-image` is filtered out of the xai-oauth catalog by
		// XAI_NON_CHAT_PREFIXES, so per-model lookup misses and the new
		// provider-level fallback in resolveXAIBaseURL must fire.
		const creds = await resolveXAIHttpCredentials(registry, "grok-imagine-image");
		expect(creds?.provider).toBe("xai-oauth");
		expect(creds?.baseURL).toBe("https://provider.example/v1");
	});

	test("per-model baseUrl wins over provider-level (precedence lock)", async () => {
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.json"));
		const config: ProviderConfigInput = {
			baseUrl: "https://provider.example/v1",
			apiKey: "TEST_KEY",
			api: "openai-responses",
			models: [
				{
					id: "grok-4.3",
					name: "Grok 4.3",
					baseUrl: "https://permodel.example/v1",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1_000_000,
					maxTokens: 8192,
				},
			],
		};
		registry.registerProvider("xai-oauth", config, "ext://test-permodel");

		const creds = await resolveXAIHttpCredentials(registry, "grok-4.3");
		expect(creds?.provider).toBe("xai-oauth");
		// Distinct URL from provider-level — proves per-model branch fires first.
		expect(creds?.baseURL).toBe("https://permodel.example/v1");
	});
});
