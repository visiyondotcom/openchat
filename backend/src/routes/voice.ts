import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../lib/jwt.js";
import { transcribeAudio, synthesizeSpeech, voiceConfig } from "../lib/voice.js";
import { loadUploadLimits } from "../lib/uploads.js";

// Audio types actually accepted by faster-whisper-server. Without this,
// any file type would be forwarded to the transcription container —
// media parsers (ffmpeg/whisper's own decoding path) are a real attack
// surface for maliciously crafted files, so we restrict to known-safe
// audio containers, same pattern as ALLOWED_MIME in routes/documents.ts.
const AUDIO_ALLOWED_MIME = new Set([
  "audio/webm",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/ogg",
  "audio/flac",
]);

export default async function voiceRoutes(app: FastifyInstance) {
  // ---- Current voice settings, for the chat UI to decide whether to show
  // the mic button (STT) and "Read aloud" button (TTS). ----
  app.get("/voice/config", { preHandler: requireAuth }, async () => {
    const { sttEnabled, ttsEnabled } = await voiceConfig(app.prisma);
    return { sttEnabled, ttsEnabled };
  });

  // ---- Speech-to-text: multipart/form-data, field name "audio" ----
  // Runs against the self-hosted faster-whisper-server container — audio
  // never leaves the deployment.
  app.post("/voice/transcribe", { preHandler: requireAuth }, async (req, reply) => {
    const { sttEnabled } = await voiceConfig(app.prisma);
    if (!sttEnabled) return reply.code(403).send({ error: "Speech-to-text is disabled" });

    const { voiceMaxUploadBytes } = await loadUploadLimits(app.prisma);
    const file = await req.file({ limits: { fileSize: voiceMaxUploadBytes } });
    if (!file) return reply.code(400).send({ error: "No audio uploaded" });

    if (!AUDIO_ALLOWED_MIME.has(file.mimetype)) {
      return reply.code(415).send({ error: "Unsupported audio type." });
    }

    const buffer = await file.toBuffer();
    if (buffer.length === 0) return reply.code(400).send({ error: "Empty audio" });
    if (file.file.truncated) {
      return reply.code(413).send({
        error: `Audio file is too large. Max ${(voiceMaxUploadBytes / 1024 / 1024).toFixed(0)}MB.`,
      });
    }

    try {
      const text = await transcribeAudio(buffer, file.filename, file.mimetype);
      return { text };
    } catch (err) {
      app.log.error({ err }, "transcription failed");
      return reply.code(502).send({ error: "Transcription service unavailable" });
    }
  });

  // ---- Text-to-speech: returns raw audio (WAV for self-hosted providers,
  // MP3 for ElevenLabs) ----
  app.post("/voice/speak", { preHandler: requireAuth }, async (req, reply) => {
    const { ttsEnabled, ttsProvider, voice: defaultVoice, ttsUrl, ttsApiKey } = await voiceConfig(app.prisma);
    if (!ttsEnabled) return reply.code(403).send({ error: "Text-to-speech is disabled" });

    const { text, voice } = z.object({ text: z.string().min(1).max(4000), voice: z.string().optional() }).parse(req.body);

    try {
      const { audio, contentType } = await synthesizeSpeech(text, {
        provider: ttsProvider,
        voice: voice || defaultVoice,
        url: ttsUrl,
        apiKey: ttsApiKey,
      });
      reply.header("Content-Type", contentType);
      return reply.send(audio);
    } catch (err) {
      app.log.error({ err }, "speech synthesis failed");
      return reply.code(502).send({ error: "Speech synthesis service unavailable" });
    }
  });
}
