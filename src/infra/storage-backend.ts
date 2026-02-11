import type { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ── Interface ────────────────────────────────────────────────────────────────

export interface LockOptions {
  timeoutMs?: number; // max wait to acquire lock, default 10000
  ttlMs?: number; // lock auto-expire, default 30000
}

export interface StorageBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { ttlMs?: number }): Promise<void>;
  delete(key: string): Promise<boolean>;
  exists(key: string): Promise<boolean>;
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<void>;
  hmset(key: string, data: Record<string, string>): Promise<void>;
  hgetall(key: string): Promise<Record<string, string> | null>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  append(key: string, value: string): Promise<string>;
  range(
    key: string,
    start: string,
    end: string,
    count?: number,
  ): Promise<Array<{ id: string; data: Record<string, string> }>>;
  trim(key: string, maxLen: number): Promise<void>;
  zadd(key: string, score: number, member: string): Promise<void>;
  zrangebyscore(key: string, min: number, max: number, limit?: number): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  srem(key: string, ...members: string[]): Promise<number>;
  withLock<T>(key: string, fn: () => Promise<T>, opts?: LockOptions): Promise<T>;
  isReady(): boolean;
  close(): Promise<void>;
}

// ── Redis implementation ─────────────────────────────────────────────────────

// Lua: delete key only if value matches (compare-and-delete)
const LUA_CAD = `if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;

export class RedisStorageBackend implements StorageBackend {
  constructor(private readonly client: Redis) {}

  async get(key: string) {
    return this.client.get(key);
  }
  async set(key: string, value: string, opts?: { ttlMs?: number }) {
    if (opts?.ttlMs) {
      await this.client.set(key, value, "PX", opts.ttlMs);
    } else {
      await this.client.set(key, value);
    }
  }
  async delete(key: string) {
    return (await this.client.del(key)) > 0;
  }
  async exists(key: string) {
    return (await this.client.exists(key)) > 0;
  }

  async hget(key: string, field: string) {
    return this.client.hget(key, field);
  }
  async hset(key: string, field: string, value: string) {
    await this.client.hset(key, field, value);
  }
  async hmset(key: string, data: Record<string, string>) {
    await this.client.hmset(key, data);
  }
  async hgetall(key: string) {
    const r = await this.client.hgetall(key);
    return Object.keys(r).length === 0 ? null : r;
  }
  async hdel(key: string, ...fields: string[]) {
    return this.client.hdel(key, ...fields);
  }

  async append(key: string, value: string) {
    const id = await this.client.xadd(key, "*", "data", value);
    if (!id) {
      throw new Error(`XADD returned null for key "${key}"`);
    }
    return id;
  }
  async range(key: string, start: string, end: string, count?: number) {
    const raw =
      count !== undefined
        ? await this.client.xrange(key, start, end, "COUNT", count)
        : await this.client.xrange(key, start, end);
    return raw.map(([id, fields]) => {
      const data: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        data[fields[i]] = fields[i + 1];
      }
      return { id, data };
    });
  }
  async trim(key: string, maxLen: number) {
    await this.client.xtrim(key, "MAXLEN", "~", maxLen);
  }

  async zadd(key: string, score: number, member: string) {
    await this.client.zadd(key, score, member);
  }
  async zrangebyscore(key: string, min: number, max: number, limit?: number) {
    if (limit !== undefined) {
      return this.client.zrangebyscore(key, min, max, "LIMIT", 0, limit);
    }
    return this.client.zrangebyscore(key, min, max);
  }
  async zrem(key: string, ...members: string[]) {
    return this.client.zrem(key, ...members);
  }

  async sadd(key: string, ...members: string[]) {
    return this.client.sadd(key, ...members);
  }
  async smembers(key: string) {
    return this.client.smembers(key);
  }
  async srem(key: string, ...members: string[]) {
    return this.client.srem(key, ...members);
  }

  async withLock<T>(key: string, fn: () => Promise<T>, opts?: LockOptions): Promise<T> {
    const timeout = opts?.timeoutMs ?? 10_000;
    const ttl = opts?.ttlMs ?? 30_000;
    const lockKey = `lock:${key}`;
    const token = randomUUID();
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const ok = await this.client.set(lockKey, token, "PX", ttl, "NX");
      if (ok === "OK") {
        try {
          return await fn();
        } finally {
          await this.client.eval(LUA_CAD, 1, lockKey, token);
        }
      }
      await sleep(50);
    }
    throw new Error(`Failed to acquire lock "${key}" within ${timeout}ms`);
  }

  isReady() {
    return this.client.status === "ready";
  }
  async close() {
    /* client lifecycle managed externally */
  }
}

// ── Filesystem implementation ────────────────────────────────────────────────

type SortedEntry = { s: number; m: string };

export class FsStorageBackend implements StorageBackend {
  constructor(private readonly baseDir: string) {}

  private keyPath(key: string, ext = ".json") {
    return path.join(this.baseDir, key.replace(/:/g, "/") + ext);
  }
  private ensureDir(fp: string) {
    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }
  /** Atomic write: tmp → rename, chmod 0o600 */
  private atomicWrite(fp: string, content: string) {
    this.ensureDir(fp);
    const tmp = fp + ".tmp." + process.pid;
    fs.writeFileSync(tmp, content, "utf8");
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, fp);
  }
  private readText(fp: string): string | null {
    try {
      return fs.readFileSync(fp, "utf8");
    } catch {
      return null;
    }
  }
  private readJson(fp: string): Record<string, string> | null {
    const raw = this.readText(fp);
    return raw === null ? null : (JSON.parse(raw) as Record<string, string>);
  }

  // Key-value
  async get(key: string) {
    const obj = this.readJson(this.keyPath(key));
    return obj?.["_value"] ?? null;
  }
  async set(key: string, value: string) {
    this.atomicWrite(this.keyPath(key), JSON.stringify({ _value: value }));
  }
  async delete(key: string) {
    try {
      await fs.promises.unlink(this.keyPath(key));
      return true;
    } catch {
      return false;
    }
  }
  async exists(key: string) {
    return fs.existsSync(this.keyPath(key));
  }

  // Hash
  async hget(key: string, field: string) {
    return this.readJson(this.keyPath(key))?.[field] ?? null;
  }
  async hset(key: string, field: string, value: string) {
    const obj = this.readJson(this.keyPath(key)) ?? {};
    obj[field] = value;
    this.atomicWrite(this.keyPath(key), JSON.stringify(obj));
  }
  async hmset(key: string, data: Record<string, string>) {
    const obj = this.readJson(this.keyPath(key)) ?? {};
    Object.assign(obj, data);
    this.atomicWrite(this.keyPath(key), JSON.stringify(obj));
  }
  async hgetall(key: string) {
    return this.readJson(this.keyPath(key));
  }
  async hdel(key: string, ...fields: string[]) {
    const obj = this.readJson(this.keyPath(key));
    if (!obj) {
      return 0;
    }
    let n = 0;
    for (const f of fields) {
      if (f in obj) {
        delete obj[f];
        n++;
      }
    }
    this.atomicWrite(this.keyPath(key), JSON.stringify(obj));
    return n;
  }

  // Stream (JSONL)
  async append(key: string, value: string) {
    const fp = this.keyPath(key, ".jsonl");
    this.ensureDir(fp);
    const id = String(countLines(fp));
    fs.appendFileSync(fp, JSON.stringify({ id, data: value }) + "\n", "utf8");
    fs.chmodSync(fp, 0o600);
    return id;
  }
  async range(key: string, start: string, end: string, count?: number) {
    const raw = this.readText(this.keyPath(key, ".jsonl"));
    if (!raw) {
      return [];
    }
    const startN = start === "-" ? 0 : Number(start);
    const endN = end === "+" ? Infinity : Number(end);
    const out: Array<{ id: string; data: Record<string, string> }> = [];
    for (const line of raw.trim().split("\n")) {
      const p = JSON.parse(line) as { id: string; data: string };
      if (Number(p.id) >= startN && Number(p.id) <= endN) {
        out.push({ id: p.id, data: { data: p.data } });
        if (count !== undefined && out.length >= count) {
          break;
        }
      }
    }
    return out;
  }
  async trim(key: string, maxLen: number) {
    const fp = this.keyPath(key, ".jsonl");
    const raw = this.readText(fp);
    if (!raw) {
      return;
    }
    const lines = raw.trim().split("\n");
    if (lines.length <= maxLen) {
      return;
    }
    this.atomicWrite(fp, lines.slice(-maxLen).join("\n") + "\n");
  }

  // Sorted set
  async zadd(key: string, score: number, member: string) {
    const fp = this.keyPath(key);
    const arr = (this.readJson(fp) as unknown as SortedEntry[]) ?? [];
    const idx = arr.findIndex((e) => e.m === member);
    if (idx >= 0) {
      arr[idx].s = score;
    } else {
      arr.push({ s: score, m: member });
    }
    arr.sort((a, b) => a.s - b.s);
    this.atomicWrite(fp, JSON.stringify(arr));
  }
  async zrangebyscore(key: string, min: number, max: number, limit?: number) {
    const arr = (this.readJson(this.keyPath(key)) as unknown as SortedEntry[]) ?? [];
    const out: string[] = [];
    for (const e of arr) {
      if (e.s >= min && e.s <= max) {
        out.push(e.m);
        if (limit !== undefined && out.length >= limit) {
          break;
        }
      }
    }
    return out;
  }
  async zrem(key: string, ...members: string[]) {
    const fp = this.keyPath(key);
    const arr = (this.readJson(fp) as unknown as SortedEntry[]) ?? [];
    const set = new Set(members);
    const kept = arr.filter((e) => !set.has(e.m));
    this.atomicWrite(fp, JSON.stringify(kept));
    return arr.length - kept.length;
  }

  // Set
  async sadd(key: string, ...members: string[]) {
    const fp = this.keyPath(key);
    const arr = (this.readJson(fp) as unknown as string[]) ?? [];
    const existing = new Set(arr);
    let added = 0;
    for (const m of members) {
      if (!existing.has(m)) {
        arr.push(m);
        existing.add(m);
        added++;
      }
    }
    this.atomicWrite(fp, JSON.stringify(arr));
    return added;
  }
  async smembers(key: string) {
    return (this.readJson(this.keyPath(key)) as unknown as string[]) ?? [];
  }
  async srem(key: string, ...members: string[]) {
    const fp = this.keyPath(key);
    const arr = (this.readJson(fp) as unknown as string[]) ?? [];
    const set = new Set(members);
    const kept = arr.filter((m) => !set.has(m));
    this.atomicWrite(fp, JSON.stringify(kept));
    return arr.length - kept.length;
  }

  // Lock (mkdir-based atomic test-and-set)
  async withLock<T>(key: string, fn: () => Promise<T>, opts?: LockOptions): Promise<T> {
    const timeout = opts?.timeoutMs ?? 10_000;
    const ttl = opts?.ttlMs ?? 30_000;
    const lockDir = path.join(this.baseDir, ".locks", key.replace(/:/g, "/"));
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        fs.mkdirSync(lockDir, { recursive: false });
        fs.writeFileSync(path.join(lockDir, ".ts"), String(Date.now()));
        break;
      } catch {
        // Evict stale lock if older than ttl
        try {
          const tsFile = path.join(lockDir, ".ts");
          if (fs.existsSync(tsFile)) {
            const ts = Number(fs.readFileSync(tsFile, "utf8"));
            if (Date.now() - ts > ttl) {
              fs.rmSync(lockDir, { recursive: true, force: true });
              continue;
            }
          }
        } catch {
          /* ignore */
        }
        await sleep(50);
      }
    }
    if (!fs.existsSync(lockDir)) {
      throw new Error(`Failed to acquire lock "${key}" within ${timeout}ms`);
    }
    try {
      return await fn();
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  }

  isReady() {
    return true;
  }
  async close() {
    /* no-op */
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createStorageBackend(opts: {
  backend: "redis" | "fs";
  redisClient?: Redis | null;
  baseDir?: string;
}): StorageBackend {
  if (opts.backend === "redis" && opts.redisClient) {
    return new RedisStorageBackend(opts.redisClient);
  }
  if (!opts.baseDir) {
    throw new Error("baseDir is required for filesystem storage backend");
  }
  return new FsStorageBackend(opts.baseDir);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countLines(fp: string): number {
  try {
    const buf = fs.readFileSync(fp, "utf8");
    return buf ? buf.trim().split("\n").length : 0;
  } catch {
    return 0;
  }
}
