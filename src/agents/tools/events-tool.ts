import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam } from "./common.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";

const EVENTS_ACTIONS = ["list_recent", "list_agent", "search"] as const;

const EventsToolSchema = Type.Object({
  action: stringEnum(EVENTS_ACTIONS),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  agentId: Type.Optional(Type.String()),
  count: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
  type: Type.Optional(Type.String()),
});

export function createEventsTool(): AnyAgentTool {
  return {
    label: "Event Log",
    name: "event_log",
    description: `Read event logs — list recent events, agent-specific events, or search by type.

ACTIONS:
- list_recent: List the most recent global events (optional count, default 50)
- list_agent: List events for a specific agent (requires agentId, optional count/type)
- search: Search events by type filter (optional agentId/type/count)

This is a read-only tool. Events are published automatically by the system.`,
    parameters: EventsToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const gatewayOpts: GatewayCallOptions = {
        gatewayUrl: readStringParam(params, "gatewayUrl", { trim: false }),
        gatewayToken: readStringParam(params, "gatewayToken", { trim: false }),
        timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : 60_000,
      };

      switch (action) {
        case "list_recent": {
          const count = readNumberParam(params, "count", { integer: true });
          return jsonResult(await callGatewayTool("events.recent", gatewayOpts, { count }));
        }
        case "list_agent": {
          const agentId = readStringParam(params, "agentId", { required: true });
          const count = readNumberParam(params, "count", { integer: true });
          const type = readStringParam(params, "type");
          return jsonResult(
            await callGatewayTool("events.agent", gatewayOpts, { agentId, count, type }),
          );
        }
        case "search": {
          const agentId = readStringParam(params, "agentId");
          const type = readStringParam(params, "type");
          const count = readNumberParam(params, "count", { integer: true });
          return jsonResult(
            await callGatewayTool("events.recent", gatewayOpts, { agentId, type, count }),
          );
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
