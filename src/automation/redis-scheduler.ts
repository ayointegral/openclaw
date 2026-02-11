import { randomUUID } from "node:crypto";
import type { StorageBackend } from "../infra/storage-backend.js";

export type ScheduleType = "once" | "interval" | "cron";
export type JobStatus = "scheduled" | "running" | "completed" | "failed" | "disabled";

export type JobData = {
  id: string;
  agentId: string;
  name: string;
  scheduleType: ScheduleType;
  scheduleExpr: string;
  status: JobStatus;
  nextRunAt: number;
  lastRunAt?: number;
  lastRunDurationMs?: number;
  lastRunError?: string;
  runCount: number;
  maxRuns?: number;
  payload?: string;
  createdAt: number;
  updatedAt: number;
};

const SCHEDULE_KEY = "auto:schedule";
const jk = (a: string, j: string) => `auto:${a}:${j}`;
const ajk = (a: string) => `auto:jobs:${a}`;
const mk = (a: string, j: string) => `${a}:${j}`;
const OPT_NUM: (keyof JobData)[] = ["lastRunAt", "lastRunDurationMs", "maxRuns"];
const OPT_STR: (keyof JobData)[] = ["lastRunError", "payload"];

function jobToHash(job: JobData): Record<string, string> {
  const rec: Record<string, string> = {
    id: job.id,
    agentId: job.agentId,
    name: job.name,
    scheduleType: job.scheduleType,
    scheduleExpr: job.scheduleExpr,
    status: job.status,
    nextRunAt: String(job.nextRunAt),
    runCount: String(job.runCount),
    createdAt: String(job.createdAt),
    updatedAt: String(job.updatedAt),
  };
  for (const k of OPT_NUM) {
    if (job[k] !== undefined) {
      rec[k] = String(job[k]);
    }
  }
  for (const k of OPT_STR) {
    if (job[k] !== undefined) {
      rec[k] = job[k] as string;
    }
  }
  return rec;
}
function hashToJob(rec: Record<string, string>): JobData {
  const job: JobData = {
    id: rec.id,
    agentId: rec.agentId,
    name: rec.name,
    scheduleType: rec.scheduleType as ScheduleType,
    scheduleExpr: rec.scheduleExpr,
    status: rec.status as JobStatus,
    nextRunAt: Number(rec.nextRunAt),
    runCount: Number(rec.runCount),
    createdAt: Number(rec.createdAt),
    updatedAt: Number(rec.updatedAt),
  };
  for (const k of OPT_NUM) {
    if (rec[k] !== undefined) {
      (job as Record<string, unknown>)[k] = Number(rec[k]);
    }
  }
  for (const k of OPT_STR) {
    if (rec[k] !== undefined) {
      (job as Record<string, unknown>)[k] = rec[k];
    }
  }
  return job;
}
function computeFirstRun(type: ScheduleType, expr: string): number {
  if (type === "once") {
    const n = Number(expr);
    return Number.isNaN(n) ? new Date(expr).getTime() : n;
  }
  if (type === "interval") {
    return Date.now() + Number(expr);
  }
  return Date.now(); // "cron": immediate first run (real parsing deferred)
}
function computeNextRun(job: JobData): number | null {
  if (job.scheduleType === "once") {
    return null;
  }
  const base = job.lastRunAt ?? Date.now();
  if (job.scheduleType === "interval") {
    return base + Number(job.scheduleExpr);
  }
  return base + 60_000; // "cron" placeholder: 60 s after last run
}

export class Scheduler {
  constructor(private readonly storage: StorageBackend) {}
  private save(job: JobData): Promise<void> {
    return this.storage.hmset(jk(job.agentId, job.id), jobToHash(job));
  }

  /** Schedule a new job */
  async schedule(params: {
    agentId: string;
    name: string;
    scheduleType: ScheduleType;
    scheduleExpr: string;
    payload?: string;
    maxRuns?: number;
  }): Promise<JobData> {
    const now = Date.now();
    const id = randomUUID();
    const nextRunAt = computeFirstRun(params.scheduleType, params.scheduleExpr);
    const job: JobData = {
      id,
      agentId: params.agentId,
      name: params.name,
      scheduleType: params.scheduleType,
      scheduleExpr: params.scheduleExpr,
      status: "scheduled",
      nextRunAt,
      runCount: 0,
      maxRuns: params.maxRuns,
      payload: params.payload,
      createdAt: now,
      updatedAt: now,
    };
    await this.save(job);
    await this.storage.zadd(SCHEDULE_KEY, nextRunAt, mk(params.agentId, id));
    await this.storage.sadd(ajk(params.agentId), id);
    return job;
  }

  /** Get a job by ID */
  async get(agentId: string, jobId: string): Promise<JobData | null> {
    const rec = await this.storage.hgetall(jk(agentId, jobId));
    return rec ? hashToJob(rec) : null;
  }
  /** List all jobs for an agent */
  async list(agentId: string): Promise<JobData[]> {
    const ids = await this.storage.smembers(ajk(agentId));
    const jobs: JobData[] = [];
    for (const id of ids) {
      const job = await this.get(agentId, id);
      if (job) {
        jobs.push(job);
      }
    }
    return jobs;
  }
  /** Poll for due jobs (nextRunAt <= now) */
  async pollDue(limit?: number): Promise<JobData[]> {
    const members = await this.storage.zrangebyscore(SCHEDULE_KEY, 0, Date.now(), limit);
    const jobs: JobData[] = [];
    for (const member of members) {
      const sep = member.indexOf(":");
      if (sep < 0) {
        continue;
      }
      const job = await this.get(member.slice(0, sep), member.slice(sep + 1));
      if (job && job.status === "scheduled") {
        jobs.push(job);
      }
    }
    return jobs;
  }

  /** Mark a job as running (claim it) */
  async markRunning(agentId: string, jobId: string): Promise<JobData | null> {
    const job = await this.get(agentId, jobId);
    if (!job || job.status !== "scheduled") {
      return null;
    }
    job.status = "running";
    job.updatedAt = Date.now();
    await this.storage.zrem(SCHEDULE_KEY, mk(agentId, jobId));
    await this.save(job);
    return job;
  }

  /** Mark a job run complete, compute next run time */
  async markComplete(agentId: string, jobId: string, durationMs: number): Promise<JobData | null> {
    const job = await this.get(agentId, jobId);
    if (!job) {
      return null;
    }
    const now = Date.now();
    job.runCount += 1;
    job.lastRunAt = now;
    job.lastRunDurationMs = durationMs;
    job.lastRunError = undefined;
    job.updatedAt = now;
    // Max runs reached or one-shot → completed
    const maxed = job.maxRuns !== undefined && job.runCount >= job.maxRuns;
    const next = maxed ? null : computeNextRun(job);
    if (next === null) {
      job.status = "completed";
      await this.storage.zrem(SCHEDULE_KEY, mk(agentId, jobId));
    } else {
      job.status = "scheduled";
      job.nextRunAt = next;
      await this.storage.zadd(SCHEDULE_KEY, next, mk(agentId, jobId));
    }
    await this.save(job);
    return job;
  }

  /** Mark a job run failed */
  async markFailed(
    agentId: string,
    jobId: string,
    error: string,
    durationMs: number,
  ): Promise<JobData | null> {
    const job = await this.get(agentId, jobId);
    if (!job) {
      return null;
    }
    const now = Date.now();
    job.runCount += 1;
    job.lastRunAt = now;
    job.lastRunDurationMs = durationMs;
    job.lastRunError = error;
    job.status = "failed";
    job.updatedAt = now;
    // Keep in schedule for retry on next cycle
    const next = computeNextRun(job);
    if (next !== null) {
      job.nextRunAt = next;
      job.status = "scheduled";
      await this.storage.zadd(SCHEDULE_KEY, next, mk(agentId, jobId));
    }
    await this.save(job);
    return job;
  }
  /** Disable a job (remove from schedule) */
  async disable(agentId: string, jobId: string): Promise<JobData | null> {
    const job = await this.get(agentId, jobId);
    if (!job) {
      return null;
    }
    job.status = "disabled";
    job.updatedAt = Date.now();
    await this.storage.zrem(SCHEDULE_KEY, mk(agentId, jobId));
    await this.save(job);
    return job;
  }

  /** Enable a disabled job (re-schedule) */
  async enable(agentId: string, jobId: string): Promise<JobData | null> {
    const job = await this.get(agentId, jobId);
    if (!job || job.status !== "disabled") {
      return null;
    }
    job.status = "scheduled";
    job.updatedAt = Date.now();
    await this.storage.zadd(SCHEDULE_KEY, job.nextRunAt, mk(agentId, jobId));
    await this.save(job);
    return job;
  }

  /** Delete a job entirely */
  async remove(agentId: string, jobId: string): Promise<boolean> {
    const exists = await this.storage.exists(jk(agentId, jobId));
    if (!exists) {
      return false;
    }
    await this.storage.delete(jk(agentId, jobId));
    await this.storage.zrem(SCHEDULE_KEY, mk(agentId, jobId));
    await this.storage.srem(ajk(agentId), jobId);
    return true;
  }
}
