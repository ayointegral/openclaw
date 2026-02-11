import type { StorageBackend } from "../infra/storage-backend.js";

// ── Event types ──────────────────────────────────────────────────────────────

export type EventType =
  | "session.created"
  | "session.updated"
  | "session.ended"
  | "task.created"
  | "task.completed"
  | "task.failed"
  | "goal.created"
  | "goal.completed"
  | "goal.progress"
  | "agent.started"
  | "agent.stopped"
  | "message.inbound"
  | "message.outbound"
  | "automation.triggered"
  | "custom";

export type EventData = {
  id: string;
  type: EventType;
  agentId: string;
  timestamp: number;
  payload: string;
  targetAgentId?: string;
};

export type EventFilter = {
  type?: EventType;
  agentId?: string;
  since?: string;
  limit?: number;
};

// ── Keys ─────────────────────────────────────────────────────────────────────

const GLOBAL_KEY = "events:global";
const agentKey = (agentId: string) => `events:${agentId}`;

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseEntry(entry: { id: string; data: Record<string, string> }): EventData {
  const parsed = JSON.parse(entry.data.data) as Omit<EventData, "id">;
  return { id: entry.id, ...parsed };
}

function applyFilter(events: EventData[], filter?: EventFilter): EventData[] {
  if (!filter) {
    return events;
  }
  let result = events;
  if (filter.type) {
    result = result.filter((e) => e.type === filter.type);
  }
  if (filter.agentId) {
    result = result.filter((e) => e.agentId === filter.agentId);
  }
  if (filter.limit !== undefined) {
    result = result.slice(0, filter.limit);
  }
  return result;
}

// ── EventBus ─────────────────────────────────────────────────────────────────

export class EventBus {
  constructor(private readonly storage: StorageBackend) {}

  /** Publish an event to the global stream. */
  async publish(params: {
    type: EventType;
    agentId: string;
    payload: string;
    targetAgentId?: string;
  }): Promise<string> {
    const entry = {
      type: params.type,
      agentId: params.agentId,
      timestamp: Date.now(),
      payload: params.payload,
      ...(params.targetAgentId ? { targetAgentId: params.targetAgentId } : {}),
    };
    const id = await this.storage.append(GLOBAL_KEY, JSON.stringify(entry));

    // Fan-out to the target agent's dedicated stream
    if (params.targetAgentId) {
      await this.storage.append(agentKey(params.targetAgentId), JSON.stringify(entry));
    }

    return id;
  }

  /** Publish to a specific agent's stream. */
  async publishToAgent(
    agentId: string,
    params: { type: EventType; sourceAgentId: string; payload: string },
  ): Promise<string> {
    const entry = {
      type: params.type,
      agentId: params.sourceAgentId,
      timestamp: Date.now(),
      payload: params.payload,
      targetAgentId: agentId,
    };
    return this.storage.append(agentKey(agentId), JSON.stringify(entry));
  }

  /** Read events from the global stream. */
  async readGlobal(filter?: EventFilter): Promise<EventData[]> {
    return this.readStream(GLOBAL_KEY, filter);
  }

  /** Read events from a specific agent's stream. */
  async readAgent(agentId: string, filter?: EventFilter): Promise<EventData[]> {
    return this.readStream(agentKey(agentId), filter);
  }

  /** Get the latest N events from the global stream. */
  async latest(count?: number): Promise<EventData[]> {
    const all = await this.readGlobal();
    return all.slice(-(count ?? 50));
  }

  /** Trim global stream to max entries. */
  async trimGlobal(maxLen?: number): Promise<void> {
    await this.storage.trim(GLOBAL_KEY, maxLen ?? 10_000);
  }

  /** Trim agent stream to max entries. */
  async trimAgent(agentId: string, maxLen?: number): Promise<void> {
    await this.storage.trim(agentKey(agentId), maxLen ?? 5_000);
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private async readStream(key: string, filter?: EventFilter): Promise<EventData[]> {
    const start = filter?.since ?? "-";
    const end = "+";
    // When post-filtering by type/agentId we can't rely on storage-level
    // count, so only pass limit when no field filters are active.
    const needsPostFilter = !!(filter?.type || filter?.agentId);
    const count = needsPostFilter ? undefined : filter?.limit;

    const raw = await this.storage.range(key, start, end, count);
    const events = raw.map(parseEntry);
    return applyFilter(events, filter);
  }
}
