import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsStorageBackend } from "../infra/storage-backend.js";
import { GoalStore } from "./redis-goal-store.js";

let tmpDir: string;
let storage: FsStorageBackend;
let store: GoalStore;
const AGENT = "agent-1";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-goal-store-"));
  storage = new FsStorageBackend(tmpDir);
  store = new GoalStore(storage);
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GoalStore", () => {
  it("creates a goal with active status and progress 0", async () => {
    const goal = await store.create({ agentId: AGENT, title: "Ship v2" });
    expect(goal.status).toBe("active");
    expect(goal.progress).toBe(0);
    expect(goal.id).toBeTruthy();
    expect(goal.taskIds).toEqual([]);
  });

  it("get returns created goal, null for missing", async () => {
    const goal = await store.create({ agentId: AGENT, title: "G1" });
    const fetched = await store.get(AGENT, goal.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(goal.id);
    expect(await store.get(AGENT, "nonexistent")).toBeNull();
  });

  it("updateProgress sets progress to 50", async () => {
    const goal = await store.create({ agentId: AGENT, title: "G" });
    const updated = await store.updateProgress(AGENT, goal.id, 50);
    expect(updated).not.toBeNull();
    expect(updated!.progress).toBe(50);
  });

  it("progress is clamped to 0-100", async () => {
    const goal = await store.create({ agentId: AGENT, title: "G" });

    const over = await store.updateProgress(AGENT, goal.id, 150);
    expect(over!.progress).toBe(100);

    const under = await store.updateProgress(AGENT, goal.id, -10);
    expect(under!.progress).toBe(0);
  });

  it("complete sets status completed, progress 100, and completedAt", async () => {
    const goal = await store.create({ agentId: AGENT, title: "G" });
    const done = await store.complete(AGENT, goal.id);
    expect(done).not.toBeNull();
    expect(done!.status).toBe("completed");
    expect(done!.progress).toBe(100);
    expect(done!.completedAt).toBeGreaterThan(0);
  });

  it("pause and resume toggle status correctly", async () => {
    const goal = await store.create({ agentId: AGENT, title: "G" });

    const paused = await store.pause(AGENT, goal.id);
    expect(paused!.status).toBe("paused");

    const resumed = await store.resume(AGENT, goal.id);
    expect(resumed!.status).toBe("active");
  });

  it("abandon sets status to abandoned", async () => {
    const goal = await store.create({ agentId: AGENT, title: "G" });
    const abandoned = await store.abandon(AGENT, goal.id);
    expect(abandoned).not.toBeNull();
    expect(abandoned!.status).toBe("abandoned");
  });

  it("link and unlink tasks", async () => {
    const goal = await store.create({ agentId: AGENT, title: "G" });
    await store.linkTask(AGENT, goal.id, "task-1");
    await store.linkTask(AGENT, goal.id, "task-2");

    const linked = await store.get(AGENT, goal.id);
    expect(linked!.taskIds).toContain("task-1");
    expect(linked!.taskIds).toContain("task-2");

    await store.unlinkTask(AGENT, goal.id, "task-1");
    const afterUnlink = await store.get(AGENT, goal.id);
    expect(afterUnlink!.taskIds).not.toContain("task-1");
    expect(afterUnlink!.taskIds).toContain("task-2");
  });

  it("getSubGoals returns children of a parent", async () => {
    const parent = await store.create({ agentId: AGENT, title: "Parent" });
    const child = await store.create({
      agentId: AGENT,
      title: "Child",
      parentGoalId: parent.id,
    });
    await store.create({ agentId: AGENT, title: "Unrelated" });

    const subs = await store.getSubGoals(AGENT, parent.id);
    expect(subs).toHaveLength(1);
    expect(subs[0].id).toBe(child.id);
  });

  it("list with status filter returns matching goals", async () => {
    await store.create({ agentId: AGENT, title: "Active1" });
    const g2 = await store.create({ agentId: AGENT, title: "Active2" });
    await store.complete(AGENT, g2.id);

    const active = await store.list(AGENT, { status: "active" });
    expect(active).toHaveLength(1);
    expect(active[0].title).toBe("Active1");

    const completed = await store.list(AGENT, { status: "completed" });
    expect(completed).toHaveLength(1);
    expect(completed[0].title).toBe("Active2");
  });
});
