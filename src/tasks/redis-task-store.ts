import { randomUUID } from "node:crypto";
import type { StorageBackend } from "../infra/storage-backend.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type TaskStatus = "pending" | "active" | "completed" | "failed" | "cancelled";

export type TaskPriority = 1 | 2 | 3 | 4 | 5; // 1=lowest, 5=critical

export type TaskData = {
  id: string;
  agentId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  createdAt: number; // ms epoch
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: string;
  metadata?: Record<string, string>;
};

// ── Key helpers ──────────────────────────────────────────────────────────────

function taskKey(agentId: string, taskId: string): string {
  return `task:${agentId}:${taskId}`;
}

function queueKey(agentId: string): string {
  return `task:queue:${agentId}`;
}

function activeKey(agentId: string): string {
  return `task:active:${agentId}`;
}

/** Score: higher priority → lower score → dequeued first; same priority → FIFO */
function queueScore(priority: TaskPriority, createdAt: number): number {
  return (5 - priority) * 1e13 + createdAt;
}

// ── Serialization ────────────────────────────────────────────────────────────

function taskToHash(task: TaskData): Record<string, string> {
  const data: Record<string, string> = {
    id: task.id,
    agentId: task.agentId,
    title: task.title,
    status: task.status,
    priority: String(task.priority),
    createdAt: String(task.createdAt),
    updatedAt: String(task.updatedAt),
  };
  if (task.description) {
    data.description = task.description;
  }
  if (task.startedAt) {
    data.startedAt = String(task.startedAt);
  }
  if (task.completedAt) {
    data.completedAt = String(task.completedAt);
  }
  if (task.result) {
    data.result = task.result;
  }
  if (task.metadata) {
    data.metadata = JSON.stringify(task.metadata);
  }
  return data;
}

function hashToTask(raw: Record<string, string>): TaskData {
  return {
    id: raw.id,
    agentId: raw.agentId,
    title: raw.title,
    status: raw.status as TaskStatus,
    priority: Number(raw.priority) as TaskPriority,
    createdAt: Number(raw.createdAt),
    updatedAt: Number(raw.updatedAt),
    startedAt: raw.startedAt ? Number(raw.startedAt) : undefined,
    completedAt: raw.completedAt ? Number(raw.completedAt) : undefined,
    result: raw.result,
    metadata: raw.metadata ? JSON.parse(raw.metadata) : undefined,
  };
}

// ── Store ────────────────────────────────────────────────────────────────────

const DEFAULT_PURGE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class TaskStore {
  constructor(private readonly storage: StorageBackend) {}

  /** Create a new task and enqueue it */
  async create(params: {
    agentId: string;
    title: string;
    description?: string;
    priority?: TaskPriority;
    metadata?: Record<string, string>;
  }): Promise<TaskData> {
    const now = Date.now();
    const priority = params.priority ?? 3;
    const task: TaskData = {
      id: randomUUID(),
      agentId: params.agentId,
      title: params.title,
      description: params.description,
      status: "pending",
      priority,
      createdAt: now,
      updatedAt: now,
      metadata: params.metadata,
    };
    await this.storage.hmset(taskKey(task.agentId, task.id), taskToHash(task));
    await this.storage.zadd(queueKey(task.agentId), queueScore(priority, now), task.id);
    return task;
  }

  /** Get a task by ID */
  async get(agentId: string, taskId: string): Promise<TaskData | null> {
    const raw = await this.storage.hgetall(taskKey(agentId, taskId));
    return raw ? hashToTask(raw) : null;
  }

  /** List tasks for an agent, optionally filtered by status */
  async list(agentId: string, filter?: { status?: TaskStatus }): Promise<TaskData[]> {
    // Collect task IDs from both queue (pending) and active sets
    const [queueIds, activeIds] = await Promise.all([
      this.storage.zrangebyscore(queueKey(agentId), -Infinity, Infinity),
      this.storage.smembers(activeKey(agentId)),
    ]);
    const allIds = [...new Set([...queueIds, ...activeIds])];

    const tasks: TaskData[] = [];
    for (const id of allIds) {
      const raw = await this.storage.hgetall(taskKey(agentId, id));
      if (raw) {
        const task = hashToTask(raw);
        if (!filter?.status || task.status === filter.status) {
          tasks.push(task);
        }
      }
    }
    // Sort by priority desc, then createdAt asc
    tasks.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
    return tasks;
  }

  /** Dequeue the highest-priority pending task (claim it as active) */
  async dequeue(agentId: string): Promise<TaskData | null> {
    const ids = await this.storage.zrangebyscore(queueKey(agentId), -Infinity, Infinity, 1);
    if (ids.length === 0) {
      return null;
    }
    const taskId = ids[0];
    await this.storage.zrem(queueKey(agentId), taskId);

    const now = Date.now();
    await this.storage.hmset(taskKey(agentId, taskId), {
      status: "active",
      startedAt: String(now),
      updatedAt: String(now),
    });
    await this.storage.sadd(activeKey(agentId), taskId);

    return this.get(agentId, taskId);
  }

  /** Complete a task with optional result */
  async complete(agentId: string, taskId: string, result?: string): Promise<TaskData | null> {
    return this.transition(agentId, taskId, "completed", result);
  }

  /** Fail a task with error message */
  async fail(agentId: string, taskId: string, error: string): Promise<TaskData | null> {
    return this.transition(agentId, taskId, "failed", error);
  }

  /** Cancel a task */
  async cancel(agentId: string, taskId: string): Promise<TaskData | null> {
    return this.transition(agentId, taskId, "cancelled");
  }

  /** Update task metadata or priority */
  async update(
    agentId: string,
    taskId: string,
    patch: {
      title?: string;
      description?: string;
      priority?: TaskPriority;
      metadata?: Record<string, string>;
    },
  ): Promise<TaskData | null> {
    const existing = await this.get(agentId, taskId);
    if (!existing) {
      return null;
    }

    const fields: Record<string, string> = { updatedAt: String(Date.now()) };
    if (patch.title !== undefined) {
      fields.title = patch.title;
    }
    if (patch.description !== undefined) {
      fields.description = patch.description;
    }
    if (patch.priority !== undefined) {
      fields.priority = String(patch.priority);
    }
    if (patch.metadata !== undefined) {
      fields.metadata = JSON.stringify(patch.metadata);
    }
    await this.storage.hmset(taskKey(agentId, taskId), fields);

    // Recompute queue score if priority changed and task is still pending
    if (patch.priority !== undefined && existing.status === "pending") {
      await this.storage.zrem(queueKey(agentId), taskId);
      await this.storage.zadd(
        queueKey(agentId),
        queueScore(patch.priority, existing.createdAt),
        taskId,
      );
    }

    return this.get(agentId, taskId);
  }

  /** Count tasks by status for an agent */
  async count(agentId: string): Promise<Record<TaskStatus, number>> {
    const tasks = await this.list(agentId);
    const counts: Record<TaskStatus, number> = {
      pending: 0,
      active: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const t of tasks) {
      counts[t.status]++;
    }
    return counts;
  }

  /** Purge completed/failed/cancelled tasks older than maxAgeMs */
  async purge(agentId: string, maxAgeMs?: number): Promise<number> {
    const cutoff = Date.now() - (maxAgeMs ?? DEFAULT_PURGE_AGE_MS);
    const tasks = await this.list(agentId);
    let purged = 0;

    for (const task of tasks) {
      const terminal =
        task.status === "completed" || task.status === "failed" || task.status === "cancelled";
      if (terminal && task.updatedAt < cutoff) {
        await this.storage.delete(taskKey(agentId, task.id));
        // Clean up from any set/sorted-set just in case
        await this.storage.zrem(queueKey(agentId), task.id);
        await this.storage.srem(activeKey(agentId), task.id);
        purged++;
      }
    }
    return purged;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /** Transition a task to a terminal or active state */
  private async transition(
    agentId: string,
    taskId: string,
    status: TaskStatus,
    result?: string,
  ): Promise<TaskData | null> {
    const existing = await this.get(agentId, taskId);
    if (!existing) {
      return null;
    }

    const now = Date.now();
    const fields: Record<string, string> = {
      status,
      updatedAt: String(now),
    };
    if (status === "completed" || status === "failed" || status === "cancelled") {
      fields.completedAt = String(now);
    }
    if (result !== undefined) {
      fields.result = result;
    }
    await this.storage.hmset(taskKey(agentId, taskId), fields);

    // Remove from queue/active sets as appropriate
    await this.storage.zrem(queueKey(agentId), taskId);
    await this.storage.srem(activeKey(agentId), taskId);

    return this.get(agentId, taskId);
  }
}
