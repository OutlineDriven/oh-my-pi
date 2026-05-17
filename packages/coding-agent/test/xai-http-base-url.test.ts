import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resolveXAIHttpCredentials } from "@oh-my-pi/pi-coding-agent/lib/xai-http";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { Snowflake } from "@oh-my-pi/pi-utils";

/**
 * Pins the two invariants introduced by Codex PR #1127 reviews:
 *
 *   1. When the (provider, modelId) lookup misses, `resolveXAIBaseURL` falls
 *      back to the registry's provider-level baseUrl before going to env /
 *      default — i.e. per-model override > provider-level baseUrl. (Lower
 *      precedence steps `XAI_BASE_URL` env > `DEFAULT_BASE_URL` are NOT
 *      exercised here; only the per-model and provider-level legs are
 *      covered. Add focused env / default tests if those legs need pinning.)
 *
 *   2. `resolveXAIHttpCredentials` selects xai-oauth only on a dedicated
 *      source (stored credential, runtime/config override, `XAI_OAUTH_TOKEN`,
 *      or fallback resolver). The `XAI_API_KEY` env-fallback borrow routes
 *      through xai so `providers.xai.baseUrl` overrides apply.
 *
 * The bugs the reviews caught: image/TTS calls with non-catalog modelIds
 * (filtered `grok-imagine-*`) silently bypassed proxies, and API-key-only
 * setups misclassified as xai-oauth.
 */
describe("resolveXAIHttpCredentials precedence", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-xai-http-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		// Snapshot xAI env vars to isolate each test.
		for (const key of ["XAI_API_KEY", "XAI_OAUTH_TOKEN", "XAI_BASE_URL"]) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	async function provisionStoredXaiOAuth(): Promise<void> {
		await authStorage.set("xai-oauth", {
			type: "oauth",
			refresh: "test-refresh",
			access: "test-access",
			expires: Date.now() + 3_600_000,
		});
	}

	test("provider-level baseUrl applies to filtered tool-only modelId (grok-imagine-image)", async () => {
		await provisionStoredXaiOAuth();
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.json"));
		registry.registerProvider("xai-oauth", { baseUrl: "https://provider.example/v1" }, "ext://test");

		// `grok-imagine-image` is filtered out of the xai-oauth catalog by
		// XAI_NON_CHAT_PREFIXES, so per-model lookup misses and the
		// provider-level fallback in resolveXAIBaseURL must fire.
		const creds = await resolveXAIHttpCredentials(registry, "grok-imagine-image");
		expect(creds?.provider).toBe("xai-oauth");
		expect(creds?.baseURL).toBe("https://provider.example/v1");
	});

	test("per-model baseUrl wins over provider-level (precedence lock)", async () => {
		await provisionStoredXaiOAuth();
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
		expect(creds?.baseURL).toBe("https://permodel.example/v1");
	});

	test("XAI_API_KEY-only setup routes through xai, not xai-oauth (borrow gate)", async () => {
		// No stored xai-oauth credential, no XAI_OAUTH_TOKEN — XAI_API_KEY alone
		// would otherwise satisfy xai-oauth via the env-fallback map borrow.
		process.env.XAI_API_KEY = "test-xai-api-key";
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.json"));
		registry.registerProvider("xai", { baseUrl: "https://xai-proxy.example/v1" }, "ext://test-xai");
		// Set an unrelated xai-oauth baseUrl: if classification leaks, the
		// returned baseURL would be this URL instead of the xai proxy.
		registry.registerProvider("xai-oauth", { baseUrl: "https://wrong-oauth.example/v1" }, "ext://test-oauth-wrong");

		const creds = await resolveXAIHttpCredentials(registry, "grok-imagine-image");
		expect(creds?.provider).toBe("xai");
		expect(creds?.apiKey).toBe("test-xai-api-key");
		expect(creds?.baseURL).toBe("https://xai-proxy.example/v1");
	});
});
