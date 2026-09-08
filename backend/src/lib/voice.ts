import { request } from "undici";
import type { PrismaClient } from "@prisma/client";

// STT is always the self-hosted faster-whisper-server container
// (OpenAI-compatible /v1/audio/transcriptions route, 100% local inference).
//
// TTS is pluggable — pick a provider from Admin > Settings > Voice:
//   - "piper"      bundled, fully local, fast, robotic-ish (default)
//   - "coqui"      bundled XTTS-v2 wrapper, local, natural, GPU recommended
//   - "kokoro"     bundled Kokoro-TTS wrapper, local, natural, runs fine on CPU
//   - "elevenlabs" cloud API, the most human-sounding option, needs an API key
// The three self-hosted wrappers (piper/, coqui/, kokoro/ under the repo
// root) all speak the same tiny contract — POST {text, voice} -> WAV bytes
// — so they're handled identically here, just against different URLs.

const WHISPER_URL = process.env.WHISPER_URL || "http://whisper:8000";

const SELFHOSTED_DEFAULT_URLS: Record<string, string> = {
  piper: process.env.PIPER_URL || "http://piper:5001",
  coqui: process.env.COQUI_URL || "http://coqui:5002",
  kokoro: process.env.KOKORO_URL || "http://kokoro:5003",
};
const DEFAULT_VOICE = "en_US-lessac-medium";
const ELEVENLABS_DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // "Rachel" — ElevenLabs' default premade voice

type TtsProvider = "piper" | "coqui" | "kokoro" | "elevenlabs";

// ---- Config resolution ----
// Same "DB wins, falls back to env" pattern as lib/images.ts /
// lib/websearch.ts: config can come from Admin > Settings > Voice (the
// AppSettings singleton row) or from env vars. Cached briefly; admin.ts
// calls invalidateVoiceConfigCache() right after a save so a change takes
// effect immediately, no restart needed.
type VoiceConfig = {
  sttEnabled: boolean;
  ttsEnabled: boolean;
  ttsProvider: TtsProvider;
  voice: string;
  ttsUrl: string | null;
  ttsApiKey: string | null;
};

const CACHE_TTL_MS = 30_000;
let cache: { value: VoiceConfig; expiresAt: number } | null = null;

export function invalidateVoiceConfigCache(): void {
  cache = null;
}

function isTtsProvider(v: string | null | undefined): v is TtsProvider {
  return v === "piper" || v === "coqui" || v === "kokoro" || v === "elevenlabs";
}

async function loadConfig(prisma?: PrismaClient): Promise<VoiceConfig> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;

  let row: {
    voiceSttEnabled: boolean | null;
    voiceTtsEnabled: boolean | null;
    voiceTtsProvider: string | null;
    voiceTtsVoice: string | null;
    voiceTtsUrl: string | null;
    voiceTtsApiKey: string | null;
  } | null = null;
  if (prisma) {
    try {
      row = await prisma.appSettings.findUnique({
        where: { id: "singleton" },
        select: {
          voiceSttEnabled: true,
          voiceTtsEnabled: true,
          voiceTtsProvider: true,
          voiceTtsVoice: true,
          voiceTtsUrl: true,
          voiceTtsApiKey: true,
        },
      });
    } catch {
      // Table/row not reachable (e.g. migration not run yet) — fall back
      // to env vars entirely rather than failing every voice call.
      row = null;
    }
  }

  const provider: TtsProvider = isTtsProvider(row?.voiceTtsProvider)
    ? row!.voiceTtsProvider
    : isTtsProvider(process.env.TTS_PROVIDER)
    ? (process.env.TTS_PROVIDER as TtsProvider)
    : "piper";

  // A service is only ever "configured" if it has somewhere to reach —
  // the self-hosted providers always have a default compose URL, so
  // they're considered configured unless explicitly disabled; ElevenLabs
  // needs an actual key from somewhere.
  const ttsConfigured =
    provider === "elevenlabs"
      ? Boolean(row?.voiceTtsApiKey || process.env.ELEVENLABS_API_KEY)
      : true;
  const sttConfigured = Boolean(process.env.WHISPER_URL);

  const value: VoiceConfig = {
    sttEnabled: (row?.voiceSttEnabled ?? sttConfigured) && sttConfigured,
    ttsEnabled: (row?.voiceTtsEnabled ?? ttsConfigured) && ttsConfigured,
    ttsProvider: provider,
    voice: row?.voiceTtsVoice || process.env.PIPER_VOICE || DEFAULT_VOICE,
    ttsUrl: row?.voiceTtsUrl || null,
    ttsApiKey: row?.voiceTtsApiKey || null,
  };
  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export async function voiceConfig(prisma?: PrismaClient): Promise<VoiceConfig> {
  return loadConfig(prisma);
}

// Sends raw audio bytes (webm/ogg/wav from the browser's MediaRecorder) to
// faster-whisper-server and returns the transcribed text.
export async function transcribeAudio(buffer: Buffer, filename: string, mimetype: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buffer)], { type: mimetype }), filename || "audio.webm");
  form.append("model", process.env.WHISPER_MODEL || "base");

  const res = await request(`${WHISPER_URL}/v1/audio/transcriptions`, {
    method: "POST",
    body: form as any,
  });
  if (res.statusCode >= 400) {
    throw new Error(`Whisper transcription failed: ${res.statusCode} ${await res.body.text()}`);
  }
  const data = (await res.body.json()) as { text: string };
  return data.text?.trim() || "";
}

// Piper / Coqui / Kokoro all share the same tiny wrapper contract, so one
// function handles all three self-hosted providers.
async function synthesizeSelfHosted(provider: "piper" | "coqui" | "kokoro", text: string, voice: string, urlOverride: string | null): Promise<Buffer> {
  const baseUrl = urlOverride || SELFHOSTED_DEFAULT_URLS[provider];
  const res = await request(`${baseUrl}/speak`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, voice }),
  });
  if (res.statusCode >= 400) {
    throw new Error(`${provider} synthesis failed: ${res.statusCode} ${await res.body.text()}`);
  }
  const arrayBuffer = await res.body.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ElevenLabs cloud TTS — https://api.elevenlabs.io/v1/text-to-speech/{voice_id}
async function synthesizeElevenLabs(text: string, voiceId: string, apiKey: string | null): Promise<Buffer> {
  const key = apiKey || process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ElevenLabs API key is not configured");

  const res = await request(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: "POST",
    headers: { "content-type": "application/json", "xi-api-key": key, accept: "audio/mpeg" },
    body: JSON.stringify({
      text,
      model_id: process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (res.statusCode >= 400) {
    throw new Error(`ElevenLabs synthesis failed: ${res.statusCode} ${await res.body.text()}`);
  }
  const arrayBuffer = await res.body.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Synthesizes speech using whichever provider is configured (see
// voiceConfig()). Returns raw audio bytes — WAV for the self-hosted
// providers, MP3 for ElevenLabs; the caller (routes/voice.ts) sets the
// matching Content-Type.
export async function synthesizeSpeech(
  text: string,
  opts: { provider: TtsProvider; voice?: string; url?: string | null; apiKey?: string | null }
): Promise<{ audio: Buffer; contentType: string }> {
  const { provider, voice, url, apiKey } = opts;

  if (provider === "elevenlabs") {
    const audio = await synthesizeElevenLabs(text, voice || ELEVENLABS_DEFAULT_VOICE_ID, apiKey ?? null);
    return { audio, contentType: "audio/mpeg" };
  }

  const audio = await synthesizeSelfHosted(provider, text, voice || DEFAULT_VOICE, url ?? null);
  return { audio, contentType: "audio/wav" };
}
