import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CHUNK_INDEX,
  FILE_INDEX,
  chunkKey,
  embeddingToBuffer,
  ensureChunkIndex,
  ensureFileIndex,
  fileKey,
  getChunkIndexInfo,
  recreateChunkIndex,
} from "./redis-memory-schema.js";

const REDIS_URL =
  process.env.OPENCLAW_REDIS_TEST_URL ??
  "redis://:c0f18fa8462af02dddc66cb03a152952162b1c358ba1caf3f473ae056e525201@127.0.0.1:6399";

// ── Availability probe ───────────────────────────────────────────────────────

let available = false;
try {
  const probe = new Redis(REDIS_URL, { lazyConnect: true, connectTimeout: 2000 });
  await probe.connect();
  await probe.quit();
  available = true;
} catch {
  // Redis Stack not available — skip all tests
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe("Redis Memory Integration", () => {
  describe.skipIf(!available)("with Redis Stack", () => {
    let redis: Redis;

    beforeAll(async () => {
      redis = new Redis(REDIS_URL, {
        lazyConnect: true,
        connectTimeout: 3000,
      });
      await redis.connect();
    });

    afterAll(async () => {
      if (redis?.status === "ready") {
        try {
          await redis.call("FT.DROPINDEX", CHUNK_INDEX);
        } catch {
          /* ignore */
        }
        try {
          await redis.call("FT.DROPINDEX", FILE_INDEX);
        } catch {
          /* ignore */
        }
        await redis.flushdb();
        await redis.quit();
      }
    });

    beforeEach(async () => {
      if (redis?.status === "ready") {
        try {
          await redis.call("FT.DROPINDEX", CHUNK_INDEX);
        } catch {
          /* ignore */
        }
        try {
          await redis.call("FT.DROPINDEX", FILE_INDEX);
        } catch {
          /* ignore */
        }
        await redis.flushdb();
      }
    });

    // ── Schema ──────────────────────────────────────────────────────────────

    it("1: ensureChunkIndex creates index idempotently", async () => {
      await ensureChunkIndex(redis, 4);
      await ensureChunkIndex(redis, 4); // should not throw
    });

    it("2: getChunkIndexInfo returns index metadata", async () => {
      await ensureChunkIndex(redis, 4);
      const info = await getChunkIndexInfo(redis);
      expect(info.exists).toBe(true);
      expect(info.dims).toBe(4);
      expect(info.numDocs).toBe(0);
    });

    it("3: recreateChunkIndex drops and recreates with new dims", async () => {
      await ensureChunkIndex(redis, 4);
      await recreateChunkIndex(redis, 8);
      const info = await getChunkIndexInfo(redis);
      expect(info.exists).toBe(true);
      expect(info.dims).toBe(8);
      expect(info.numDocs).toBe(0);
    });

    it("4: ensureFileIndex creates index idempotently", async () => {
      await ensureFileIndex(redis);
      await ensureFileIndex(redis); // should not throw
    });

    // ── JSON Document Storage ───────────────────────────────────────────────

    it("5: store and retrieve chunk document via JSON.SET/JSON.GET", async () => {
      await ensureChunkIndex(redis, 4);
      const doc = {
        id: "test-chunk-1",
        path: "memory/test.md",
        source: "memory",
        agent_id: "default",
        model: "test-model",
        start_line: 1,
        end_line: 10,
        hash: "abc123",
        text: "This is a test chunk about Redis vector search",
        embedding: [0.1, 0.2, 0.3, 0.4],
        updated_at: Date.now(),
        access_count: 0,
      };
      const key = chunkKey(doc.id);
      await redis.call("JSON.SET", key, "$", JSON.stringify(doc));

      const raw = (await redis.call("JSON.GET", key)) as string;
      const stored = JSON.parse(raw);
      expect(stored.id).toBe("test-chunk-1");
      expect(stored.text).toContain("Redis vector search");
      expect(stored.embedding).toEqual([0.1, 0.2, 0.3, 0.4]);
    });

    it("6: store and retrieve file document", async () => {
      await ensureFileIndex(redis);
      const doc = {
        path: "memory/test.md",
        source: "memory",
        hash: "xyz789",
        mtime: Date.now(),
        size: 1024,
      };
      const key = fileKey("testhash");
      await redis.call("JSON.SET", key, "$", JSON.stringify(doc));

      const raw = (await redis.call("JSON.GET", key)) as string;
      expect(JSON.parse(raw).path).toBe("memory/test.md");
    });

    // ── Vector Search ───────────────────────────────────────────────────────

    it("7: vector KNN search returns nearest chunks", async () => {
      await ensureChunkIndex(redis, 4);

      const chunks = [
        { id: "v1", embedding: [1.0, 0.0, 0.0, 0.0], text: "chunk about dogs" },
        { id: "v2", embedding: [0.0, 1.0, 0.0, 0.0], text: "chunk about cats" },
        { id: "v3", embedding: [0.9, 0.1, 0.0, 0.0], text: "chunk about puppies" },
      ];

      for (const c of chunks) {
        const doc = {
          id: c.id,
          path: "test.md",
          source: "memory",
          agent_id: "default",
          model: "test",
          start_line: 1,
          end_line: 5,
          hash: c.id,
          text: c.text,
          embedding: c.embedding,
          updated_at: Date.now(),
          access_count: 0,
        };
        await redis.call("JSON.SET", chunkKey(c.id), "$", JSON.stringify(doc));
      }

      // Wait for RediSearch to index
      await new Promise((r) => setTimeout(r, 500));

      // Query with vector similar to v1 and v3 (dogs/puppies direction)
      const queryVec = embeddingToBuffer([0.95, 0.05, 0.0, 0.0]);

      const results = (await redis.call(
        "FT.SEARCH",
        CHUNK_INDEX,
        "*=>[KNN 3 @embedding $BLOB EF_RUNTIME 10]",
        "PARAMS",
        "2",
        "BLOB",
        queryVec,
        "SORTBY",
        "__embedding_score",
        "ASC",
        "LIMIT",
        "0",
        "3",
        "RETURN",
        "2",
        "$.id",
        "$.text",
        "DIALECT",
        "2",
      )) as unknown[];

      // First element is total count
      expect(Number(results[0])).toBeGreaterThanOrEqual(2);
      // Parse first result's fields — results[1] is key, results[2] is fields array
      const firstFields = results[2] as string[];
      const idIdx = firstFields.indexOf("$.id");
      const firstId = firstFields[idIdx + 1];
      expect(["v1", "v3"]).toContain(firstId);
    });

    // ── Full-Text Search ────────────────────────────────────────────────────

    it("8: full-text search returns matching chunks", async () => {
      await ensureChunkIndex(redis, 4);

      const chunks = [
        { id: "t1", text: "PostgreSQL database management and SQL queries" },
        { id: "t2", text: "Redis caching and key-value operations" },
        { id: "t3", text: "MongoDB document storage and NoSQL patterns" },
      ];

      for (const c of chunks) {
        const doc = {
          id: c.id,
          path: "test.md",
          source: "memory",
          agent_id: "default",
          model: "test",
          start_line: 1,
          end_line: 5,
          hash: c.id,
          text: c.text,
          embedding: [0.1, 0.2, 0.3, 0.4],
          updated_at: Date.now(),
          access_count: 0,
        };
        await redis.call("JSON.SET", chunkKey(c.id), "$", JSON.stringify(doc));
      }

      await new Promise((r) => setTimeout(r, 500));

      const results = (await redis.call(
        "FT.SEARCH",
        CHUNK_INDEX,
        "@text:(Redis caching)",
        "WITHSCORES",
        "LIMIT",
        "0",
        "3",
        "RETURN",
        "2",
        "$.id",
        "$.text",
        "DIALECT",
        "2",
      )) as unknown[];

      // With WITHSCORES: [total, key1, score1, [fields1], ...]
      expect(Number(results[0])).toBeGreaterThanOrEqual(1);
      // results[1] = key, results[2] = score, results[3] = fields array
      const matchFields = results[3] as string[];
      const idIdx = matchFields.indexOf("$.id");
      const matchId = matchFields[idIdx + 1];
      expect(matchId).toBe("t2");
    });

    // ── Embedding buffer utility ────────────────────────────────────────────

    it("9: embeddingToBuffer creates correct Float32 LE buffer", () => {
      const vec = [1.0, 2.0, 3.0];
      const buf = embeddingToBuffer(vec);
      expect(buf.length).toBe(12); // 3 * 4 bytes
      expect(buf.readFloatLE(0)).toBeCloseTo(1.0);
      expect(buf.readFloatLE(4)).toBeCloseTo(2.0);
      expect(buf.readFloatLE(8)).toBeCloseTo(3.0);
    });

    // ── Chunk budget (numDocs) ──────────────────────────────────────────────

    it("10: numDocs reflects stored chunk count", async () => {
      await ensureChunkIndex(redis, 4);

      for (let i = 0; i < 5; i++) {
        const doc = {
          id: `budget-${i}`,
          path: "test.md",
          source: "memory",
          agent_id: "default",
          model: "test",
          start_line: i,
          end_line: i + 1,
          hash: `h${i}`,
          text: `Chunk number ${i}`,
          embedding: [0.1, 0.2, 0.3, 0.4],
          updated_at: Date.now() - (5 - i) * 1000,
          access_count: 0,
        };
        await redis.call("JSON.SET", chunkKey(doc.id), "$", JSON.stringify(doc));
      }

      await new Promise((r) => setTimeout(r, 500));

      const info = await getChunkIndexInfo(redis);
      expect(info.numDocs).toBe(5);
    });

    // ── JSON.DEL ────────────────────────────────────────────────────────────

    it("11: JSON.DEL removes chunk from index", async () => {
      await ensureChunkIndex(redis, 4);

      const doc = {
        id: "del-test",
        path: "test.md",
        source: "memory",
        agent_id: "default",
        model: "test",
        start_line: 1,
        end_line: 2,
        hash: "delhash",
        text: "Chunk to delete",
        embedding: [0.1, 0.2, 0.3, 0.4],
        updated_at: Date.now(),
        access_count: 0,
      };
      await redis.call("JSON.SET", chunkKey(doc.id), "$", JSON.stringify(doc));
      await new Promise((r) => setTimeout(r, 300));

      // Verify it exists
      const before = (await redis.call("JSON.GET", chunkKey(doc.id))) as string;
      expect(before).not.toBeNull();

      // Delete it
      await redis.call("JSON.DEL", chunkKey(doc.id));

      const after = await redis.call("JSON.GET", chunkKey(doc.id));
      expect(after).toBeNull();
    });

    // ── Tag filtering ───────────────────────────────────────────────────────

    it("12: FT.SEARCH with source tag filter", async () => {
      await ensureChunkIndex(redis, 4);

      const docs = [
        { id: "f1", source: "memory", text: "memory chunk one" },
        { id: "f2", source: "sessions", text: "session chunk two" },
        { id: "f3", source: "memory", text: "memory chunk three" },
      ];

      for (const d of docs) {
        const doc = {
          id: d.id,
          path: "test.md",
          source: d.source,
          agent_id: "default",
          model: "test",
          start_line: 1,
          end_line: 2,
          hash: d.id,
          text: d.text,
          embedding: [0.1, 0.2, 0.3, 0.4],
          updated_at: Date.now(),
          access_count: 0,
        };
        await redis.call("JSON.SET", chunkKey(d.id), "$", JSON.stringify(doc));
      }

      await new Promise((r) => setTimeout(r, 500));

      // Search only memory source
      const results = (await redis.call(
        "FT.SEARCH",
        CHUNK_INDEX,
        "@source:{memory}",
        "LIMIT",
        "0",
        "10",
        "RETURN",
        "1",
        "$.id",
        "DIALECT",
        "2",
      )) as unknown[];

      expect(Number(results[0])).toBe(2); // only memory chunks
    });
  });
});
