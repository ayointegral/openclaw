import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsStorageBackend } from "../infra/storage-backend.js";
import { EventBus } from "./redis-event-bus.js";

let tmpDir: string;
let storage: FsStorageBackend;
let bus: EventBus;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-event-bus-"));
  storage = new FsStorageBackend(tmpDir);
  bus = new EventBus(storage);
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("EventBus", () => {
  it("publish + readGlobal returns event with correct fields", async () => {
    const id = await bus.publish({
      type: "task.created",
      agentId: "a1",
      payload: '{"key":"val"}',
    });
    expect(id).toBeTruthy();

    const events = await bus.readGlobal();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("task.created");
    expect(events[0].agentId).toBe("a1");
    expect(events[0].payload).toBe('{"key":"val"}');
    expect(events[0].timestamp).toBeGreaterThan(0);
  });

  it("multiple events are returned in order", async () => {
    await bus.publish({ type: "task.created", agentId: "a1", payload: "A" });
    await bus.publish({ type: "task.completed", agentId: "a1", payload: "B" });
    await bus.publish({ type: "task.failed", agentId: "a1", payload: "C" });

    const events = await bus.readGlobal();
    expect(events).toHaveLength(3);
    expect(events[0].payload).toBe("A");
    expect(events[1].payload).toBe("B");
    expect(events[2].payload).toBe("C");
  });

  it("publishToAgent writes to agent stream", async () => {
    await bus.publishToAgent("a2", {
      type: "message.inbound",
      sourceAgentId: "a1",
      payload: "hello",
    });

    const agentEvents = await bus.readAgent("a2");
    expect(agentEvents).toHaveLength(1);
    expect(agentEvents[0].type).toBe("message.inbound");
    expect(agentEvents[0].agentId).toBe("a1");

    // Should NOT appear in global stream
    const global = await bus.readGlobal();
    expect(global).toHaveLength(0);
  });

  it("directed event fans out to both global and agent stream", async () => {
    await bus.publish({
      type: "message.outbound",
      agentId: "a1",
      payload: "directed",
      targetAgentId: "a2",
    });

    const global = await bus.readGlobal();
    expect(global).toHaveLength(1);

    const agent = await bus.readAgent("a2");
    expect(agent).toHaveLength(1);
    expect(agent[0].payload).toBe("directed");
  });

  it("filter by type returns only matching events", async () => {
    await bus.publish({ type: "task.created", agentId: "a1", payload: "1" });
    await bus.publish({ type: "goal.completed", agentId: "a1", payload: "2" });
    await bus.publish({ type: "task.created", agentId: "a1", payload: "3" });

    const filtered = await bus.readGlobal({ type: "task.created" });
    expect(filtered).toHaveLength(2);
    for (const e of filtered) {
      expect(e.type).toBe("task.created");
    }
  });

  it("latest returns last N events", async () => {
    for (let i = 0; i < 10; i++) {
      await bus.publish({ type: "custom", agentId: "a1", payload: String(i) });
    }

    const last3 = await bus.latest(3);
    expect(last3).toHaveLength(3);
    expect(last3[0].payload).toBe("7");
    expect(last3[1].payload).toBe("8");
    expect(last3[2].payload).toBe("9");
  });

  it("trimGlobal keeps approximately maxLen events", async () => {
    for (let i = 0; i < 20; i++) {
      await bus.publish({ type: "custom", agentId: "a1", payload: String(i) });
    }

    await bus.trimGlobal(5);
    const events = await bus.readGlobal();
    expect(events).toHaveLength(5);
    // Should keep the last 5
    expect(events[0].payload).toBe("15");
    expect(events[4].payload).toBe("19");
  });
});
