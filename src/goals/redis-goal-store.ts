import { randomUUID } from "node:crypto";
import type { StorageBackend } from "../infra/storage-backend.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type GoalStatus = "active" | "paused" | "completed" | "abandoned";

export type GoalData = {
  id: string;
  agentId: string;
  title: string;
  description?: string;
  status: GoalStatus;
  progress: number; // 0-100 percentage
  parentGoalId?: string; // for sub-goals
  taskIds: string[]; // linked task IDs
  createdAt: number; // ms epoch
  updatedAt: number;
  completedAt?: number;
  metadata?: Record<string, string>;
};

// ── Key helpers ──────────────────────────────────────────────────────────────

function goalKey(agentId: string, goalId: string): string {
  return `goal:${agentId}:${goalId}`;
}

function activeSetKey(agentId: string): string {
  return `goal:active:${agentId}`;
}

function allSetKey(agentId: string): string {
  return `goal:all:${agentId}`;
}

// ── Serialization ────────────────────────────────────────────────────────────

function goalToHash(goal: GoalData): Record<string, string> {
  const data: Record<string, string> = {
    id: goal.id,
    agentId: goal.agentId,
    title: goal.title,
    status: goal.status,
    progress: String(goal.progress),
    taskIds: JSON.stringify(goal.taskIds),
    createdAt: String(goal.createdAt),
    updatedAt: String(goal.updatedAt),
  };
  if (goal.description) {
    data.description = goal.description;
  }
  if (goal.parentGoalId) {
    data.parentGoalId = goal.parentGoalId;
  }
  if (goal.completedAt) {
    data.completedAt = String(goal.completedAt);
  }
  if (goal.metadata) {
    data.metadata = JSON.stringify(goal.metadata);
  }
  return data;
}

function hashToGoal(raw: Record<string, string>): GoalData {
  return {
    id: raw.id,
    agentId: raw.agentId,
    title: raw.title,
    status: raw.status as GoalStatus,
    progress: Number(raw.progress),
    taskIds: raw.taskIds ? JSON.parse(raw.taskIds) : [],
    createdAt: Number(raw.createdAt),
    updatedAt: Number(raw.updatedAt),
    description: raw.description || undefined,
    parentGoalId: raw.parentGoalId || undefined,
    completedAt: raw.completedAt ? Number(raw.completedAt) : undefined,
    metadata: raw.metadata ? JSON.parse(raw.metadata) : undefined,
  };
}

// ── Store ────────────────────────────────────────────────────────────────────

export class GoalStore {
  constructor(private readonly storage: StorageBackend) {}

  /** Create a new goal */
  async create(params: {
    agentId: string;
    title: string;
    description?: string;
    parentGoalId?: string;
    metadata?: Record<string, string>;
  }): Promise<GoalData> {
    const now = Date.now();
    const goal: GoalData = {
      id: randomUUID(),
      agentId: params.agentId,
      title: params.title,
      description: params.description,
      status: "active",
      progress: 0,
      parentGoalId: params.parentGoalId,
      taskIds: [],
      createdAt: now,
      updatedAt: now,
      metadata: params.metadata,
    };
    await this.storage.hmset(goalKey(goal.agentId, goal.id), goalToHash(goal));
    await this.storage.sadd(allSetKey(goal.agentId), goal.id);
    await this.storage.sadd(activeSetKey(goal.agentId), goal.id);
    return goal;
  }

  /** Get a goal by ID */
  async get(agentId: string, goalId: string): Promise<GoalData | null> {
    const raw = await this.storage.hgetall(goalKey(agentId, goalId));
    return raw ? hashToGoal(raw) : null;
  }

  /** List goals for an agent, optionally filtered by status */
  async list(agentId: string, filter?: { status?: GoalStatus }): Promise<GoalData[]> {
    const ids = await this.storage.smembers(allSetKey(agentId));
    const goals: GoalData[] = [];
    for (const id of ids) {
      const raw = await this.storage.hgetall(goalKey(agentId, id));
      if (raw) {
        const goal = hashToGoal(raw);
        if (!filter?.status || goal.status === filter.status) {
          goals.push(goal);
        }
      }
    }
    goals.sort((a, b) => a.createdAt - b.createdAt);
    return goals;
  }

  /** Update goal progress (0-100) */
  async updateProgress(
    agentId: string,
    goalId: string,
    progress: number,
  ): Promise<GoalData | null> {
    const existing = await this.get(agentId, goalId);
    if (!existing) {
      return null;
    }
    const clamped = Math.max(0, Math.min(100, progress));
    await this.storage.hmset(goalKey(agentId, goalId), {
      progress: String(clamped),
      updatedAt: String(Date.now()),
    });
    return this.get(agentId, goalId);
  }

  /** Link a task to a goal */
  async linkTask(agentId: string, goalId: string, taskId: string): Promise<GoalData | null> {
    const existing = await this.get(agentId, goalId);
    if (!existing) {
      return null;
    }
    if (!existing.taskIds.includes(taskId)) {
      existing.taskIds.push(taskId);
      await this.storage.hmset(goalKey(agentId, goalId), {
        taskIds: JSON.stringify(existing.taskIds),
        updatedAt: String(Date.now()),
      });
    }
    return this.get(agentId, goalId);
  }

  /** Unlink a task from a goal */
  async unlinkTask(agentId: string, goalId: string, taskId: string): Promise<GoalData | null> {
    const existing = await this.get(agentId, goalId);
    if (!existing) {
      return null;
    }
    const filtered = existing.taskIds.filter((id) => id !== taskId);
    if (filtered.length !== existing.taskIds.length) {
      await this.storage.hmset(goalKey(agentId, goalId), {
        taskIds: JSON.stringify(filtered),
        updatedAt: String(Date.now()),
      });
    }
    return this.get(agentId, goalId);
  }

  /** Complete a goal */
  async complete(agentId: string, goalId: string): Promise<GoalData | null> {
    return this.setStatus(agentId, goalId, "completed");
  }

  /** Pause a goal */
  async pause(agentId: string, goalId: string): Promise<GoalData | null> {
    return this.setStatus(agentId, goalId, "paused");
  }

  /** Resume a paused goal */
  async resume(agentId: string, goalId: string): Promise<GoalData | null> {
    return this.setStatus(agentId, goalId, "active");
  }

  /** Abandon a goal */
  async abandon(agentId: string, goalId: string): Promise<GoalData | null> {
    return this.setStatus(agentId, goalId, "abandoned");
  }

  /** Get sub-goals of a parent goal */
  async getSubGoals(agentId: string, parentGoalId: string): Promise<GoalData[]> {
    const all = await this.list(agentId);
    return all.filter((g) => g.parentGoalId === parentGoalId);
  }

  /** Update goal metadata */
  async update(
    agentId: string,
    goalId: string,
    patch: {
      title?: string;
      description?: string;
      metadata?: Record<string, string>;
    },
  ): Promise<GoalData | null> {
    const existing = await this.get(agentId, goalId);
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
    if (patch.metadata !== undefined) {
      fields.metadata = JSON.stringify(patch.metadata);
    }
    await this.storage.hmset(goalKey(agentId, goalId), fields);
    return this.get(agentId, goalId);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /** Transition a goal to a new status, managing active set membership */
  private async setStatus(
    agentId: string,
    goalId: string,
    status: GoalStatus,
  ): Promise<GoalData | null> {
    const existing = await this.get(agentId, goalId);
    if (!existing) {
      return null;
    }
    const now = Date.now();
    const fields: Record<string, string> = {
      status,
      updatedAt: String(now),
    };
    if (status === "completed" || status === "abandoned") {
      fields.completedAt = String(now);
    }
    if (status === "completed") {
      fields.progress = "100";
    }
    await this.storage.hmset(goalKey(agentId, goalId), fields);

    // Manage active set: add for active, remove for terminal/paused
    if (status === "active") {
      await this.storage.sadd(activeSetKey(agentId), goalId);
    } else {
      await this.storage.srem(activeSetKey(agentId), goalId);
    }

    return this.get(agentId, goalId);
  }
}
