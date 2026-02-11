import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsStorageBackend } from "../infra/storage-backend.js";
import { readTelegramUpdateOffset, writeTelegramUpdateOffset } from "./update-offset-store.js";

let tmpDir: string;
let storage: FsStorageBackend;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tg-offset-"));
  storage = new FsStorageBackend(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("telegram update offset store (storage backend)", () => {
  it("write + read round-trip returns the written offset", async () => {
    await writeTelegramUpdateOffset({ updateId: 12345, storage });
    const result = await readTelegramUpdateOffset({ storage });
    expect(result).toBe(12345);
  });

  it("read non-existent key returns null", async () => {
    const result = await readTelegramUpdateOffset({ storage });
    expect(result).toBeNull();
  });

  it("write overwrites previous value", async () => {
    await writeTelegramUpdateOffset({ updateId: 100, storage });
    await writeTelegramUpdateOffset({ updateId: 200, storage });
    const result = await readTelegramUpdateOffset({ storage });
    expect(result).toBe(200);
  });

  it("different accounts are isolated", async () => {
    await writeTelegramUpdateOffset({ accountId: "acc1", updateId: 111, storage });
    await writeTelegramUpdateOffset({ accountId: "acc2", updateId: 222, storage });

    expect(await readTelegramUpdateOffset({ accountId: "acc1", storage })).toBe(111);
    expect(await readTelegramUpdateOffset({ accountId: "acc2", storage })).toBe(222);
  });

  it("without storage falls back to filesystem via env", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tg-fs-"));
    try {
      const env = { OPENCLAW_STATE_DIR: stateDir, HOME: os.homedir() };
      await writeTelegramUpdateOffset({ updateId: 999, env });
      const result = await readTelegramUpdateOffset({ env });
      expect(result).toBe(999);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
