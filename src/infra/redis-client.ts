import { Redis, type RedisOptions } from "ioredis";

// ── Types ────────────────────────────────────────────────────────────────────

export interface RedisClientOptions {
  url?: string;
  keyPrefix?: string;
  tls?: boolean;
  maxRetries?: number;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
}

// ── Singleton state ──────────────────────────────────────────────────────────

let cachedClient: Redis | null = null;

// ── Factory ──────────────────────────────────────────────────────────────────

export function createRedisClient(opts: RedisClientOptions): Redis {
  const {
    url,
    keyPrefix = "oc:",
    tls = false,
    maxRetries = 10,
    connectTimeoutMs = 5000,
    commandTimeoutMs = 3000,
  } = opts;

  const baseOpts: RedisOptions = {
    keyPrefix,
    lazyConnect: true,
    connectTimeout: connectTimeoutMs,
    commandTimeout: commandTimeoutMs,
    retryStrategy(times: number): number | null {
      if (times > maxRetries) {
        return null;
      } // stop retrying
      // Exponential backoff: 100ms * 2^(times-1), capped at 30s
      return Math.min(100 * 2 ** (times - 1), 30_000);
    },
    ...(tls ? { tls: {} } : {}),
  };

  const client = url ? new Redis(url, baseOpts) : new Redis(baseOpts);

  // Connection lifecycle logging (stderr, minimal)
  const tag = "[redis]";
  client.on("connect", () => console.error(`${tag} connecting`));
  client.on("ready", () => console.error(`${tag} ready`));
  client.on("error", (err: Error) => console.error(`${tag} error:`, err.message));
  client.on("close", () => console.error(`${tag} closed`));
  client.on("reconnecting", (ms: number) => console.error(`${tag} reconnecting in ${ms}ms`));

  return client;
}

// ── Singleton getter ─────────────────────────────────────────────────────────

/**
 * Returns the cached Redis client, creating one if `opts` is provided.
 * Returns `null` when Redis is not configured (no cached client, no opts).
 */
export function getRedisClient(opts?: RedisClientOptions): Redis | null {
  if (cachedClient) {
    return cachedClient;
  }
  if (!opts) {
    return null;
  }
  cachedClient = createRedisClient(opts);
  return cachedClient;
}

// ── Env resolver ─────────────────────────────────────────────────────────────

export function resolveRedisOptions(
  env: NodeJS.ProcessEnv = process.env,
): RedisClientOptions | null {
  const url = env.OPENCLAW_REDIS_URL;
  if (!url) {
    return null;
  }

  return {
    url,
    ...(env.OPENCLAW_REDIS_KEY_PREFIX ? { keyPrefix: env.OPENCLAW_REDIS_KEY_PREFIX } : {}),
  };
}

// ── Health check ─────────────────────────────────────────────────────────────

export function isRedisAvailable(): boolean {
  return cachedClient?.status === "ready";
}

// ── Graceful shutdown ────────────────────────────────────────────────────────

export async function shutdownRedis(): Promise<void> {
  if (!cachedClient) {
    return;
  }
  const client = cachedClient;
  cachedClient = null;
  await client.quit();
}
