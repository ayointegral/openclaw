import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StorageBackend } from "../infra/storage-backend.js";
import { resolveStateDir } from "../config/paths.js";

const STORE_VERSION = 1;

type TelegramUpdateOffsetState = {
  version: number;
  lastUpdateId: number | null;
};

function normalizeAccountId(accountId?: string) {
  const trimmed = accountId?.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}

function redisKey(accountId?: string): string {
  return `tg:offset:${normalizeAccountId(accountId)}`;
}

function resolveTelegramUpdateOffsetPath(
  accountId?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const stateDir = resolveStateDir(env, os.homedir);
  const normalized = normalizeAccountId(accountId);
  return path.join(stateDir, "telegram", `update-offset-${normalized}.json`);
}

function safeParseState(raw: string): TelegramUpdateOffsetState | null {
  try {
    const parsed = JSON.parse(raw) as TelegramUpdateOffsetState;
    if (parsed?.version !== STORE_VERSION) {
      return null;
    }
    if (parsed.lastUpdateId !== null && typeof parsed.lastUpdateId !== "number") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function readTelegramUpdateOffset(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
  storage?: StorageBackend;
}): Promise<number | null> {
  // Storage backend path (Redis or other)
  if (params.storage) {
    const raw = await params.storage.get(redisKey(params.accountId));
    if (raw === null) {
      return null;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  // Original filesystem path
  const filePath = resolveTelegramUpdateOffsetPath(params.accountId, params.env);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = safeParseState(raw);
    return parsed?.lastUpdateId ?? null;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return null;
    }
    return null;
  }
}

export async function writeTelegramUpdateOffset(params: {
  accountId?: string;
  updateId: number;
  env?: NodeJS.ProcessEnv;
  storage?: StorageBackend;
}): Promise<void> {
  // Storage backend path (Redis or other)
  if (params.storage) {
    await params.storage.set(redisKey(params.accountId), String(params.updateId));
    return;
  }

  // Original filesystem path
  const filePath = resolveTelegramUpdateOffsetPath(params.accountId, params.env);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  const payload: TelegramUpdateOffsetState = {
    version: STORE_VERSION,
    lastUpdateId: params.updateId,
  };
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf-8",
  });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, filePath);
}
