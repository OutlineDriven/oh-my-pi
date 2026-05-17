// Ported from NousResearch/hermes-agent (MIT) — tools/xai_http.py.

import { getBundledModels } from "@oh-my-pi/pi-ai";
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

type XAIProvider = "xai-oauth" | "xai";

/**
 * Resolve the HTTP base URL for an xAI tool call.
 *
 * Precedence:
 *   1. `model.baseUrl` from the registry IF the user pinned a per-model
 *      override (the merged baseUrl differs from the bundled default for the
 *      (provider, id) pair, OR the pair exists only as a user-defined model).
 *      Mirrors the chat path's per-model contract (`openai-responses.ts:
 *      model.baseUrl`).
 *   2. `XAI_BASE_URL` env var (legacy global override, preserved).
 *   3. `DEFAULT_BASE_URL = "https://api.x.ai/v1"`.
 *
 * The override gate at step 1 prevents bundled defaults (which equal
 * `DEFAULT_BASE_URL`) from short-circuiting the env leg — users on env-only
 * configuration see no behavior change. Lookup is scoped to (provider, id);
 * matching by id alone would let xai-oauth entries hijack a xai tool call (or
 * vice versa) when the same model id ships under both descriptors.
 */
function resolveXAIBaseURL(modelRegistry: ModelRegistry, provider: XAIProvider, modelId: string | undefined): string {
	if (modelId) {
		const merged = modelRegistry.getAll().find(m => m.id === modelId && m.provider === provider);
		if (merged?.baseUrl) {
			const bundled = getBundledModels(provider as Parameters<typeof getBundledModels>[0]).find(
				m => m.id === modelId,
			);
			if (!bundled || merged.baseUrl !== bundled.baseUrl) {
				return merged.baseUrl.replace(/\/$/, "");
			}
		}
	}
	return ($env.XAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
}

/**
 * Resolve xAI credentials for HTTP tool calls.
 *
 * Credential priority:
 *   1. xai-oauth (SuperGrok subscription token via AuthStorage; refresh
 *      cascade runs inside ModelRegistry.getApiKeyForProvider).
 *   2. xai (plain API key) via the same registry path. Delegates to
 *      ModelRegistry.getApiKeyForProvider which runs AuthStorage.getApiKey's
 *      full cascade: runtime override → models.yml config override → stored
 *      api_key credential → OAuth resolution → XAI_API_KEY env var → custom
 *      fallback resolver.
 *
 * baseURL: see `resolveXAIBaseURL` above. Resolved AFTER the credential
 * decision so the scoped (provider, id) lookup is unambiguous. `modelId`
 * is optional; probes / tool-availability checks pass `undefined` and fall
 * through to env/default.
 *
 * Returns null when neither credential is available. Caller is responsible
 * for surfacing an actionable error message in that case.
 */
export async function resolveXAIHttpCredentials(
	modelRegistry: ModelRegistry,
	modelId?: string,
): Promise<XAICredentials | null> {
	const oauthKey = await modelRegistry.getApiKeyForProvider("xai-oauth");
	if (oauthKey) {
		const baseURL = resolveXAIBaseURL(modelRegistry, "xai-oauth", modelId);
		return { provider: "xai-oauth", apiKey: oauthKey, baseURL };
	}

	const apiKey = await modelRegistry.getApiKeyForProvider("xai");
	if (apiKey) {
		const baseURL = resolveXAIBaseURL(modelRegistry, "xai", modelId);
		return { provider: "xai", apiKey, baseURL };
	}

	return null;
}
