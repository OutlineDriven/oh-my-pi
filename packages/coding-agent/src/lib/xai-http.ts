// Ported from NousResearch/hermes-agent (MIT) — tools/xai_http.py.

import { $env } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";

const DEFAULT_BASE_URL = "https://api.x.ai/v1";

interface XAICredentials {
	provider: "xai-oauth" | "xai";
	apiKey: string;
	baseURL: string;
}

export function ohMyPiXAIUserAgent(): string {
	return "oh-my-pi/xai";
}

/**
 * Resolve xAI credentials for HTTP tool calls.
 *
 * Priority:
 *   1. xai-oauth (SuperGrok subscription token via AuthStorage; refresh
 *      cascade runs inside ModelRegistry.getApiKeyForProvider).
 *   2. xai (plain API key) via the same registry path. Delegates to
 *      ModelRegistry.getApiKeyForProvider which runs AuthStorage.getApiKey's
 *      full cascade: runtime override → models.yml config override → stored
 *      api_key credential → OAuth resolution → XAI_API_KEY env var → custom
 *      fallback resolver. Replaces the prior direct $env.XAI_API_KEY read,
 *      which skipped models.yml / AuthStorage-stored credentials and made
 *      image/TTS tools silently unavailable to users whose chat path
 *      authenticated through registry-managed creds.
 *
 * Returns null when neither credential is available. Caller is responsible
 * for surfacing an actionable error message in that case.
 *
 * baseURL: respects XAI_BASE_URL override (trailing slash stripped); falls
 * back to https://api.x.ai/v1.
 */
export async function resolveXAIHttpCredentials(modelRegistry: ModelRegistry): Promise<XAICredentials | null> {
	const baseURL = ($env.XAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");

	const oauthKey = await modelRegistry.getApiKeyForProvider("xai-oauth");
	if (oauthKey) {
		return { provider: "xai-oauth", apiKey: oauthKey, baseURL };
	}

	const apiKey = await modelRegistry.getApiKeyForProvider("xai");
	if (apiKey) {
		return { provider: "xai", apiKey, baseURL };
	}

	return null;
}
