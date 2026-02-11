import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "./types.js";
import { FsStorageBackend } from "../../infra/storage-backend.js";
import {
  capEntryCount,
  loadSessionStoreAsync,
  pruneStaleEntries,
  saveSessionStore,
  updateSessionStore,
  updateSessionStoreEntry,
} from "./store.js";

let tmpDir: string;
let storage: FsStorageBackend;
let storePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-store-test-"));
  // Pre-create lock parent so FsStorageBackend.withLock (recursive:false mkdir) works
  fs.mkdirSync(path.join(tmpDir, ".locks", "sess", "store"), { recursive: true });
  storage = new FsStorageBackend(tmpDir);
  storePath = path.join(tmpDir, "sessions.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function entry(id: string, updatedAt?: number): SessionEntry {
  return { sessionId: id, updatedAt: updatedAt ?? Date.now() };
}

// ── loadSessionStoreAsync + saveSessionStore ─────────────────────────────────

describe("loadSessionStoreAsync + saveSessionStore (storage backend)", () => {
  it("round-trips a store with 2 entries", async () => {
    const store: Record<string, SessionEntry> = {
      a: entry("sess-1"),
      b: entry("sess-2"),
    };
    await saveSessionStore(storePath, store, { storage, skipMaintenance: true });
    const loaded = await loadSessionStoreAsync(storePath, { storage });
    expect(Object.keys(loaded)).toHaveLength(2);
    expect(loaded.a.sessionId).toBe("sess-1");
    expect(loaded.b.sessionId).toBe("sess-2");
  });

  it("returns empty object when nothing saved", async () => {
    const loaded = await loadSessionStoreAsync(storePath, { storage });
    expect(loaded).toEqual({});
  });

  it("overwrites previous store on second save", async () => {
    const storeA: Record<string, SessionEntry> = { x: entry("old") };
    const storeB: Record<string, SessionEntry> = { y: entry("new") };
    await saveSessionStore(storePath, storeA, { storage, skipMaintenance: true });
    await saveSessionStore(storePath, storeB, { storage, skipMaintenance: true });
    const loaded = await loadSessionStoreAsync(storePath, { storage });
    expect(loaded.x).toBeUndefined();
    expect(loaded.y.sessionId).toBe("new");
  });
});

// ── updateSessionStore ───────────────────────────────────────────────────────

describe("updateSessionStore (storage backend)", () => {
  it("mutator receives current store and changes persist", async () => {
    const initial: Record<string, SessionEntry> = { k: entry("sess-k") };
    await saveSessionStore(storePath, initial, { storage, skipMaintenance: true });

    await updateSessionStore(
      storePath,
      (store) => {
        expect(store.k.sessionId).toBe("sess-k");
        store.k2 = entry("sess-k2");
      },
      { storage, skipMaintenance: true },
    );

    const loaded = await loadSessionStoreAsync(storePath, { storage });
    expect(loaded.k2.sessionId).toBe("sess-k2");
  });

  it("returns the mutator return value", async () => {
    const result = await updateSessionStore(storePath, () => 42, {
      storage,
      skipMaintenance: true,
    });
    expect(result).toBe(42);
  });
});

// ── updateSessionStoreEntry ──────────────────────────────────────────────────

describe("updateSessionStoreEntry (storage backend)", () => {
  it("updates an existing entry", async () => {
    const initial: Record<string, SessionEntry> = { s1: entry("sess-s1") };
    await saveSessionStore(storePath, initial, { storage, skipMaintenance: true });

    const result = await updateSessionStoreEntry({
      storePath,
      sessionKey: "s1",
      update: async () => ({ label: "updated" }),
      storage,
    });

    expect(result).not.toBeNull();
    expect(result!.label).toBe("updated");

    const loaded = await loadSessionStoreAsync(storePath, { storage });
    expect(loaded.s1.label).toBe("updated");
  });

  it("returns null for non-existent entry", async () => {
    const result = await updateSessionStoreEntry({
      storePath,
      sessionKey: "missing",
      update: async () => ({ label: "nope" }),
      storage,
    });
    expect(result).toBeNull();
  });

  it("null patch leaves entry unchanged", async () => {
    const now = Date.now();
    const initial: Record<string, SessionEntry> = {
      s1: { sessionId: "sess-s1", updatedAt: now, label: "original" },
    };
    await saveSessionStore(storePath, initial, { storage, skipMaintenance: true });

    const result = await updateSessionStoreEntry({
      storePath,
      sessionKey: "s1",
      update: async () => null,
      storage,
    });

    expect(result).not.toBeNull();
    expect(result!.label).toBe("original");
  });
});

// ── Maintenance: pruneStaleEntries & capEntryCount ───────────────────────────

describe("pruneStaleEntries (pure function)", () => {
  it("removes entries older than the threshold", () => {
    const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const store: Record<string, SessionEntry> = {
      old: entry("old", sixtyDaysAgo),
      fresh: entry("fresh"),
    };

    const pruned = pruneStaleEntries(store, 30 * 24 * 60 * 60 * 1000, { log: false });

    expect(pruned).toBe(1);
    expect(store.old).toBeUndefined();
    expect(store.fresh).toBeDefined();
  });
});

describe("capEntryCount (pure function)", () => {
  it("caps to the specified max, keeping most recent", () => {
    const store: Record<string, SessionEntry> = {};
    const now = Date.now();
    for (let i = 0; i < 600; i++) {
      store[`s${i}`] = entry(`id-${i}`, now - (600 - i) * 1000);
    }

    const removed = capEntryCount(store, 500, { log: false });

    expect(removed).toBe(100);
    expect(Object.keys(store)).toHaveLength(500);
    // Oldest entries (s0..s99) should be gone; newest (s100..s599) kept
    expect(store.s0).toBeUndefined();
    expect(store.s599).toBeDefined();
  });
});
