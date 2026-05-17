// Ported from NousResearch/hermes-agent (MIT) — tools/tts_tool.py L167-171, L896-959.

import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import * as z from "zod/v4";
import type { ModelRegistry } from "../config/model-registry";
import type { CustomTool, CustomToolContext } from "../extensibility/custom-tools/types";
import { ohMyPiXAIUserAgent, resolveXAIHttpCredentials } from "../lib/xai-http";
import { formatPathRelativeToCwd } from "./path-utils";

// Hermes tts_tool.py L167-171
const DEFAULT_XAI_VOICE_ID = "eve" as const;
const DEFAULT_XAI_LANGUAGE = "en" as const;
const DEFAULT_XAI_SAMPLE_RATE = 24_000;
const DEFAULT_XAI_BIT_RATE = 128_000;
const XAI_MAX_TEXT_LENGTH = 15_000;

// Built-in voices per xAI Tier-1 docs (2026-05-16). xAI also accepts custom voice IDs,
// so the schema does NOT enum-restrict voice_id; this constant only drives the description.
const XAI_BUILTIN_VOICES = ["ara", "eve", "leo", "rex", "sal"] as const;

const formatVoiceList = (): string =>
	XAI_BUILTIN_VOICES.map(v => (v === DEFAULT_XAI_VOICE_ID ? `${v} (default)` : v)).join(", ");

type TtsCodec = "mp3" | "wav";

const ttsSchema = z.object({
	text: z.string().min(1).max(XAI_MAX_TEXT_LENGTH),
	voice_id: z.string().default(DEFAULT_XAI_VOICE_ID),
	language: z.string().default(DEFAULT_XAI_LANGUAGE),
	output_path: z.string(),
	sample_rate: z.number().int().optional(),
	bit_rate: z.number().int().optional(),
});

interface TtsToolDetails {
	bytes: number;
	voiceId: string;
	codec: TtsCodec;
}

export const ttsTool: CustomTool<typeof ttsSchema, TtsToolDetails> = {
	name: "tts",
	label: "TextToSpeech",
	strict: false,
	description:
		`Synthesize speech from text using xAI Grok Voice. Built-in voices: ${formatVoiceList()}. ` +
		"Custom voice IDs also accepted. Output codec inferred from output_path suffix (.wav → wav, else mp3). " +
		`Max ${XAI_MAX_TEXT_LENGTH.toLocaleString("en-US")} characters.`,
	parameters: ttsSchema,
	async execute(
		_toolCallId: string,
		params: z.infer<typeof ttsSchema>,
		_onUpdate,
		ctx: CustomToolContext,
		signal?: AbortSignal,
	): Promise<AgentToolResult<TtsToolDetails, typeof ttsSchema>> {
		const creds = await resolveXAIHttpCredentials(ctx.modelRegistry, ctx.model?.id);
		if (!creds) {
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: "No xAI credentials. Run /login → xAI Grok OAuth (SuperGrok Subscription) or set XAI_API_KEY.",
					},
				],
			};
		}

		const codec: TtsCodec = params.output_path.endsWith(".wav") ? "wav" : "mp3";
		const voiceId = params.voice_id;
		const language = params.language;
		const sampleRate = params.sample_rate ?? DEFAULT_XAI_SAMPLE_RATE;
		const bitRate = params.bit_rate ?? DEFAULT_XAI_BIT_RATE;

		const payload: Record<string, unknown> = {
			text: params.text,
			voice_id: voiceId,
			language,
		};
		// Hermes tts_tool.py L926-940 — only send output_format when caller overrides a default.
		const codecOverridden = codec !== "mp3";
		const sampleRateOverridden = sampleRate !== DEFAULT_XAI_SAMPLE_RATE;
		const bitRateOverridden = codec === "mp3" && bitRate !== DEFAULT_XAI_BIT_RATE;
		if (codecOverridden || sampleRateOverridden || bitRateOverridden) {
			const fmt: Record<string, unknown> = { codec, sample_rate: sampleRate };
			if (codec === "mp3") fmt.bit_rate = bitRate;
			payload.output_format = fmt;
		}

		// Compose the caller signal with a 60 s timeout fence.
		const timeoutSignal = AbortSignal.timeout(60_000);
		const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

		const response = await fetch(`${creds.baseURL}/tts`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${creds.apiKey}`,
				"Content-Type": "application/json",
				"User-Agent": ohMyPiXAIUserAgent(),
			},
			body: JSON.stringify(payload),
			signal: combinedSignal,
		});
		if (!response.ok) {
			const detail = await response.text();
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: `xAI TTS failed (${response.status}): ${detail.slice(0, 300)}`,
					},
				],
			};
		}
		const bytes = new Uint8Array(await response.arrayBuffer());
		// Resolve relative output_path against the session's current working directory,
		// not the process launch directory. Mirrors the input-path convention in
		// image-gen.ts:948 (`const cwd = ctx.sessionManager.getCwd()`).
		const sessionCwd = ctx.sessionManager.getCwd();
		const resolvedPath = path.isAbsolute(params.output_path)
			? params.output_path
			: path.resolve(sessionCwd, params.output_path);
		await Bun.write(resolvedPath, bytes);
		return {
			content: [
				{
					type: "text",
					text: `Saved ${bytes.length} bytes to ${formatPathRelativeToCwd(resolvedPath, sessionCwd)} (voice=${voiceId}, codec=${codec}).`,
				},
			],
			details: { bytes: bytes.length, voiceId, codec },
		};
	},
};

/**
 * Returns the xAI Grok Voice TTS tool only when xAI credentials are reachable
 * — either an active xai-oauth (SuperGrok) session or a static XAI_API_KEY.
 *
 * Registering the tool unconditionally lets the model attempt a synthesis call
 * that then fails at execute time with "No xAI credentials". That wastes a
 * turn and pollutes the tool surface for users on other providers. Probing
 * here keeps the model's available-tool list honest.
 *
 * The probe runs through ModelRegistry.getApiKeyForProvider("xai-oauth"),
 * which already triggers the AuthStorage refresh cascade — so a token that
 * is expired but refreshable will be refreshed and the tool will register.
 * Only truly absent credentials cause an empty return.
 */
export async function getTtsTools(modelRegistry: ModelRegistry): Promise<CustomTool[]> {
	const creds = await resolveXAIHttpCredentials(modelRegistry);
	if (!creds) return [];
	return [ttsTool as unknown as CustomTool];
}
