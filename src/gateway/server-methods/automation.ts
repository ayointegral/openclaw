import type { ScheduleType } from "../../automation/redis-scheduler.js";
import type { GatewayRequestHandlers } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

export const automationHandlers: GatewayRequestHandlers = {
  "automation.schedule": async ({ params, respond, context }) => {
    const sched = context.scheduler;
    if (!sched) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Redis storage not configured"));
      return;
    }
    const p = params as {
      agentId?: string;
      name?: string;
      scheduleType?: string;
      scheduleExpr?: string;
      payload?: string;
      maxRuns?: number;
    };
    if (!p.name || !p.scheduleType || !p.scheduleExpr) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "name, scheduleType, and scheduleExpr required"),
      );
      return;
    }
    const agentId = p.agentId || "default";
    const job = await sched.schedule({
      agentId,
      name: p.name,
      scheduleType: p.scheduleType as ScheduleType,
      scheduleExpr: p.scheduleExpr,
      payload: p.payload,
      maxRuns: p.maxRuns,
    });
    respond(true, job);
  },

  "automation.list": async ({ params, respond, context }) => {
    const sched = context.scheduler;
    if (!sched) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Redis storage not configured"));
      return;
    }
    const p = params as { agentId?: string };
    const agentId = p.agentId || "default";
    const jobs = await sched.list(agentId);
    respond(true, { jobs });
  },

  "automation.get": async ({ params, respond, context }) => {
    const sched = context.scheduler;
    if (!sched) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Redis storage not configured"));
      return;
    }
    const p = params as { agentId?: string; jobId?: string };
    if (!p.jobId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "jobId required"));
      return;
    }
    const agentId = p.agentId || "default";
    const job = await sched.get(agentId, p.jobId);
    if (!job) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "job not found"));
      return;
    }
    respond(true, job);
  },

  "automation.disable": async ({ params, respond, context }) => {
    const sched = context.scheduler;
    if (!sched) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Redis storage not configured"));
      return;
    }
    const p = params as { agentId?: string; jobId?: string };
    if (!p.jobId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "jobId required"));
      return;
    }
    const agentId = p.agentId || "default";
    const job = await sched.disable(agentId, p.jobId);
    if (!job) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "job not found"));
      return;
    }
    respond(true, job);
  },

  "automation.enable": async ({ params, respond, context }) => {
    const sched = context.scheduler;
    if (!sched) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Redis storage not configured"));
      return;
    }
    const p = params as { agentId?: string; jobId?: string };
    if (!p.jobId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "jobId required"));
      return;
    }
    const agentId = p.agentId || "default";
    const job = await sched.enable(agentId, p.jobId);
    if (!job) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "job not found or not disabled"),
      );
      return;
    }
    respond(true, job);
  },

  "automation.remove": async ({ params, respond, context }) => {
    const sched = context.scheduler;
    if (!sched) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Redis storage not configured"));
      return;
    }
    const p = params as { agentId?: string; jobId?: string };
    if (!p.jobId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "jobId required"));
      return;
    }
    const agentId = p.agentId || "default";
    const removed = await sched.remove(agentId, p.jobId);
    respond(true, { removed });
  },
};
