import { Type } from "@sinclair/typebox";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";

const TASK_ACTIONS = [
  "create",
  "list",
  "get",
  "complete",
  "fail",
  "cancel",
  "update",
  "count",
] as const;

const TASK_PRIORITIES = ["low", "medium", "high", "critical"] as const;
const TASK_STATUSES = ["queued", "running", "completed", "failed", "cancelled"] as const;

const TaskToolSchema = Type.Object({
  action: stringEnum(TASK_ACTIONS),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  agentId: Type.Optional(Type.String()),
  taskId: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  priority: optionalStringEnum(TASK_PRIORITIES),
  status: optionalStringEnum(TASK_STATUSES),
  result: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
});

const PRIORITY_MAP: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 5,
};

export function createTaskTool(): AnyAgentTool {
  return {
    label: "Task Manager",
    name: "task_manager",
    description: `Manage tasks — create, track, complete, and query task queues.

ACTIONS:
- create: Create a new task (requires title, optional description/priority)
- list: List tasks for an agent (optional status filter)
- get: Get a task by ID (requires taskId)
- complete: Mark a task as completed (requires taskId, optional result)
- fail: Mark a task as failed (requires taskId, optional error)
- cancel: Cancel a task (requires taskId)
- update: Update task fields (requires taskId, optional title/description/priority)
- count: Count tasks by status for an agent`,
    parameters: TaskToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const gatewayOpts: GatewayCallOptions = {
        gatewayUrl: readStringParam(params, "gatewayUrl", { trim: false }),
        gatewayToken: readStringParam(params, "gatewayToken", { trim: false }),
        timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : 60_000,
      };

      switch (action) {
        case "create": {
          const title = readStringParam(params, "title", { required: true });
          const description = readStringParam(params, "description");
          const priorityStr = readStringParam(params, "priority");
          const priority = priorityStr ? PRIORITY_MAP[priorityStr] : undefined;
          const agentId = readStringParam(params, "agentId");
          return jsonResult(
            await callGatewayTool("task.create", gatewayOpts, {
              agentId,
              title,
              description,
              priority,
            }),
          );
        }
        case "list": {
          const agentId = readStringParam(params, "agentId");
          const status = readStringParam(params, "status");
          return jsonResult(await callGatewayTool("task.list", gatewayOpts, { agentId, status }));
        }
        case "get": {
          const taskId = readStringParam(params, "taskId", { required: true });
          const agentId = readStringParam(params, "agentId");
          return jsonResult(await callGatewayTool("task.get", gatewayOpts, { agentId, taskId }));
        }
        case "complete": {
          const taskId = readStringParam(params, "taskId", { required: true });
          const agentId = readStringParam(params, "agentId");
          const result = readStringParam(params, "result");
          return jsonResult(
            await callGatewayTool("task.complete", gatewayOpts, { agentId, taskId, result }),
          );
        }
        case "fail": {
          const taskId = readStringParam(params, "taskId", { required: true });
          const agentId = readStringParam(params, "agentId");
          const error = readStringParam(params, "error");
          return jsonResult(
            await callGatewayTool("task.fail", gatewayOpts, { agentId, taskId, error }),
          );
        }
        case "cancel": {
          const taskId = readStringParam(params, "taskId", { required: true });
          const agentId = readStringParam(params, "agentId");
          return jsonResult(await callGatewayTool("task.cancel", gatewayOpts, { agentId, taskId }));
        }
        case "update": {
          const taskId = readStringParam(params, "taskId", { required: true });
          const agentId = readStringParam(params, "agentId");
          const title = readStringParam(params, "title");
          const description = readStringParam(params, "description");
          const priorityStr = readStringParam(params, "priority");
          const priority = priorityStr ? PRIORITY_MAP[priorityStr] : undefined;
          return jsonResult(
            await callGatewayTool("task.update", gatewayOpts, {
              agentId,
              taskId,
              title,
              description,
              priority,
            }),
          );
        }
        case "count": {
          const agentId = readStringParam(params, "agentId");
          return jsonResult(await callGatewayTool("task.count", gatewayOpts, { agentId }));
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
