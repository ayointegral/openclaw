import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam } from "./common.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";

const GOAL_ACTIONS = [
  "create",
  "list",
  "get",
  "update_progress",
  "complete",
  "pause",
  "resume",
  "abandon",
] as const;

const GoalToolSchema = Type.Object({
  action: stringEnum(GOAL_ACTIONS),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  agentId: Type.Optional(Type.String()),
  goalId: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  progress: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  parentGoalId: Type.Optional(Type.String()),
  taskId: Type.Optional(Type.String()),
});

export function createGoalTool(): AnyAgentTool {
  return {
    label: "Goal Tracker",
    name: "goal_tracker",
    description: `Track goals — create, monitor progress, and manage goal lifecycle.

ACTIONS:
- create: Create a new goal (requires title, optional description/parentGoalId)
- list: List goals for an agent
- get: Get a goal by ID (requires goalId)
- update_progress: Update goal progress 0-100 (requires goalId + progress)
- complete: Mark a goal as completed (requires goalId)
- pause: Pause a goal (requires goalId)
- resume: Resume a paused goal (requires goalId)
- abandon: Abandon a goal (requires goalId)`,
    parameters: GoalToolSchema,
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
          const parentGoalId = readStringParam(params, "parentGoalId");
          const agentId = readStringParam(params, "agentId");
          return jsonResult(
            await callGatewayTool("goal.create", gatewayOpts, {
              agentId,
              title,
              description,
              parentGoalId,
            }),
          );
        }
        case "list": {
          const agentId = readStringParam(params, "agentId");
          return jsonResult(await callGatewayTool("goal.list", gatewayOpts, { agentId }));
        }
        case "get": {
          const goalId = readStringParam(params, "goalId", { required: true });
          const agentId = readStringParam(params, "agentId");
          return jsonResult(await callGatewayTool("goal.get", gatewayOpts, { agentId, goalId }));
        }
        case "update_progress": {
          const goalId = readStringParam(params, "goalId", { required: true });
          const progress = readNumberParam(params, "progress", { required: true });
          const agentId = readStringParam(params, "agentId");
          return jsonResult(
            await callGatewayTool("goal.update.progress", gatewayOpts, {
              agentId,
              goalId,
              progress,
            }),
          );
        }
        case "complete": {
          const goalId = readStringParam(params, "goalId", { required: true });
          const agentId = readStringParam(params, "agentId");
          return jsonResult(
            await callGatewayTool("goal.complete", gatewayOpts, { agentId, goalId }),
          );
        }
        case "pause": {
          const goalId = readStringParam(params, "goalId", { required: true });
          const agentId = readStringParam(params, "agentId");
          return jsonResult(await callGatewayTool("goal.pause", gatewayOpts, { agentId, goalId }));
        }
        case "resume": {
          const goalId = readStringParam(params, "goalId", { required: true });
          const agentId = readStringParam(params, "agentId");
          return jsonResult(await callGatewayTool("goal.resume", gatewayOpts, { agentId, goalId }));
        }
        case "abandon": {
          const goalId = readStringParam(params, "goalId", { required: true });
          const agentId = readStringParam(params, "agentId");
          return jsonResult(
            await callGatewayTool("goal.abandon", gatewayOpts, { agentId, goalId }),
          );
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
