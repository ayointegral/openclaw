import type { GatewayRequestHandlers } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

export const goalsHandlers: GatewayRequestHandlers = {
  "goal.create": async ({ params, respond, context }) => {
    const store = context.goalStore;
    if (!store) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Redis storage not configured"));
      return;
    }
    const p = params as {
      agentId?: string;
      title?: string;
      description?: string;
      parentGoalId?: string;
    };
    if (!p.title) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "title required"));
      return;
    }
    const agentId = p.agentId || "default";
    const goal = await store.create({
      agentId,
      title: p.title,
      description: p.description,
      parentGoalId: p.parentGoalId,
    });
    respond(true, goal);
  },

  "goal.list": async ({ params, respond, context }) => {
    const store = context.goalStore;
    if (!store) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Redis storage not configured"));
      return;
    }
    const p = params as { agentId?: string };
    const agentId = p.agentId || "default";
    const goals = await store.list(agentId);
    respond(true, { goals });
  },

  "goal.get": async ({ params, respond, context }) => {
    const store = context.goalStore;
    if (!store) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Redis storage not configured"));
      return;
    }
    const p = params as { agentId?: string; goalId?: string };
    if (!p.goalId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "goalId required"));
      return;
    }
    const agentId = p.agentId || "default";
    const goal = await store.get(agentId, p.goalId);
    if (!goal) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "goal not found"));
      return;
    }
    respond(true, goal);
  },

  "goal.update.progress": async ({ params, respond, context }) => {
    const store = context.goalStore;
    if (!store) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Redis storage not configured"));
      return;
    }
    const p = params as { agentId?: string; goalId?: string; progress?: number };
    if (!p.goalId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "goalId required"));
      return;
    }
    if (p.progress === undefined || typeof p.progress !== "number") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "progress required (0-100)"),
      );
      return;
    }
    const agentId = p.agentId || "default";
    const goal = await store.updateProgress(agentId, p.goalId, p.progress);
    if (!goal) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "goal not found"));
      return;
    }
    respond(true, goal);
  },

  "goal.complete": async ({ params, respond, context }) => {
    const store = context.goalStore;
    if (!store) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Redis storage not configured"));
      return;
    }
    const p = params as { agentId?: string; goalId?: string };
    if (!p.goalId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "goalId required"));
      return;
    }
    const agentId = p.agentId || "default";
    const goal = await store.complete(agentId, p.goalId);
    if (!goal) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "goal not found"));
      return;
    }
    respond(true, goal);
  },

  "goal.pause": async ({ params, respond, context }) => {
    const store = context.goalStore;
    if (!store) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Redis storage not configured"));
      return;
    }
    const p = params as { agentId?: string; goalId?: string };
    if (!p.goalId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "goalId required"));
      return;
    }
    const agentId = p.agentId || "default";
    const goal = await store.pause(agentId, p.goalId);
    if (!goal) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "goal not found"));
      return;
    }
    respond(true, goal);
  },

  "goal.resume": async ({ params, respond, context }) => {
    const store = context.goalStore;
    if (!store) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Redis storage not configured"));
      return;
    }
    const p = params as { agentId?: string; goalId?: string };
    if (!p.goalId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "goalId required"));
      return;
    }
    const agentId = p.agentId || "default";
    const goal = await store.resume(agentId, p.goalId);
    if (!goal) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "goal not found"));
      return;
    }
    respond(true, goal);
  },

  "goal.abandon": async ({ params, respond, context }) => {
    const store = context.goalStore;
    if (!store) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Redis storage not configured"));
      return;
    }
    const p = params as { agentId?: string; goalId?: string };
    if (!p.goalId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "goalId required"));
      return;
    }
    const agentId = p.agentId || "default";
    const goal = await store.abandon(agentId, p.goalId);
    if (!goal) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "goal not found"));
      return;
    }
    respond(true, goal);
  },
};
