import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt, isEncrypted, resolveEncryptionKey } from "./redis-crypto.js";

const validHexKey = "a".repeat(64);
const testKey = randomBytes(32);

describe("resolveEncryptionKey", () => {
  it("returns null when env var is not set", () => {
    expect(resolveEncryptionKey({})).toBeNull();
  });

  it("returns null when env var is empty string", () => {
    expect(resolveEncryptionKey({ OPENCLAW_REDIS_ENC_KEY: "" })).toBeNull();
  });

  it("returns a 32-byte Buffer for a valid 64-char hex key", () => {
    const key = resolveEncryptionKey({ OPENCLAW_REDIS_ENC_KEY: validHexKey });
    expect(key).toBeInstanceOf(Buffer);
    expect(key!.length).toBe(32);
  });

  it("accepts uppercase hex", () => {
    const key = resolveEncryptionKey({ OPENCLAW_REDIS_ENC_KEY: "A".repeat(64) });
    expect(key).toBeInstanceOf(Buffer);
    expect(key!.length).toBe(32);
  });

  it("throws for a key that is too short", () => {
    expect(() => resolveEncryptionKey({ OPENCLAW_REDIS_ENC_KEY: "abcd" })).toThrow(
      /must be a 64-char hex string/,
    );
  });

  it("throws for a key that is too long", () => {
    expect(() => resolveEncryptionKey({ OPENCLAW_REDIS_ENC_KEY: "a".repeat(128) })).toThrow(
      /must be a 64-char hex string/,
    );
  });

  it("throws for non-hex characters", () => {
    expect(() => resolveEncryptionKey({ OPENCLAW_REDIS_ENC_KEY: "g".repeat(64) })).toThrow(
      /must be a 64-char hex string/,
    );
  });
});

describe("encrypt + decrypt round-trip", () => {
  it("round-trips a normal string", () => {
    const plain = "hello world";
    expect(decrypt(encrypt(plain, testKey), testKey)).toBe(plain);
  });

  it("output starts with enc:v1: prefix", () => {
    expect(encrypt("test", testKey).startsWith("enc:v1:")).toBe(true);
  });

  it("produces different ciphertexts for the same plaintext (random IV)", () => {
    const a = encrypt("same", testKey);
    const b = encrypt("same", testKey);
    expect(a).not.toBe(b);
  });

  it("round-trips an empty string", () => {
    expect(decrypt(encrypt("", testKey), testKey)).toBe("");
  });

  it("round-trips unicode text", () => {
    const unicode = "こんにちは 🌍 café";
    expect(decrypt(encrypt(unicode, testKey), testKey)).toBe(unicode);
  });
});

describe("decrypt error cases", () => {
  it("throws with a wrong key", () => {
    const encrypted = encrypt("secret", testKey);
    const wrongKey = randomBytes(32);
    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  it("throws with mangled ciphertext", () => {
    const encrypted = encrypt("secret", testKey);
    const mangled = encrypted.slice(0, -4) + "ZZZZ";
    expect(() => decrypt(mangled, testKey)).toThrow();
  });

  it("throws when prefix is missing", () => {
    expect(() => decrypt("not-encrypted-data", testKey)).toThrow(/Unknown encryption prefix/);
  });
});

describe("isEncrypted", () => {
  it("returns true for enc:v1: prefixed value", () => {
    expect(isEncrypted("enc:v1:somebase64data")).toBe(true);
  });

  it("returns true for actual encrypted output", () => {
    expect(isEncrypted(encrypt("test", testKey))).toBe(true);
  });

  it("returns false for plain text", () => {
    expect(isEncrypted("hello world")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isEncrypted("")).toBe(false);
  });
});
