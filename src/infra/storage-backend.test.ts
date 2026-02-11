import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStorageBackend, FsStorageBackend } from "./storage-backend.js";

let tmpDir: string;
let backend: FsStorageBackend;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-backend-test-"));
  backend = new FsStorageBackend(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("key-value", () => {
  it("set then get returns the value", async () => {
    await backend.set("k1", "v1");
    expect(await backend.get("k1")).toBe("v1");
  });

  it("get non-existent key returns null", async () => {
    expect(await backend.get("missing")).toBeNull();
  });

  it("delete returns true for existing key", async () => {
    await backend.set("k1", "v1");
    expect(await backend.delete("k1")).toBe(true);
    expect(await backend.get("k1")).toBeNull();
  });

  it("delete returns false for non-existent key", async () => {
    expect(await backend.delete("nope")).toBe(false);
  });

  it("exists returns true/false correctly", async () => {
    expect(await backend.exists("k1")).toBe(false);
    await backend.set("k1", "v1");
    expect(await backend.exists("k1")).toBe(true);
  });
});

describe("hash", () => {
  it("hset then hget returns the field value", async () => {
    await backend.hset("h1", "f1", "val");
    expect(await backend.hget("h1", "f1")).toBe("val");
  });

  it("hget non-existent key returns null", async () => {
    expect(await backend.hget("missing", "f1")).toBeNull();
  });

  it("hget non-existent field returns null", async () => {
    await backend.hset("h1", "f1", "val");
    expect(await backend.hget("h1", "f2")).toBeNull();
  });

  it("hmset then hgetall returns all fields", async () => {
    await backend.hmset("h2", { a: "1", b: "2" });
    expect(await backend.hgetall("h2")).toEqual({ a: "1", b: "2" });
  });

  it("hgetall on non-existent key returns null", async () => {
    expect(await backend.hgetall("missing")).toBeNull();
  });

  it("hdel removes fields and returns count", async () => {
    await backend.hmset("h3", { a: "1", b: "2", c: "3" });
    expect(await backend.hdel("h3", "a", "c")).toBe(2);
    expect(await backend.hgetall("h3")).toEqual({ b: "2" });
  });

  it("hdel on non-existent key returns 0", async () => {
    expect(await backend.hdel("missing", "f1")).toBe(0);
  });
});

describe("stream (JSONL)", () => {
  it("append returns incrementing IDs starting at 0", async () => {
    expect(await backend.append("s1", "first")).toBe("0");
    expect(await backend.append("s1", "second")).toBe("1");
    expect(await backend.append("s1", "third")).toBe("2");
  });

  it("range returns all entries with - and +", async () => {
    await backend.append("s1", "a");
    await backend.append("s1", "b");
    const entries = await backend.range("s1", "-", "+");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ id: "0", data: { data: "a" } });
    expect(entries[1]).toEqual({ id: "1", data: { data: "b" } });
  });

  it("range with start/end filters entries", async () => {
    await backend.append("s1", "a");
    await backend.append("s1", "b");
    await backend.append("s1", "c");
    const entries = await backend.range("s1", "1", "1");
    expect(entries).toHaveLength(1);
    expect(entries[0].data).toEqual({ data: "b" });
  });

  it("range with count limits results", async () => {
    await backend.append("s1", "a");
    await backend.append("s1", "b");
    await backend.append("s1", "c");
    const entries = await backend.range("s1", "-", "+", 2);
    expect(entries).toHaveLength(2);
  });

  it("range on non-existent key returns empty array", async () => {
    expect(await backend.range("missing", "-", "+")).toEqual([]);
  });

  it("trim keeps only the last N entries", async () => {
    await backend.append("s1", "a");
    await backend.append("s1", "b");
    await backend.append("s1", "c");
    await backend.append("s1", "d");
    await backend.trim("s1", 2);
    const entries = await backend.range("s1", "-", "+");
    expect(entries).toHaveLength(2);
    expect(entries[0].data).toEqual({ data: "c" });
    expect(entries[1].data).toEqual({ data: "d" });
  });
});

describe("sorted set", () => {
  it("zadd + zrangebyscore returns members in score order", async () => {
    await backend.zadd("z1", 3, "c");
    await backend.zadd("z1", 1, "a");
    await backend.zadd("z1", 2, "b");
    expect(await backend.zrangebyscore("z1", 1, 3)).toEqual(["a", "b", "c"]);
  });

  it("zrangebyscore filters by min/max", async () => {
    await backend.zadd("z1", 1, "a");
    await backend.zadd("z1", 5, "b");
    await backend.zadd("z1", 10, "c");
    expect(await backend.zrangebyscore("z1", 2, 8)).toEqual(["b"]);
  });

  it("zrangebyscore with limit caps results", async () => {
    await backend.zadd("z1", 1, "a");
    await backend.zadd("z1", 2, "b");
    await backend.zadd("z1", 3, "c");
    expect(await backend.zrangebyscore("z1", 1, 3, 2)).toEqual(["a", "b"]);
  });

  it("zadd updates score for existing member", async () => {
    await backend.zadd("z1", 1, "a");
    await backend.zadd("z1", 10, "a");
    expect(await backend.zrangebyscore("z1", 5, 15)).toEqual(["a"]);
    expect(await backend.zrangebyscore("z1", 0, 4)).toEqual([]);
  });

  it("zrem removes members and returns count", async () => {
    await backend.zadd("z1", 1, "a");
    await backend.zadd("z1", 2, "b");
    expect(await backend.zrem("z1", "a", "nonexistent")).toBe(1);
    expect(await backend.zrangebyscore("z1", 0, 10)).toEqual(["b"]);
  });
});

describe("set", () => {
  it("sadd adds members and deduplicates", async () => {
    expect(await backend.sadd("s1", "a", "b")).toBe(2);
    expect(await backend.sadd("s1", "b", "c")).toBe(1);
  });

  it("smembers returns all members", async () => {
    await backend.sadd("s1", "x", "y", "z");
    const members = await backend.smembers("s1");
    expect(members.toSorted()).toEqual(["x", "y", "z"]);
  });

  it("smembers on non-existent key returns empty array", async () => {
    expect(await backend.smembers("missing")).toEqual([]);
  });

  it("srem removes members and returns count", async () => {
    await backend.sadd("s1", "a", "b", "c");
    expect(await backend.srem("s1", "a", "nonexistent")).toBe(1);
    expect((await backend.smembers("s1")).toSorted()).toEqual(["b", "c"]);
  });
});

describe("locking", () => {
  beforeEach(() => {
    // Pre-create the .locks parent so mkdirSync(recursive:false) can succeed
    fs.mkdirSync(path.join(tmpDir, ".locks"), { recursive: true });
  });

  it("withLock serializes concurrent calls", async () => {
    const order: number[] = [];
    const task = (id: number, ms: number) =>
      backend.withLock(
        "test-lock",
        async () => {
          order.push(id);
          await new Promise((r) => setTimeout(r, ms));
          order.push(id);
        },
        { timeoutMs: 5000 },
      );
    await Promise.all([task(1, 50), task(2, 50)]);
    // Serialized: [1,1,2,2] or [2,2,1,1]
    expect(order[0]).toBe(order[1]);
    expect(order[2]).toBe(order[3]);
  });

  it("withLock returns the function result", async () => {
    const result = await backend.withLock("ret-lock", async () => 42);
    expect(result).toBe(42);
  });

  it("lock times out when directory cannot be created", async () => {
    // Use a nested key whose parent dir does NOT exist under .locks,
    // so mkdirSync(recursive:false) always fails → guaranteed timeout.
    await expect(
      backend.withLock("no-parent:deep", async () => "nope", { timeoutMs: 200 }),
    ).rejects.toThrow(/Failed to acquire lock/);
  });
});

describe("factory", () => {
  it("returns FsStorageBackend when no Redis client", () => {
    const b = createStorageBackend({ backend: "fs", baseDir: tmpDir });
    expect(b).toBeInstanceOf(FsStorageBackend);
  });

  it("returns FsStorageBackend when backend is redis but client is null", () => {
    const b = createStorageBackend({ backend: "redis", redisClient: null, baseDir: tmpDir });
    expect(b).toBeInstanceOf(FsStorageBackend);
  });

  it("throws when backend is fs and baseDir is missing", () => {
    expect(() => createStorageBackend({ backend: "fs" })).toThrow(/baseDir is required/);
  });
});
