import type { GatewayRequestHandlers } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

export const tasksHandlers: GatewayRequestHandlers = {
  "task.create": async ({ params, respond, context }) => {
    const store = context.taskStore;
    if (!store) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Redis storage not configured"));
      return;
    }
    const p = params as {
      agentId?: string;
      title?: string;
      description?: string;
      priority?: number;
    };
    if (!p.title) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "title required"));
      return;
    }
    const agentId = p.agentId || "default";
    const task = await store.create({
      agentId,
      title: p.title,
      description: p.description,
      priority: p.priority as 1 | 2 | 3 | 4 | 5 | undefined,
    });
    respond(true, task);
  },

  "task.list": async ({ params, respond, context }) => {
    const store = context.taskStore;
    if (!store) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Redis storage not configured"));
      return;
    }
    const p = params as { agentId?: string; status?: string };
    const agentId = p.agentId || "default";
    const tasks = await store.list(
      agentId,
      p.status
        ? { status: p.status as "pending" | "active" | "completed" | "failed" | "cancelled" }
        : undefined,
    );
    respond(true, { tasks });
  },

  "task.get": async ({ params, respond, context }) => {
    const store = context.taskStore;
    if (!store) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Redis storage not configured"));
      return;
    }
    const p = params as { agentId?: string; taskId?: string };
    if (!p.taskId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "taskId required"));
      return;
    }
    const agentId = p.agentId || "default";
    const task = await store.get(agentId, p.taskId);
    if (!task) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "task not found"));
      return;
    }
    respond(true, task);
  },

  "task.complete": async ({ params, respond, context }) => {
    const store = context.taskStore;
    if (!store) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Redis storage not configured"));
      return;
    }
    const p = params as { agentId?: string; taskId?: string; result?: string };
    if (!p.taskId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "taskId required"));
      return;
    }
    const agentId = p.agentId || "default";
    const task = await store.complete(agentId, p.taskId, p.result);
    if (!task) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "task not found"));
      return;
    }
    respond(true, task);
  },

  "task.fail": async ({ params, respond, context }) => {
    const store = context.taskStore;
    if (!store) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Redis storage not configured"));
      return;
    }
    const p = params as { agentId?: string; taskId?: string; error?: string };
    if (!p.taskId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "taskId required"));
      return;
    }
    const agentId = p.agentId || "default";
    const task = await store.fail(agentId, p.taskId, p.error ?? "unknown error");
    if (!task) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "task not found"));
      return;
    }
    respond(true, task);
  },

  "task.cancel": async ({ params, respond, context }) => {
    const store = context.taskStore;
    if (!store) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Redis storage not configured"));
      return;
    }
    const p = params as { agentId?: string; taskId?: string };
    if (!p.taskId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "taskId required"));
      return;
    }
    const agentId = p.agentId || "default";
    const task = await store.cancel(agentId, p.taskId);
    if (!task) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "task not found"));
      return;
    }
    respond(true, task);
  },

  "task.update": async ({ params, respond, context }) => {
    const store = context.taskStore;
    if (!store) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Redis storage not configured"));
      return;
    }
    const p = params as {
      agentId?: string;
      taskId?: string;
      title?: string;
      description?: string;
      priority?: number;
    };
    if (!p.taskId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "taskId required"));
      return;
    }
    const agentId = p.agentId || "default";
    const task = await store.update(agentId, p.taskId, {
      title: p.title,
      description: p.description,
      priority: p.priority as 1 | 2 | 3 | 4 | 5 | undefined,
    });
    if (!task) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "task not found"));
      return;
    }
    respond(true, task);
  },

  "task.count": async ({ params, respond, context }) => {
    const store = context.taskStore;
    if (!store) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Redis storage not configured"));
      return;
    }
    const p = params as { agentId?: string };
    const agentId = p.agentId || "default";
    const counts = await store.count(agentId);
    respond(true, counts);
  },
};
