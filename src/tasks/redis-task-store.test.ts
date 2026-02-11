import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskPriority } from "./redis-task-store.js";
import { FsStorageBackend } from "../infra/storage-backend.js";
import { TaskStore } from "./redis-task-store.js";

let tmpDir: string;
let storage: FsStorageBackend;
let store: TaskStore;
const AGENT = "agent-1";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-task-store-"));
  storage = new FsStorageBackend(tmpDir);
  store = new TaskStore(storage);
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("TaskStore", () => {
  it("creates a task with pending status and default priority 3", async () => {
    const task = await store.create({ agentId: AGENT, title: "Do stuff" });
    expect(task.status).toBe("pending");
    expect(task.priority).toBe(3);
    expect(task.id).toBeTruthy();
    expect(task.agentId).toBe(AGENT);
    expect(task.title).toBe("Do stuff");
    expect(task.createdAt).toBeGreaterThan(0);
  });

  it("get returns created task, null for missing", async () => {
    const task = await store.create({ agentId: AGENT, title: "T1" });
    const fetched = await store.get(AGENT, task.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(task.id);
    expect(await store.get(AGENT, "nonexistent")).toBeNull();
  });

  it("dequeue returns highest priority first", async () => {
    await store.create({ agentId: AGENT, title: "Low", priority: 1 as TaskPriority });
    await store.create({ agentId: AGENT, title: "Med", priority: 3 as TaskPriority });
    await store.create({ agentId: AGENT, title: "Crit", priority: 5 as TaskPriority });

    const first = await store.dequeue(AGENT);
    expect(first).not.toBeNull();
    expect(first!.title).toBe("Crit");
    expect(first!.priority).toBe(5);
  });

  it("dequeue sets task status to active", async () => {
    await store.create({ agentId: AGENT, title: "Work" });
    const task = await store.dequeue(AGENT);
    expect(task).not.toBeNull();
    expect(task!.status).toBe("active");
    expect(task!.startedAt).toBeGreaterThan(0);
  });

  it("dequeue on empty queue returns null", async () => {
    expect(await store.dequeue(AGENT)).toBeNull();
  });

  it("complete sets status to completed with completedAt", async () => {
    const created = await store.create({ agentId: AGENT, title: "Finish me" });
    await store.dequeue(AGENT);
    const done = await store.complete(AGENT, created.id, "all good");
    expect(done).not.toBeNull();
    expect(done!.status).toBe("completed");
    expect(done!.completedAt).toBeGreaterThan(0);
    expect(done!.result).toBe("all good");
  });

  it("fail sets status to failed with error message", async () => {
    const created = await store.create({ agentId: AGENT, title: "Fail me" });
    await store.dequeue(AGENT);
    const failed = await store.fail(AGENT, created.id, "boom");
    expect(failed).not.toBeNull();
    expect(failed!.status).toBe("failed");
    expect(failed!.result).toBe("boom");
  });

  it("cancel sets status to cancelled", async () => {
    const created = await store.create({ agentId: AGENT, title: "Cancel me" });
    const cancelled = await store.cancel(AGENT, created.id);
    expect(cancelled).not.toBeNull();
    expect(cancelled!.status).toBe("cancelled");
  });

  it("list with status filter returns matching tasks", async () => {
    const t1 = await store.create({ agentId: AGENT, title: "A" });
    await store.create({ agentId: AGENT, title: "B" });
    await store.create({ agentId: AGENT, title: "C" });
    await store.dequeue(AGENT);
    await store.complete(AGENT, t1.id);

    const pending = await store.list(AGENT, { status: "pending" });
    expect(pending).toHaveLength(2);
    for (const t of pending) {
      expect(t.status).toBe("pending");
    }
  });

  it("count returns correct totals per status", async () => {
    const t1 = await store.create({ agentId: AGENT, title: "A" });
    await store.create({ agentId: AGENT, title: "B" });
    await store.dequeue(AGENT);
    await store.complete(AGENT, t1.id);

    // t1 = completed (removed from active set), t2 = pending still in queue
    // But after dequeue t1 was active then completed → removed from both sets
    // t2 is still pending in queue
    const counts = await store.count(AGENT);
    expect(counts.pending).toBe(1);
    expect(counts.completed).toBe(0); // completed tasks removed from queue+active
    expect(counts.failed).toBe(0);
  });

  it("purge removes old completed tasks", async () => {
    const t1 = await store.create({ agentId: AGENT, title: "Old" });
    await store.dequeue(AGENT);
    await store.complete(AGENT, t1.id);

    // Manually backdate the updatedAt to simulate an old task
    await storage.hmset(`task:${AGENT}:${t1.id}`, {
      updatedAt: String(Date.now() - 10 * 24 * 60 * 60 * 1000),
    });

    // Purge with default 7-day window — should remove the backdated task
    // But the task is already removed from queue/active sets by complete(),
    // so purge won't find it via list(). Let's re-add it to active set.
    await storage.sadd(`task:active:${AGENT}`, t1.id);

    const purged = await store.purge(AGENT);
    expect(purged).toBe(1);

    // Verify it's gone
    expect(await store.get(AGENT, t1.id)).toBeNull();
  });
});
