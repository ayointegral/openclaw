import { Type } from "@sinclair/typebox";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam } from "./common.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";

const AUTOMATION_ACTIONS = ["schedule", "list", "get", "disable", "enable", "remove"] as const;

const SCHEDULE_TYPES = ["once", "interval", "cron"] as const;

const AutomationToolSchema = Type.Object({
  action: stringEnum(AUTOMATION_ACTIONS),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  agentId: Type.Optional(Type.String()),
  jobId: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  scheduleType: optionalStringEnum(SCHEDULE_TYPES),
  scheduleExpr: Type.Optional(
    Type.String({ description: "Cron expression, ISO date, or interval like '5m'" }),
  ),
  payload: Type.Optional(Type.String({ description: "JSON string payload for the job" })),
  maxRuns: Type.Optional(Type.Number({ minimum: 1 })),
});

export function createAutomationTool(): AnyAgentTool {
  return {
    label: "Scheduler",
    name: "scheduler",
    description: `Manage scheduled automation jobs — schedule, list, enable/disable, and remove.

ACTIONS:
- schedule: Create a new scheduled job (requires name, scheduleType, scheduleExpr; optional payload/maxRuns)
- list: List all scheduled jobs for an agent
- get: Get a job by ID (requires jobId)
- disable: Disable a scheduled job (requires jobId)
- enable: Re-enable a disabled job (requires jobId)
- remove: Delete a job entirely (requires jobId)

SCHEDULE TYPES:
- once: Run once at a specific time (scheduleExpr = ISO date or epoch ms)
- interval: Run at a recurring interval (scheduleExpr = interval in ms)
- cron: Run on a cron schedule (scheduleExpr = cron expression)`,
    parameters: AutomationToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const gatewayOpts: GatewayCallOptions = {
        gatewayUrl: readStringParam(params, "gatewayUrl", { trim: false }),
        gatewayToken: readStringParam(params, "gatewayToken", { trim: false }),
        timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : 60_000,
      };

      switch (action) {
        case "schedule": {
          const name = readStringParam(params, "name", { required: true });
          const scheduleType = readStringParam(params, "scheduleType", { required: true });
          const scheduleExpr = readStringParam(params, "scheduleExpr", { required: true });
          const payload = readStringParam(params, "payload");
          const maxRuns = readNumberParam(params, "maxRuns", { integer: true });
          const agentId = readStringParam(params, "agentId");
          return jsonResult(
            await callGatewayTool("automation.schedule", gatewayOpts, {
              agentId,
              name,
              scheduleType,
              scheduleExpr,
              payload,
              maxRuns,
            }),
          );
        }
        case "list": {
          const agentId = readStringParam(params, "agentId");
          return jsonResult(await callGatewayTool("automation.list", gatewayOpts, { agentId }));
        }
        case "get": {
          const jobId = readStringParam(params, "jobId", { required: true });
          const agentId = readStringParam(params, "agentId");
          return jsonResult(
            await callGatewayTool("automation.get", gatewayOpts, { agentId, jobId }),
          );
        }
        case "disable": {
          const jobId = readStringParam(params, "jobId", { required: true });
          const agentId = readStringParam(params, "agentId");
          return jsonResult(
            await callGatewayTool("automation.disable", gatewayOpts, { agentId, jobId }),
          );
        }
        case "enable": {
          const jobId = readStringParam(params, "jobId", { required: true });
          const agentId = readStringParam(params, "agentId");
          return jsonResult(
            await callGatewayTool("automation.enable", gatewayOpts, { agentId, jobId }),
          );
        }
        case "remove": {
          const jobId = readStringParam(params, "jobId", { required: true });
          const agentId = readStringParam(params, "agentId");
          return jsonResult(
            await callGatewayTool("automation.remove", gatewayOpts, { agentId, jobId }),
          );
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
