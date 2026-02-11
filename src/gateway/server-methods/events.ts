import type { EventType } from "../../events/redis-event-bus.js";
import type { GatewayRequestHandlers } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

export const eventsHandlers: GatewayRequestHandlers = {
  "events.recent": async ({ params, respond, context }) => {
    const bus = context.eventBus;
    if (!bus) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Redis storage not configured"));
      return;
    }
    const p = params as { count?: number; type?: string; agentId?: string };
    const count = typeof p.count === "number" ? p.count : 50;
    const events = await bus.readGlobal({
      type: p.type as EventType | undefined,
      agentId: p.agentId,
      limit: count,
    });
    respond(true, { events });
  },

  "events.agent": async ({ params, respond, context }) => {
    const bus = context.eventBus;
    if (!bus) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Redis storage not configured"));
      return;
    }
    const p = params as { agentId?: string; count?: number; type?: string };
    if (!p.agentId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "agentId required"));
      return;
    }
    const count = typeof p.count === "number" ? p.count : 50;
    const events = await bus.readAgent(p.agentId, {
      type: p.type as EventType | undefined,
      limit: count,
    });
    respond(true, { events });
  },

  "events.publish": async ({ params, respond, context }) => {
    const bus = context.eventBus;
    if (!bus) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Redis storage not configured"));
      return;
    }
    const p = params as {
      type?: string;
      agentId?: string;
      payload?: string;
      targetAgentId?: string;
    };
    if (!p.type || !p.agentId || !p.payload) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "type, agentId, and payload required"),
      );
      return;
    }
    const id = await bus.publish({
      type: p.type as EventType,
      agentId: p.agentId,
      payload: p.payload,
      targetAgentId: p.targetAgentId,
    });
    respond(true, { id });
  },
};
