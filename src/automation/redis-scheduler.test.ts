import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsStorageBackend } from "../infra/storage-backend.js";
import { Scheduler } from "./redis-scheduler.js";

let tmpDir: string;
let storage: FsStorageBackend;
let scheduler: Scheduler;
const AGENT = "agent-1";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-scheduler-"));
  storage = new FsStorageBackend(tmpDir);
  scheduler = new Scheduler(storage);
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Scheduler", () => {
  it("schedule once job has status scheduled and parsed nextRunAt", async () => {
    const futureMs = Date.now() + 60_000;
    const job = await scheduler.schedule({
      agentId: AGENT,
      name: "one-shot",
      scheduleType: "once",
      scheduleExpr: String(futureMs),
    });
    expect(job.status).toBe("scheduled");
    expect(job.nextRunAt).toBe(futureMs);
    expect(job.runCount).toBe(0);
  });

  it("schedule interval job sets nextRunAt to now + interval", async () => {
    const before = Date.now();
    const job = await scheduler.schedule({
      agentId: AGENT,
      name: "repeater",
      scheduleType: "interval",
      scheduleExpr: "5000",
    });
    expect(job.nextRunAt).toBeGreaterThanOrEqual(before + 5000);
    expect(job.nextRunAt).toBeLessThanOrEqual(Date.now() + 5000);
  });

  it("get returns scheduled job, null for missing", async () => {
    const job = await scheduler.schedule({
      agentId: AGENT,
      name: "j1",
      scheduleType: "once",
      scheduleExpr: String(Date.now() + 60_000),
    });
    const fetched = await scheduler.get(AGENT, job.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(job.id);
    expect(await scheduler.get(AGENT, "nonexistent")).toBeNull();
  });

  it("list returns all jobs for agent", async () => {
    await scheduler.schedule({
      agentId: AGENT,
      name: "j1",
      scheduleType: "once",
      scheduleExpr: String(Date.now() + 60_000),
    });
    await scheduler.schedule({
      agentId: AGENT,
      name: "j2",
      scheduleType: "interval",
      scheduleExpr: "1000",
    });
    const jobs = await scheduler.list(AGENT);
    expect(jobs).toHaveLength(2);
  });

  it("pollDue returns past-due jobs but not future ones", async () => {
    const pastJob = await scheduler.schedule({
      agentId: AGENT,
      name: "past",
      scheduleType: "once",
      scheduleExpr: String(Date.now() - 1000),
    });
    await scheduler.schedule({
      agentId: AGENT,
      name: "future",
      scheduleType: "once",
      scheduleExpr: String(Date.now() + 60_000),
    });

    const due = await scheduler.pollDue();
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe(pastJob.id);
  });

  it("markRunning updates status to running", async () => {
    const job = await scheduler.schedule({
      agentId: AGENT,
      name: "run-me",
      scheduleType: "once",
      scheduleExpr: String(Date.now() - 1000),
    });
    const running = await scheduler.markRunning(AGENT, job.id);
    expect(running).not.toBeNull();
    expect(running!.status).toBe("running");
  });

  it("markComplete on once job sets status completed", async () => {
    const job = await scheduler.schedule({
      agentId: AGENT,
      name: "once-done",
      scheduleType: "once",
      scheduleExpr: String(Date.now() - 1000),
    });
    await scheduler.markRunning(AGENT, job.id);
    const done = await scheduler.markComplete(AGENT, job.id, 100);
    expect(done).not.toBeNull();
    expect(done!.status).toBe("completed");
    expect(done!.runCount).toBe(1);
  });

  it("markComplete on interval job advances nextRunAt and increments runCount", async () => {
    const job = await scheduler.schedule({
      agentId: AGENT,
      name: "repeater",
      scheduleType: "interval",
      scheduleExpr: "5000",
    });
    await scheduler.markRunning(AGENT, job.id);
    const done = await scheduler.markComplete(AGENT, job.id, 50);
    expect(done).not.toBeNull();
    expect(done!.status).toBe("scheduled");
    expect(done!.runCount).toBe(1);
    expect(done!.nextRunAt).toBeGreaterThan(job.nextRunAt);
  });

  it("disable removes from schedule, enable re-adds", async () => {
    const job = await scheduler.schedule({
      agentId: AGENT,
      name: "toggle",
      scheduleType: "once",
      scheduleExpr: String(Date.now() - 1000),
    });

    const disabled = await scheduler.disable(AGENT, job.id);
    expect(disabled!.status).toBe("disabled");

    // Should not appear in pollDue
    const due = await scheduler.pollDue();
    expect(due.find((j) => j.id === job.id)).toBeUndefined();

    const enabled = await scheduler.enable(AGENT, job.id);
    expect(enabled!.status).toBe("scheduled");
  });

  it("remove deletes everything", async () => {
    const job = await scheduler.schedule({
      agentId: AGENT,
      name: "delete-me",
      scheduleType: "once",
      scheduleExpr: String(Date.now() + 60_000),
    });
    const removed = await scheduler.remove(AGENT, job.id);
    expect(removed).toBe(true);
    expect(await scheduler.get(AGENT, job.id)).toBeNull();
    expect(await scheduler.remove(AGENT, job.id)).toBe(false);
  });
});
