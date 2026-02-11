# Context

Swarm: default

## Deployment Notes

- **Terry**: Node 22, x86_64, `/opt/stacks/openclaw/`, build-from-source Docker image
- **Nolly**: Node 22, ARM64 (Apple Silicon), `~/.staging/nolly-docker-compose.yml`, image `openclaw:redis-prod`
- **Nolly NPM**: `openclaw.ajayi.dev` → `openclaw-gateway-prod:18789` via `proxy-net`
- **Nolly gateway token**: `2e17904c8705897f9c61483ffec717b79c597839226f572c`

## Decisions

- **Redis Stack Server 7.4.0-v1**: Includes RediSearch + RedisJSON, no separate module loading
- **`ioredis` client**: Industry-standard Node.js Redis client, supports Cluster/Sentinel, pipelining, Lua scripting
- **noeviction policy**: Redis is primary state engine, not a cache — never silently drop data
- **AOF + RDB persistence**: `appendfsync everysec` (max 1s data loss) + RDB snapshots for fast recovery
- **App-level AES-256-GCM encryption**: Per-value random IV, versioned prefix `enc:v1:`, key in env var
- **StorageBackend interface**: Dual implementations — RedisStorageBackend (primary) + FsStorageBackend (fallback/offline)
- **Key namespace**: `oc:{domain}:{entity_id}[:{sub}]` — cluster-compatible
- **Streams for transcripts**: Replace JSONL append-only with Redis Streams (auto-ID, range queries, trimming)
- **Streams + Consumer Groups for events**: Persistent acknowledged delivery, dead letter support
- **RediSearch for memory**: Replace SQLite FTS5 + sqlite-vec with HNSW vector + text search on JSON docs
- **Dedicated Redis per stack**: Don't share with pc-redis on Terry
- **Redis over PostgreSQL for memory**: User chose unified stack — Redis for both state + mind. Chunk budget + auto-prune for memory management instead of disk-based storage. PostgreSQL reserved as future cold-tier if needed.
- **Multi-agent isolation**: All RediSearch queries filtered by `agent_id` TAG. File keys include agentId prefix. Prune/delete scoped per-agent. Shared RediSearch index (idx:chunks) but data isolated by TAG filter.

## SME Cache

### Database (Redis Architecture)

- Image: `redis/redis-stack-server:7.4.0-v1` (prod) / `redis/redis-stack:7.4.0-v1` (dev with UI)
- Memory: Terry 768mb maxmemory, 1g container limit; Nolly 512mb maxmemory
- Key namespace: `oc:{domain}:{entity_id}[:{sub}]`
- Sessions → Hash, Transcripts → Stream, Auth → Hash (encrypted), Offsets → String
- Tasks → Hash + Sorted Set, Goals → Hash + Set, Automation → Hash + Sorted Set
- Memory → RedisJSON + RediSearch HNSW FLOAT32 DIM 1536 COSINE
  - Index: `idx:chunks` (JSON, prefix `oc:chunk:`)
  - Fields: text (TEXT), source/model/agent_id/path (TAG), start_line/end_line/updated_at/access_count (NUMERIC SORTABLE), embedding (VECTOR HNSW)
  - HNSW params: M=16, EF_CONSTRUCTION=200, EF_RUNTIME=20
  - Hybrid search: parallel vector KNN + FTS, weighted merge 0.7/0.3
  - Chunk budget: 10K default, prune oldest per-agent when exceeded
  - Embedding cache: `oc:emb:{provider}:{model}:{hash}` with 7d TTL
- Events → Streams with Consumer Groups
- Never use KEYS command — use SCAN or FT.SEARCH
- XTRIM MAXLEN ~ on transcript streams
- MULTI/EXEC for atomicity (no rollback — use Lua for complex txns)

### DevOps (Docker Integration)

- No port exposure on Terry (internal Docker network only)
- Nolly: `127.0.0.1:6399:6379` + `127.0.0.1:8001:8001` (RedisInsight)
- Terry volume: `/opt/stacks/openclaw/redis-data:/data` (bind mount for backups)
- Nolly volume: `openclaw-redis-data:/data` (named volume)
- Health check: `redis-cli -a $REDIS_PASSWORD ping`
- Encryption key in `.env` (not Docker secret — not running Swarm)
- `depends_on: condition: service_healthy` for OpenClaw → Redis
- Logging: `json-file` driver, 10m max, 3 files

## Patterns

- **Atomic writes**: All Redis ops use MULTI/EXEC or Lua scripts where atomicity needed
- **Locking**: Redis-based distributed locks via `SET key val NX EX ttl` (replaces file locks)
- **TTL**: Native Redis EXPIRE for pending pairings (300s), heartbeats (60s), embedding cache (7d)
- **Graceful fallback**: If OPENCLAW_REDIS_URL not set, fall back to FsStorageBackend / SQLite MemoryIndexManager
- **Encryption scope**: Only auth profiles + device tokens. Memory/tasks/sessions stay plaintext for searchability
- **Multi-agent memory**: Shared RediSearch index, isolated by agent_id TAG filter on all queries
- **Chunk budget**: Per-agent count via FT.SEARCH, prune oldest by updated_at when exceeding 10K
- **ioredis keyPrefix gotcha**: client.call() bypasses keyPrefix — use dedicated non-prefixed client for FT._/JSON._ commands

## File Map

### Phase 1-3: State Engine (COMPLETE)

- `src/infra/redis-client.ts` — Redis connection singleton
- `src/infra/redis-crypto.ts` — AES-256-GCM encrypt/decrypt
- `src/infra/storage-backend.ts` — StorageBackend interface + implementations
- `src/config/zod-schema.ts` — Config schema (storage + memory.backend: redis)
- `src/config/sessions/store.ts` — Session store (Redis Hash)
- `src/config/sessions/transcript.ts` — Transcript store (Redis Stream)
- `src/agents/auth-profiles/store.ts` — Auth profiles (encrypted)
- `src/telegram/update-offset-store.ts` — Telegram offset
- `src/infra/device-pairing.ts` — Device pairing (TTL)

### Phase 4: Memory/Mind (COMPLETE)

- `src/memory/redis-memory-schema.ts` — RediSearch index schema, key builders, embeddingToBuffer (183 lines)
- `src/memory/redis-memory-manager.ts` — RedisMemoryManager: hybrid search, sync, prune, multi-agent (~830 lines)
- `src/config/types.memory.ts` — MemoryBackend: "builtin" | "qmd" | "redis"
- `src/memory/backend-config.ts` — Redis branch in resolveMemoryBackendConfig
- `src/memory/search-manager.ts` — Redis branch in getMemorySearchManager

### Phase 5: New Capabilities (COMPLETE)

- `src/tasks/redis-task-store.ts` — Task queues
- `src/goals/redis-goal-store.ts` — Goal tracking
- `src/automation/redis-scheduler.ts` — Scheduled jobs
- `src/events/redis-event-bus.ts` — Inter-agent events

### Tests

- `src/infra/redis-crypto.test.ts` — 19 tests
- `src/infra/storage-backend.test.ts` — 33 tests
- `src/infra/device-pairing.test.ts` — 6 tests
- `src/infra/redis-integration.test.ts` — 20 integration tests
- `src/telegram/update-offset-store.test.ts` — 5 tests
- `src/config/sessions/store.redis.test.ts` — 10 tests
- `src/tasks/redis-task-store.test.ts` — 11 tests
- `src/goals/redis-goal-store.test.ts` — 10 tests
- `src/automation/redis-scheduler.test.ts` — 10 tests
- `src/events/redis-event-bus.test.ts` — 7 tests
- `src/memory/redis-memory-integration.test.ts` — 12 integration tests (RediSearch + RedisJSON)
