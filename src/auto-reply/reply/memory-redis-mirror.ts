import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("memory:redis-mirror");

/**
 * Mirror recently-written memory files to Redis for hybrid search.
 *
 * Scans `<workspaceDir>/memory/` for `.md` files modified within `maxAgeMs`
 * and stores their content via `RedisMemoryManager`.  This is additive — the
 * md files remain the primary store.
 */
export async function mirrorRecentMemoryFilesToRedis(
  workspaceDir: string,
  agentId: string,
  cfg: OpenClawConfig,
  maxAgeMs = 120_000,
): Promise<number> {
  const redisUrl = process.env.OPENCLAW_REDIS_URL;
  if (!redisUrl) {
    return 0;
  }

  const memDir = path.join(workspaceDir, "memory");
  if (!fs.existsSync(memDir)) {
    return 0;
  }

  const now = Date.now();
  const files = fs.readdirSync(memDir).filter((f) => f.endsWith(".md"));
  if (files.length === 0) {
    return 0;
  }

  const { RedisMemoryManager } = await import("../../memory/redis-memory-manager.js");
  let mgr: Awaited<ReturnType<typeof RedisMemoryManager.create>> | undefined;
  let mirrored = 0;

  try {
    mgr = await RedisMemoryManager.create({ cfg, agentId, redisUrl });

    for (const file of files) {
      const fp = path.join(memDir, file);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > maxAgeMs) {
        continue;
      }

      const content = fs.readFileSync(fp, "utf-8");
      if (!content.trim()) {
        continue;
      }

      // Trigger a sync so the new file is indexed (embeddings + RediSearch)
      await mgr.sync({ reason: `mirror:${file}` });
      mirrored++;
    }
  } catch (err) {
    log.warn(`mirror failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await mgr?.close();
  }

  if (mirrored > 0) {
    log.info(`mirrored ${mirrored} memory file(s) to Redis`);
  }
  return mirrored;
}
