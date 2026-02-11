# OpenClaw Redis State Engine

Swarm: default
Phase: 6 | Updated: 2026-02-11

## Phase 1: Foundation [COMPLETE]

- [x] 1.1: Add `ioredis` dependency + Redis storage config schema to `zod-schema.ts` [SMALL]
- [x] 1.2: Create `src/infra/redis-client.ts` — singleton Redis client with connection management, health check, reconnect [MEDIUM]
- [x] 1.3: Create `src/infra/redis-crypto.ts` — AES-256-GCM encrypt/decrypt with versioned prefix `enc:v1:` [SMALL]
- [x] 1.4: Create `src/infra/storage-backend.ts` — StorageBackend interface + RedisStorageBackend + FsStorageBackend implementations [MEDIUM]
- [x] 1.5: Add Redis service to `docker-compose.yml` (fork version) [SMALL]
- [x] 1.6: Unit tests for redis-crypto and storage-backend (52 tests) [MEDIUM]

## Phase 2: Store Migration — Simple Stores [COMPLETE]

- [x] 2.1: Migrate `telegram/update-offset-store.ts` to use StorageBackend (depends: 1.4) [SMALL]
- [x] 2.2: Migrate `infra/device-pairing.ts` to use StorageBackend with TTL support (depends: 1.4) [MEDIUM]
- [x] 2.3: Migrate `agents/auth-profiles/store.ts` to use StorageBackend + encryption (depends: 1.3, 1.4) [MEDIUM]
- [x] 2.4: Unit tests for migrated stores (11 tests) [MEDIUM]

## Phase 3: Session Store Migration [COMPLETE]

- [x] 3.1: Migrate `config/sessions/store.ts` — sessions as Redis Hashes, async loader, storage-aware locking [LARGE]
- [x] 3.2: Migrate `config/sessions/transcript.ts` — transcripts as Redis Streams with trim [LARGE]
- [x] 3.3: Unit tests for session store (10 tests) [MEDIUM]

## Phase 4: Memory/Mind — RediSearch [COMPLETE]

- [x] 4.1: Create `src/memory/redis-memory-schema.ts` — RediSearch FT.CREATE with HNSW vector + FTS text + TAG filters (183 lines)
- [x] 4.2: Create `src/memory/redis-memory-manager.ts` — RedisMemoryManager implementing MemorySearchManager (~830 lines)
  - Hybrid search: parallel vector KNN + full-text BM25, weighted merge (0.7/0.3)
  - Sync: walk workspace files → chunk → embed → upsert via JSON.SET
  - Chunk budget: configurable max chunks (10K default), auto-prune oldest
  - Embedding cache: Redis keys with 7-day TTL
  - Multi-agent isolation: all queries filtered by agent_id TAG
- [x] 4.3: Wire memory backend into config — `memory.backend: "redis"` option
  - Updated `src/config/types.memory.ts` — added "redis" to MemoryBackend union
  - Updated `src/config/zod-schema.ts` — added z.literal("redis") to validation
  - Updated `src/config/schema.ts` + `schema.field-metadata.ts` — updated descriptions
  - Updated `src/memory/backend-config.ts` — added "redis" branch
  - Updated `src/memory/search-manager.ts` — added Redis dynamic import with fallback
- [x] 4.4: Fix parseVectorDims bug (lowercase "dim" + numeric value from Redis)
- [x] 4.5: Multi-agent isolation audit + fix (agent_id TAG filtering, scoped deletes, scoped prune)
- [x] 4.6: Integration tests against real Redis Stack (12 tests)
- [x] 4.7: Build/lint/format/test verification (1426 tests passed, 0 failures)

## Phase 5: New Capabilities — Tasks, Goals, Automation [COMPLETE]

- [x] 5.1: Create `src/tasks/redis-task-store.ts` — TaskStore with priority queue, CRUD, dequeue, purge (302 lines, 11 tests)
- [x] 5.2: Create `src/goals/redis-goal-store.ts` — GoalStore with sub-goals, progress, task linking (276 lines, 10 tests)
- [x] 5.3: Create `src/automation/redis-scheduler.ts` — Scheduler with once/interval/cron, poll, run lifecycle (280 lines, 10 tests)
- [x] 5.4: Create `src/events/redis-event-bus.ts` — EventBus with global+agent streams, fan-out, filter (151 lines, 7 tests)
- [x] 5.5: Unit tests for all 4 modules (38 tests total)

## Phase 6: Integration + Deployment [IN PROGRESS]

- [x] 6.1: Docker Compose test stack — Redis + Gateway, verified E2E [MEDIUM]
- [x] 6.2: Config updated — `memory.backend: "redis"` in openclaw.json [SMALL]
- [ ] 6.3: Docker Compose for Terry (`/opt/stacks/openclaw/docker-compose.yml`) [SMALL]
- [ ] 6.4: Docker Compose for Nolly production [SMALL]
- [ ] 6.5: Commit + push to `feature/redis-storage` [SMALL]
