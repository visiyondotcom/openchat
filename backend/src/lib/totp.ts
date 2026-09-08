import { randomBytes, createHmac, randomInt } from "crypto";

// Minimal RFC 6238 (TOTP) / RFC 4648 (base32) implementation. Deliberately
// dependency-free — this is ~80 lines of well-specified crypto, not worth
// pulling in a package for.

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(str: string): Buffer {
  const clean = str.toUpperCase().replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// Generates a new random base32 secret for a fresh 2FA enrollment.
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

// otpauth:// URI that authenticator apps (Google Authenticator, Authy, etc.)
// scan as a QR code to add the account.
export function buildTotpUri(secret: string, accountEmail: string, issuer = "Visiyon AI"): string {
  const label = encodeURIComponent(`${issuer}:${accountEmail}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 10 ** DIGITS).padStart(DIGITS, "0");
}

// Verifies a 6-digit code against the current time step, allowing +/- 1 step
// (30s) of clock drift, which is the conventional tolerance for TOTP.
export function verifyTotpCode(secret: string, code: string, windowSteps = 1): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const counter = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  for (let errorWindow = -windowSteps; errorWindow <= windowSteps; errorWindow++) {
    if (hotp(secret, counter + errorWindow) === code) return true;
  }
  return false;
}

// One-time-use recovery codes shown once at enrollment. Stored hashed
// (sha256) in twoFaBackupCodes; plaintext is only ever returned to the
// client at generation time.
export function generateBackupCodes(count = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const part = () => String(randomInt(0, 100000)).padStart(5, "0");
    codes.push(`${part()}-${part()}`);
  }
  return codes;
}

export function hashBackupCode(code: string): string {
  return createHmac("sha256", "visiyon-backup-code").update(code.trim().toUpperCase()).digest("hex");
}
