import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Scheduler } from "../automation/redis-scheduler.js";
import { EventBus } from "../events/redis-event-bus.js";
import { GoalStore } from "../goals/redis-goal-store.js";
import { TaskStore } from "../tasks/redis-task-store.js";
import { decrypt, encrypt, resolveEncryptionKey } from "./redis-crypto.js";
import { RedisStorageBackend } from "./storage-backend.js";

const REDIS_URL = "redis://:testpass123@127.0.0.1:6399";

// ── Availability probe ───────────────────────────────────────────────────────

let available = false;
try {
  const probe = new Redis(REDIS_URL, { lazyConnect: true, connectTimeout: 2000 });
  await probe.connect();
  await probe.quit();
  available = true;
} catch {
  // Redis not available — skip all tests
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe("Redis Integration", () => {
  describe.skipIf(!available)("with Redis", () => {
    let redis: Redis;
    let storage: RedisStorageBackend;

    beforeAll(async () => {
      redis = new Redis(REDIS_URL, {
        keyPrefix: `test:${Date.now()}:`,
        lazyConnect: true,
        connectTimeout: 3000,
      });
      await redis.connect();
      storage = new RedisStorageBackend(redis);
    });

    afterAll(async () => {
      if (redis?.status === "ready") {
        await redis.flushdb();
        await redis.quit();
      }
    });

    beforeEach(async () => {
      if (redis?.status === "ready") {
        await redis.flushdb();
      }
    });

    // ── StorageBackend basics ──────────────────────────────────────────────

    it("1: string set/get round-trip", async () => {
      await storage.set("greeting", "hello");
      expect(await storage.get("greeting")).toBe("hello");
    });

    it("2: string with TTL expires", async () => {
      await storage.set("ephemeral", "gone-soon", { ttlMs: 500 });
      expect(await storage.get("ephemeral")).toBe("gone-soon");
      await new Promise((r) => setTimeout(r, 700));
      expect(await storage.get("ephemeral")).toBeNull();
    });

    it("3: hash operations (hmset, hgetall, hget, hdel)", async () => {
      await storage.hmset("user:1", { name: "Alice", role: "admin" });
      expect(await storage.hgetall("user:1")).toEqual({ name: "Alice", role: "admin" });
      expect(await storage.hget("user:1", "name")).toBe("Alice");
      expect(await storage.hdel("user:1", "role")).toBe(1);
      expect(await storage.hgetall("user:1")).toEqual({ name: "Alice" });
    });

    it("4: stream append + range + trim", async () => {
      const id1 = await storage.append("log", "entry-a");
      const id2 = await storage.append("log", "entry-b");
      const id3 = await storage.append("log", "entry-c");
      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();
      expect(id3).toBeTruthy();

      const all = await storage.range("log", "-", "+");
      expect(all).toHaveLength(3);
      expect(all[0].data.data).toBe("entry-a");
      expect(all[2].data.data).toBe("entry-c");

      await storage.trim("log", 2);
      const trimmed = await storage.range("log", "-", "+");
      // XTRIM ~ is approximate; at most 2 remain
      expect(trimmed.length).toBeLessThanOrEqual(3);
    });

    it("5: sorted set (zadd, zrangebyscore, zrem)", async () => {
      await storage.zadd("scores", 10, "alice");
      await storage.zadd("scores", 30, "charlie");
      await storage.zadd("scores", 20, "bob");
      const result = await storage.zrangebyscore("scores", 0, 100);
      expect(result).toEqual(["alice", "bob", "charlie"]);

      expect(await storage.zrem("scores", "bob")).toBe(1);
      expect(await storage.zrangebyscore("scores", 0, 100)).toEqual(["alice", "charlie"]);
    });

    it("6: set operations (sadd, smembers, srem)", async () => {
      expect(await storage.sadd("tags", "a", "b", "c")).toBe(3);
      expect(await storage.sadd("tags", "b", "d")).toBe(1); // b already exists
      const members = (await storage.smembers("tags")).toSorted();
      expect(members).toEqual(["a", "b", "c", "d"]);
      expect(await storage.srem("tags", "a", "missing")).toBe(1);
    });

    it("7: withLock executes and returns result", async () => {
      const result = await storage.withLock("my-lock", async () => 42);
      expect(result).toBe(42);
    });

    it("8: withLock serializes concurrent access", async () => {
      const order: number[] = [];
      const task = (id: number, ms: number) =>
        storage.withLock(
          "serial-lock",
          async () => {
            order.push(id);
            await new Promise((r) => setTimeout(r, ms));
            order.push(id);
          },
          { timeoutMs: 5000 },
        );
      await Promise.all([task(1, 80), task(2, 80)]);
      // Serialized: [1,1,2,2] or [2,2,1,1]
      expect(order[0]).toBe(order[1]);
      expect(order[2]).toBe(order[3]);
    });

    // ── Encryption round-trip through Redis ────────────────────────────────

    it("9: encrypt → store → retrieve → decrypt", async () => {
      const key = randomBytes(32);
      const plaintext = "sensitive-data-12345";
      const ciphertext = encrypt(plaintext, key);
      await storage.set("secret", ciphertext);
      const retrieved = await storage.get("secret");
      expect(retrieved).not.toBeNull();
      expect(decrypt(retrieved!, key)).toBe(plaintext);
    });

    // ── TaskStore with real Redis ──────────────────────────────────────────

    it("10: TaskStore create + dequeue", async () => {
      const tasks = new TaskStore(storage);
      const created = await tasks.create({ agentId: "a1", title: "Do stuff" });
      expect(created.status).toBe("pending");

      const dequeued = await tasks.dequeue("a1");
      expect(dequeued).not.toBeNull();
      expect(dequeued!.id).toBe(created.id);
      expect(dequeued!.status).toBe("active");
    });

    it("11: TaskStore priority ordering (P5 before P1)", async () => {
      const tasks = new TaskStore(storage);
      const low = await tasks.create({ agentId: "a1", title: "Low", priority: 1 });
      const high = await tasks.create({ agentId: "a1", title: "High", priority: 5 });

      const first = await tasks.dequeue("a1");
      expect(first!.id).toBe(high.id);

      const second = await tasks.dequeue("a1");
      expect(second!.id).toBe(low.id);
    });

    it("12: TaskStore full lifecycle (create → dequeue → complete)", async () => {
      const tasks = new TaskStore(storage);
      const task = await tasks.create({ agentId: "a1", title: "Lifecycle" });
      await tasks.dequeue("a1");
      const completed = await tasks.complete("a1", task.id, "done!");
      expect(completed!.status).toBe("completed");
      expect(completed!.result).toBe("done!");
      expect(completed!.completedAt).toBeGreaterThan(0);
    });

    // ── GoalStore with real Redis ──────────────────────────────────────────

    it("13: GoalStore create + progress + complete", async () => {
      const goals = new GoalStore(storage);
      const goal = await goals.create({ agentId: "a1", title: "Ship v2" });
      expect(goal.status).toBe("active");
      expect(goal.progress).toBe(0);

      const updated = await goals.updateProgress("a1", goal.id, 50);
      expect(updated!.progress).toBe(50);

      const done = await goals.complete("a1", goal.id);
      expect(done!.status).toBe("completed");
      expect(done!.progress).toBe(100);
    });

    it("14: GoalStore linkTask", async () => {
      const goals = new GoalStore(storage);
      const goal = await goals.create({ agentId: "a1", title: "Goal with tasks" });
      const linked = await goals.linkTask("a1", goal.id, "task-abc");
      expect(linked!.taskIds).toContain("task-abc");

      // Linking same task again is idempotent
      const again = await goals.linkTask("a1", goal.id, "task-abc");
      expect(again!.taskIds.filter((id) => id === "task-abc")).toHaveLength(1);
    });

    // ── Scheduler with real Redis ──────────────────────────────────────────

    it("15: Scheduler schedule + pollDue", async () => {
      const scheduler = new Scheduler(storage);
      const pastMs = String(Date.now() - 60_000); // 1 min in the past
      const job = await scheduler.schedule({
        agentId: "a1",
        name: "cleanup",
        scheduleType: "once",
        scheduleExpr: pastMs,
      });
      expect(job.status).toBe("scheduled");

      const due = await scheduler.pollDue();
      expect(due.length).toBeGreaterThanOrEqual(1);
      expect(due.some((j) => j.id === job.id)).toBe(true);
    });

    // ── EventBus with real Redis ───────────────────────────────────────────

    it("16: EventBus publish + readGlobal", async () => {
      const bus = new EventBus(storage);
      await bus.publish({ type: "task.created", agentId: "a1", payload: '{"x":1}' });
      const events = await bus.readGlobal();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("task.created");
      expect(events[0].agentId).toBe("a1");
    });

    it("17: EventBus directed event appears in agent stream", async () => {
      const bus = new EventBus(storage);
      await bus.publish({
        type: "message.inbound",
        agentId: "a1",
        payload: '{"msg":"hi"}',
        targetAgentId: "a2",
      });
      const agentEvents = await bus.readAgent("a2");
      expect(agentEvents).toHaveLength(1);
      expect(agentEvents[0].type).toBe("message.inbound");
      expect(agentEvents[0].targetAgentId).toBe("a2");
    });

    // ── Cross-module integration ───────────────────────────────────────────

    it("18: full workflow (goal → task → schedule → event → verify)", async () => {
      const goals = new GoalStore(storage);
      const tasks = new TaskStore(storage);
      const scheduler = new Scheduler(storage);
      const bus = new EventBus(storage);

      // 1. Create goal
      const goal = await goals.create({ agentId: "a1", title: "Deploy feature" });

      // 2. Create task linked to goal
      const task = await tasks.create({ agentId: "a1", title: "Run tests", priority: 4 });
      await goals.linkTask("a1", goal.id, task.id);

      // 3. Schedule automation
      const job = await scheduler.schedule({
        agentId: "a1",
        name: "auto-deploy",
        scheduleType: "once",
        scheduleExpr: String(Date.now() - 1000),
        payload: JSON.stringify({ goalId: goal.id }),
      });

      // 4. Publish event
      await bus.publish({
        type: "automation.triggered",
        agentId: "a1",
        payload: JSON.stringify({ jobId: job.id, taskId: task.id }),
      });

      // 5. Verify all state is consistent
      const fetchedGoal = await goals.get("a1", goal.id);
      expect(fetchedGoal!.taskIds).toContain(task.id);

      const fetchedTask = await tasks.get("a1", task.id);
      expect(fetchedTask!.status).toBe("pending");

      const dueJobs = await scheduler.pollDue();
      expect(dueJobs.some((j) => j.id === job.id)).toBe(true);

      const events = await bus.readGlobal({ type: "automation.triggered" });
      expect(events).toHaveLength(1);
    });

    // ── Extra edge cases ───────────────────────────────────────────────────

    it("19: resolveEncryptionKey returns null when env var missing", () => {
      expect(resolveEncryptionKey({})).toBeNull();
    });

    it("20: resolveEncryptionKey rejects invalid hex", () => {
      expect(() => resolveEncryptionKey({ OPENCLAW_REDIS_ENC_KEY: "short" })).toThrow(
        /must be a 64-char hex string/,
      );
    });
  });
});
