import crypto from "node:crypto";
import type { Redis } from "ioredis";

// ---- Self-hosted "slide the puzzle piece into place" captcha ----
// No third-party service (no reCAPTCHA/Turnstile/hCaptcha, no external
// network call, nothing to configure with an API key) — the frontend
// draws an animated puzzle piece on a <canvas> and the user drags it
// into the notch. This module only handles the parts that must be
// trustworthy on the server: picking the target position, signing a
// tamper-proof challenge, and verifying the submitted answer once.
//
// This is a friction/rate-limiting measure against basic bots and mass
// signup scripts, not a defense against a determined human-driven attack
// — combined with the existing per-IP rate limits on /auth/login and
// /auth/register, it's enough to stop the common case (headless scripts
// hitting the endpoint directly) without any external dependency.

const SECRET = process.env.JWT_SECRET || "change_me_in_env";
const CANVAS_WIDTH = 300;
const CANVAS_HEIGHT = 150;
const PIECE_SIZE = 42;
// Target sits away from both edges so the piece always has somewhere
// realistic to slide from and the notch is never clipped.
const MIN_X = 60;
const MAX_X = CANVAS_WIDTH - PIECE_SIZE - 10;
const TOLERANCE_PX = 8;
const CHALLENGE_TTL_MS = 2 * 60 * 1000; // 2 minutes to solve
// A solve faster than this is almost certainly a script replaying a
// stored answer rather than a person actually dragging the slider;
// slower than this and the challenge has likely expired anyway.
const MIN_ELAPSED_MS = 250;
const MAX_ELAPSED_MS = 60 * 1000;

function sign(payload: string): string {
  return crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
}

export interface CaptchaChallenge {
  id: string;
  targetX: number;
  width: number;
  height: number;
  pieceSize: number;
  issuedAt: number;
  token: string;
}

export function generateCaptchaChallenge(): CaptchaChallenge {
  const id = crypto.randomUUID();
  const targetX = MIN_X + Math.round(Math.random() * (MAX_X - MIN_X));
  const issuedAt = Date.now();
  const payload = JSON.stringify({ id, targetX, issuedAt });
  const payloadB64 = Buffer.from(payload, "utf8").toString("base64url");
  const token = `${payloadB64}.${sign(payloadB64)}`;
  return { id, targetX, width: CANVAS_WIDTH, height: CANVAS_HEIGHT, pieceSize: PIECE_SIZE, issuedAt, token };
}

// Verifies a submitted answer against its signed challenge. Single-use:
// the challenge id is marked spent in Redis on first successful verify,
// so a captured (token, x, elapsedMs) triple can't be replayed against
// /auth/register or /auth/login more than once.
export async function verifyCaptcha(
  redis: Redis,
  token: string | undefined,
  x: number | undefined,
  elapsedMs: number | undefined
): Promise<{ ok: boolean; reason?: string }> {
  if (!token || typeof x !== "number" || typeof elapsedMs !== "number") {
    return { ok: false, reason: "Missing captcha answer" };
  }

  const [payloadB64, signature] = token.split(".");
  if (!payloadB64 || !signature) return { ok: false, reason: "Malformed captcha token" };
  if (sign(payloadB64) !== signature) return { ok: false, reason: "Invalid captcha token" };

  let payload: { id: string; targetX: number; issuedAt: number };
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "Malformed captcha token" };
  }

  if (Date.now() - payload.issuedAt > CHALLENGE_TTL_MS) {
    return { ok: false, reason: "Captcha expired, please try again" };
  }
  if (elapsedMs < MIN_ELAPSED_MS || elapsedMs > MAX_ELAPSED_MS) {
    return { ok: false, reason: "Captcha timing looked automated, please try again" };
  }
  if (Math.abs(x - payload.targetX) > TOLERANCE_PX) {
    return { ok: false, reason: "Puzzle piece wasn't lined up, please try again" };
  }

  // SETNX-style single-use guard so this exact challenge can't be reused.
  const usedKey = `captcha:used:${payload.id}`;
  const firstUse = await redis.set(usedKey, "1", "PX", CHALLENGE_TTL_MS, "NX");
  if (!firstUse) return { ok: false, reason: "Captcha already used, please try again" };

  return { ok: true };
}
