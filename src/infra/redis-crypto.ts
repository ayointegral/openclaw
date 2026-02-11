import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // GCM recommended nonce size
const TAG_BYTES = 16; // GCM auth tag length
const PREFIX = "enc:v1:";
const KEY_HEX_LEN = 64; // 256-bit key = 64 hex chars

// ── Key resolution ──────────────────────────────────────────────────────────

export function resolveEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env.OPENCLAW_REDIS_ENC_KEY;
  if (!raw) {
    return null;
  }
  if (!/^[0-9a-f]{64}$/i.test(raw)) {
    throw new Error(
      `OPENCLAW_REDIS_ENC_KEY must be a ${KEY_HEX_LEN}-char hex string (got ${raw.length} chars)`,
    );
  }
  return Buffer.from(raw, "hex");
}

// ── Encrypt ─────────────────────────────────────────────────────────────────

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Layout: iv (12) + ciphertext (variable) + authTag (16)
  const payload = Buffer.concat([iv, encrypted, tag]);
  return PREFIX + payload.toString("base64");
}

// ── Decrypt ─────────────────────────────────────────────────────────────────

export function decrypt(encrypted: string, key: Buffer): string {
  if (!encrypted.startsWith(PREFIX)) {
    throw new Error(`Unknown encryption prefix (expected "${PREFIX}")`);
  }
  const payload = Buffer.from(encrypted.slice(PREFIX.length), "base64");
  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(payload.length - TAG_BYTES);
  const ciphertext = payload.subarray(IV_BYTES, payload.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final("utf8");
}

// ── Guard ───────────────────────────────────────────────────────────────────

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}
