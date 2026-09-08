import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

// Encrypts secrets (currently: AI provider API keys) before they're written
// to the database, so a DB dump/leak doesn't hand over live API keys in
// plaintext. Uses AES-256-GCM with a key derived from PROVIDER_ENCRYPTION_KEY
// (falls back to JWT_SECRET so a fresh install works with zero extra config
// — set PROVIDER_ENCRYPTION_KEY explicitly in production for a key that's
// independent from the JWT signing secret).
const SECRET = process.env.PROVIDER_ENCRYPTION_KEY || process.env.JWT_SECRET || "dev-only-insecure-secret";
const KEY = scryptSync(SECRET, "ai-provider-key-salt", 32);

// Stored format: "<ivHex>:<authTagHex>:<ciphertextHex>" — self-contained,
// no separate column needed for the IV/tag.
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptSecret(stored: string): string {
  const [ivHex, authTagHex, ciphertextHex] = stored.split(":");
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error("Malformed encrypted secret");
  }
  const decipher = createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

// For display only — never send the real key back to the client. Shows
// just enough to let an admin recognize which key is configured.
export function maskSecret(plaintext: string): string {
  if (plaintext.length <= 8) return "••••••••";
  return `${plaintext.slice(0, 4)}${"•".repeat(6)}${plaintext.slice(-4)}`;
}
