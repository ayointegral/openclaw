import type { OpenClawConfig } from "../../config/config.js";
import type { MemorySearchResult } from "../../memory/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("memory:redis-inject");

/**
 * Inject relevant memories from Redis into the conversation context.
 *
 * Designed to be called from the `before_agent_start` code path in
 * `attempt.ts`.  Returns `{ prependContext }` when relevant memories are
 * found, or `undefined` otherwise.
 */
export async function injectRedisMemories(params: {
  prompt: string;
  agentId: string;
  cfg: OpenClawConfig;
}): Promise<{ prependContext: string } | undefined> {
  const redisUrl = process.env.OPENCLAW_REDIS_URL;
  if (!redisUrl) {
    return;
  }

  const { prompt, agentId, cfg } = params;
  if (!prompt?.trim()) {
    return;
  }

  try {
    const { RedisMemoryManager } = await import("../../memory/redis-memory-manager.js");
    let mgr: Awaited<ReturnType<typeof RedisMemoryManager.create>> | undefined;

    try {
      mgr = await RedisMemoryManager.create({ cfg, agentId, redisUrl });
      const results: MemorySearchResult[] = await mgr.search(prompt, {
        maxResults: 5,
        minScore: 0.3,
      });

      if (results.length === 0) {
        return;
      }

      const memoryBlock = results
        .map((r, i) => `[Memory ${i + 1}] (score: ${r.score.toFixed(2)})\n${r.snippet}`)
        .join("\n\n");

      log.info(`injected ${results.length} memories for agent ${agentId}`);

      return {
        prependContext: `<recalled-memories>\nThe following memories were retrieved from long-term storage based on relevance to the current message:\n\n${memoryBlock}\n</recalled-memories>`,
      };
    } finally {
      await mgr?.close();
    }
  } catch (err) {
    log.warn(`injection failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
}
