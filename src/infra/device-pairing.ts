import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { StorageBackend } from "./storage-backend.js";
import { resolveStateDir } from "../config/paths.js";

export type DevicePairingPendingRequest = {
  requestId: string;
  deviceId: string;
  publicKey: string;
  displayName?: string;
  platform?: string;
  clientId?: string;
  clientMode?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  remoteIp?: string;
  silent?: boolean;
  isRepair?: boolean;
  ts: number;
};

export type DeviceAuthToken = {
  token: string;
  role: string;
  scopes: string[];
  createdAtMs: number;
  rotatedAtMs?: number;
  revokedAtMs?: number;
  lastUsedAtMs?: number;
};

export type DeviceAuthTokenSummary = {
  role: string;
  scopes: string[];
  createdAtMs: number;
  rotatedAtMs?: number;
  revokedAtMs?: number;
  lastUsedAtMs?: number;
};

export type PairedDevice = {
  deviceId: string;
  publicKey: string;
  displayName?: string;
  platform?: string;
  clientId?: string;
  clientMode?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  remoteIp?: string;
  tokens?: Record<string, DeviceAuthToken>;
  createdAtMs: number;
  approvedAtMs: number;
};

export type DevicePairingList = {
  pending: DevicePairingPendingRequest[];
  paired: PairedDevice[];
};

type DevicePairingStateFile = {
  pendingById: Record<string, DevicePairingPendingRequest>;
  pairedByDeviceId: Record<string, PairedDevice>;
};

const PENDING_TTL_MS = 5 * 60 * 1000;

function resolvePaths(baseDir?: string) {
  const root = baseDir ?? resolveStateDir();
  const dir = path.join(root, "devices");
  return {
    dir,
    pendingPath: path.join(dir, "pending.json"),
    pairedPath: path.join(dir, "paired.json"),
  };
}

async function readJSON<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJSONAtomic(filePath: string, value: unknown) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  try {
    await fs.chmod(tmp, 0o600);
  } catch {
    // best-effort
  }
  await fs.rename(tmp, filePath);
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // best-effort
  }
}

function pruneExpiredPending(
  pendingById: Record<string, DevicePairingPendingRequest>,
  nowMs: number,
) {
  for (const [id, req] of Object.entries(pendingById)) {
    if (nowMs - req.ts > PENDING_TTL_MS) {
      delete pendingById[id];
    }
  }
}

// ── Storage-backed helpers ────────────────────────────────────────────────────

async function loadStateFromStorage(storage: StorageBackend): Promise<DevicePairingStateFile> {
  const [pendingRaw, pairedRaw] = await Promise.all([
    storage.hgetall("pair:pending"),
    storage.hgetall("pair:devices"),
  ]);
  const pendingById: Record<string, DevicePairingPendingRequest> = {};
  if (pendingRaw) {
    for (const [id, json] of Object.entries(pendingRaw)) {
      pendingById[id] = JSON.parse(json);
    }
  }
  const pairedByDeviceId: Record<string, PairedDevice> = {};
  if (pairedRaw) {
    for (const [id, json] of Object.entries(pairedRaw)) {
      pairedByDeviceId[id] = JSON.parse(json);
    }
  }
  // Defense in depth — TTL should handle expiry but prune anyway
  pruneExpiredPending(pendingById, Date.now());
  return { pendingById, pairedByDeviceId };
}

async function persistStateToStorage(
  state: DevicePairingStateFile,
  storage: StorageBackend,
): Promise<void> {
  // Pending: clear and re-set hash
  const pendingData: Record<string, string> = {};
  for (const [id, req] of Object.entries(state.pendingById)) {
    pendingData[id] = JSON.stringify(req);
  }
  await storage.delete("pair:pending");
  if (Object.keys(pendingData).length > 0) {
    await storage.hmset("pair:pending", pendingData);
  }
  // Paired: clear and re-set hash
  const pairedData: Record<string, string> = {};
  for (const [id, device] of Object.entries(state.pairedByDeviceId)) {
    pairedData[id] = JSON.stringify(device);
  }
  await storage.delete("pair:devices");
  if (Object.keys(pairedData).length > 0) {
    await storage.hmset("pair:devices", pairedData);
  }
}

// ── Locking ──────────────────────────────────────────────────────────────────

let lock: Promise<void> = Promise.resolve();
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = lock;
  let release: (() => void) | undefined;
  lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release?.();
  }
}

async function withStorageLock<T>(fn: () => Promise<T>, storage?: StorageBackend): Promise<T> {
  if (storage) {
    return storage.withLock("pair:state", fn);
  }
  return withLock(fn);
}

async function loadState(
  baseDir?: string,
  storage?: StorageBackend,
): Promise<DevicePairingStateFile> {
  if (storage) {
    return loadStateFromStorage(storage);
  }
  const { pendingPath, pairedPath } = resolvePaths(baseDir);
  const [pending, paired] = await Promise.all([
    readJSON<Record<string, DevicePairingPendingRequest>>(pendingPath),
    readJSON<Record<string, PairedDevice>>(pairedPath),
  ]);
  const state: DevicePairingStateFile = {
    pendingById: pending ?? {},
    pairedByDeviceId: paired ?? {},
  };
  pruneExpiredPending(state.pendingById, Date.now());
  return state;
}

async function persistState(
  state: DevicePairingStateFile,
  baseDir?: string,
  storage?: StorageBackend,
) {
  if (storage) {
    return persistStateToStorage(state, storage);
  }
  const { pendingPath, pairedPath } = resolvePaths(baseDir);
  await Promise.all([
    writeJSONAtomic(pendingPath, state.pendingById),
    writeJSONAtomic(pairedPath, state.pairedByDeviceId),
  ]);
}

function normalizeDeviceId(deviceId: string) {
  return deviceId.trim();
}

function normalizeRole(role: string | undefined): string | null {
  const trimmed = role?.trim();
  return trimmed ? trimmed : null;
}

function mergeRoles(...items: Array<string | string[] | undefined>): string[] | undefined {
  const roles = new Set<string>();
  for (const item of items) {
    if (!item) {
      continue;
    }
    if (Array.isArray(item)) {
      for (const role of item) {
        const trimmed = role.trim();
        if (trimmed) {
          roles.add(trimmed);
        }
      }
    } else {
      const trimmed = item.trim();
      if (trimmed) {
        roles.add(trimmed);
      }
    }
  }
  if (roles.size === 0) {
    return undefined;
  }
  return [...roles];
}

function mergeScopes(...items: Array<string[] | undefined>): string[] | undefined {
  const scopes = new Set<string>();
  for (const item of items) {
    if (!item) {
      continue;
    }
    for (const scope of item) {
      const trimmed = scope.trim();
      if (trimmed) {
        scopes.add(trimmed);
      }
    }
  }
  if (scopes.size === 0) {
    return undefined;
  }
  return [...scopes];
}

function normalizeScopes(scopes: string[] | undefined): string[] {
  if (!Array.isArray(scopes)) {
    return [];
  }
  const out = new Set<string>();
  for (const scope of scopes) {
    const trimmed = scope.trim();
    if (trimmed) {
      out.add(trimmed);
    }
  }
  return [...out].toSorted();
}

function scopesAllow(requested: string[], allowed: string[]): boolean {
  if (requested.length === 0) {
    return true;
  }
  if (allowed.length === 0) {
    return false;
  }
  const allowedSet = new Set(allowed);
  return requested.every((scope) => allowedSet.has(scope));
}

function newToken() {
  return randomUUID().replaceAll("-", "");
}

export async function listDevicePairing(
  baseDir?: string,
  storage?: StorageBackend,
): Promise<DevicePairingList> {
  const state = await loadState(baseDir, storage);
  const pending = Object.values(state.pendingById).toSorted((a, b) => b.ts - a.ts);
  const paired = Object.values(state.pairedByDeviceId).toSorted(
    (a, b) => b.approvedAtMs - a.approvedAtMs,
  );
  return { pending, paired };
}

export async function getPairedDevice(
  deviceId: string,
  baseDir?: string,
  storage?: StorageBackend,
): Promise<PairedDevice | null> {
  const state = await loadState(baseDir, storage);
  return state.pairedByDeviceId[normalizeDeviceId(deviceId)] ?? null;
}

export async function requestDevicePairing(
  req: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">,
  baseDir?: string,
  storage?: StorageBackend,
): Promise<{
  status: "pending";
  request: DevicePairingPendingRequest;
  created: boolean;
}> {
  return await withStorageLock(async () => {
    const state = await loadState(baseDir, storage);
    const deviceId = normalizeDeviceId(req.deviceId);
    if (!deviceId) {
      throw new Error("deviceId required");
    }
    const existing = Object.values(state.pendingById).find((p) => p.deviceId === deviceId);
    if (existing) {
      return { status: "pending", request: existing, created: false };
    }
    const isRepair = Boolean(state.pairedByDeviceId[deviceId]);
    const request: DevicePairingPendingRequest = {
      requestId: randomUUID(),
      deviceId,
      publicKey: req.publicKey,
      displayName: req.displayName,
      platform: req.platform,
      clientId: req.clientId,
      clientMode: req.clientMode,
      role: req.role,
      roles: req.role ? [req.role] : undefined,
      scopes: req.scopes,
      remoteIp: req.remoteIp,
      silent: req.silent,
      isRepair,
      ts: Date.now(),
    };
    state.pendingById[request.requestId] = request;
    await persistState(state, baseDir, storage);
    return { status: "pending", request, created: true };
  }, storage);
}

export async function approveDevicePairing(
  requestId: string,
  baseDir?: string,
  storage?: StorageBackend,
): Promise<{ requestId: string; device: PairedDevice } | null> {
  return await withStorageLock(async () => {
    const state = await loadState(baseDir, storage);
    const pending = state.pendingById[requestId];
    if (!pending) {
      return null;
    }
    const now = Date.now();
    const existing = state.pairedByDeviceId[pending.deviceId];
    const roles = mergeRoles(existing?.roles, existing?.role, pending.roles, pending.role);
    const scopes = mergeScopes(existing?.scopes, pending.scopes);
    const tokens = existing?.tokens ? { ...existing.tokens } : {};
    const roleForToken = normalizeRole(pending.role);
    if (roleForToken) {
      const nextScopes = normalizeScopes(pending.scopes);
      const existingToken = tokens[roleForToken];
      const now = Date.now();
      tokens[roleForToken] = {
        token: newToken(),
        role: roleForToken,
        scopes: nextScopes,
        createdAtMs: existingToken?.createdAtMs ?? now,
        rotatedAtMs: existingToken ? now : undefined,
        revokedAtMs: undefined,
        lastUsedAtMs: existingToken?.lastUsedAtMs,
      };
    }
    const device: PairedDevice = {
      deviceId: pending.deviceId,
      publicKey: pending.publicKey,
      displayName: pending.displayName,
      platform: pending.platform,
      clientId: pending.clientId,
      clientMode: pending.clientMode,
      role: pending.role,
      roles,
      scopes,
      remoteIp: pending.remoteIp,
      tokens,
      createdAtMs: existing?.createdAtMs ?? now,
      approvedAtMs: now,
    };
    delete state.pendingById[requestId];
    state.pairedByDeviceId[device.deviceId] = device;
    await persistState(state, baseDir, storage);
    return { requestId, device };
  }, storage);
}

export async function rejectDevicePairing(
  requestId: string,
  baseDir?: string,
  storage?: StorageBackend,
): Promise<{ requestId: string; deviceId: string } | null> {
  return await withStorageLock(async () => {
    const state = await loadState(baseDir, storage);
    const pending = state.pendingById[requestId];
    if (!pending) {
      return null;
    }
    delete state.pendingById[requestId];
    await persistState(state, baseDir, storage);
    return { requestId, deviceId: pending.deviceId };
  }, storage);
}

export async function updatePairedDeviceMetadata(
  deviceId: string,
  patch: Partial<Omit<PairedDevice, "deviceId" | "createdAtMs" | "approvedAtMs">>,
  baseDir?: string,
  storage?: StorageBackend,
): Promise<void> {
  return await withStorageLock(async () => {
    const state = await loadState(baseDir, storage);
    const existing = state.pairedByDeviceId[normalizeDeviceId(deviceId)];
    if (!existing) {
      return;
    }
    const roles = mergeRoles(existing.roles, existing.role, patch.role);
    const scopes = mergeScopes(existing.scopes, patch.scopes);
    state.pairedByDeviceId[deviceId] = {
      ...existing,
      ...patch,
      deviceId: existing.deviceId,
      createdAtMs: existing.createdAtMs,
      approvedAtMs: existing.approvedAtMs,
      role: patch.role ?? existing.role,
      roles,
      scopes,
    };
    await persistState(state, baseDir, storage);
  }, storage);
}

export function summarizeDeviceTokens(
  tokens: Record<string, DeviceAuthToken> | undefined,
): DeviceAuthTokenSummary[] | undefined {
  if (!tokens) {
    return undefined;
  }
  const summaries = Object.values(tokens)
    .map((token) => ({
      role: token.role,
      scopes: token.scopes,
      createdAtMs: token.createdAtMs,
      rotatedAtMs: token.rotatedAtMs,
      revokedAtMs: token.revokedAtMs,
      lastUsedAtMs: token.lastUsedAtMs,
    }))
    .toSorted((a, b) => a.role.localeCompare(b.role));
  return summaries.length > 0 ? summaries : undefined;
}

export async function verifyDeviceToken(params: {
  deviceId: string;
  token: string;
  role: string;
  scopes: string[];
  baseDir?: string;
  storage?: StorageBackend;
}): Promise<{ ok: boolean; reason?: string }> {
  return await withStorageLock(async () => {
    const state = await loadState(params.baseDir, params.storage);
    const device = state.pairedByDeviceId[normalizeDeviceId(params.deviceId)];
    if (!device) {
      return { ok: false, reason: "device-not-paired" };
    }
    const role = normalizeRole(params.role);
    if (!role) {
      return { ok: false, reason: "role-missing" };
    }
    const entry = device.tokens?.[role];
    if (!entry) {
      return { ok: false, reason: "token-missing" };
    }
    if (entry.revokedAtMs) {
      return { ok: false, reason: "token-revoked" };
    }
    if (entry.token !== params.token) {
      return { ok: false, reason: "token-mismatch" };
    }
    const requestedScopes = normalizeScopes(params.scopes);
    if (!scopesAllow(requestedScopes, entry.scopes)) {
      return { ok: false, reason: "scope-mismatch" };
    }
    entry.lastUsedAtMs = Date.now();
    device.tokens ??= {};
    device.tokens[role] = entry;
    state.pairedByDeviceId[device.deviceId] = device;
    await persistState(state, params.baseDir, params.storage);
    return { ok: true };
  }, params.storage);
}

export async function ensureDeviceToken(params: {
  deviceId: string;
  role: string;
  scopes: string[];
  baseDir?: string;
  storage?: StorageBackend;
}): Promise<DeviceAuthToken | null> {
  return await withStorageLock(async () => {
    const state = await loadState(params.baseDir, params.storage);
    const device = state.pairedByDeviceId[normalizeDeviceId(params.deviceId)];
    if (!device) {
      return null;
    }
    const role = normalizeRole(params.role);
    if (!role) {
      return null;
    }
    const requestedScopes = normalizeScopes(params.scopes);
    const tokens = device.tokens ? { ...device.tokens } : {};
    const existing = tokens[role];
    if (existing && !existing.revokedAtMs) {
      if (scopesAllow(requestedScopes, existing.scopes)) {
        return existing;
      }
    }
    const now = Date.now();
    const next: DeviceAuthToken = {
      token: newToken(),
      role,
      scopes: requestedScopes,
      createdAtMs: existing?.createdAtMs ?? now,
      rotatedAtMs: existing ? now : undefined,
      revokedAtMs: undefined,
      lastUsedAtMs: existing?.lastUsedAtMs,
    };
    tokens[role] = next;
    device.tokens = tokens;
    state.pairedByDeviceId[device.deviceId] = device;
    await persistState(state, params.baseDir, params.storage);
    return next;
  }, params.storage);
}

export async function rotateDeviceToken(params: {
  deviceId: string;
  role: string;
  scopes?: string[];
  baseDir?: string;
  storage?: StorageBackend;
}): Promise<DeviceAuthToken | null> {
  return await withStorageLock(async () => {
    const state = await loadState(params.baseDir, params.storage);
    const device = state.pairedByDeviceId[normalizeDeviceId(params.deviceId)];
    if (!device) {
      return null;
    }
    const role = normalizeRole(params.role);
    if (!role) {
      return null;
    }
    const tokens = device.tokens ? { ...device.tokens } : {};
    const existing = tokens[role];
    const requestedScopes = normalizeScopes(params.scopes ?? existing?.scopes ?? device.scopes);
    const now = Date.now();
    const next: DeviceAuthToken = {
      token: newToken(),
      role,
      scopes: requestedScopes,
      createdAtMs: existing?.createdAtMs ?? now,
      rotatedAtMs: now,
      revokedAtMs: undefined,
      lastUsedAtMs: existing?.lastUsedAtMs,
    };
    tokens[role] = next;
    device.tokens = tokens;
    if (params.scopes !== undefined) {
      device.scopes = requestedScopes;
    }
    state.pairedByDeviceId[device.deviceId] = device;
    await persistState(state, params.baseDir, params.storage);
    return next;
  }, params.storage);
}

export async function revokeDeviceToken(params: {
  deviceId: string;
  role: string;
  baseDir?: string;
  storage?: StorageBackend;
}): Promise<DeviceAuthToken | null> {
  return await withStorageLock(async () => {
    const state = await loadState(params.baseDir, params.storage);
    const device = state.pairedByDeviceId[normalizeDeviceId(params.deviceId)];
    if (!device) {
      return null;
    }
    const role = normalizeRole(params.role);
    if (!role) {
      return null;
    }
    if (!device.tokens?.[role]) {
      return null;
    }
    const tokens = { ...device.tokens };
    const entry = { ...tokens[role], revokedAtMs: Date.now() };
    tokens[role] = entry;
    device.tokens = tokens;
    state.pairedByDeviceId[device.deviceId] = device;
    await persistState(state, params.baseDir, params.storage);
    return entry;
  }, params.storage);
}
