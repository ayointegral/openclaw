import type { Redis } from "ioredis";
import fs from "node:fs/promises";
import path from "node:path";
import type { ResolvedMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySource,
  MemorySyncProgressUpdate,
} from "./types.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { createRedisClient } from "../infra/redis-client.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { truncateUtf16Safe } from "../utils.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "./embeddings.js";
import {
  listMemoryFiles,
  buildFileEntry,
  chunkMarkdown,
  hashText,
  runWithConcurrency,
  isMemoryPath,
  normalizeExtraMemoryPaths,
} from "./internal.js";
import {
  CHUNK_INDEX,
  chunkKey,
  fileKey,
  embCacheKey,
  ensureChunkIndex,
  ensureFileIndex,
  getChunkIndexInfo,
  recreateChunkIndex,
  embeddingToBuffer,
  CHUNK_KEY_PREFIX,
  type RedisChunkDoc,
  type RedisFileDoc,
} from "./redis-memory-schema.js";

// ── Constants ────────────────────────────────────────────────────────────────

const SNIPPET_MAX_CHARS = 700;
const DEFAULT_MAX_CHUNKS = 10_000;
const PRUNE_BUFFER_PCT = 0.1;
const EMBEDDING_BATCH_SIZE = 50;
const SYNC_CONCURRENCY = 4;

const log = createSubsystemLogger("memory:redis");

// ── FT.SEARCH result parsing helpers ─────────────────────────────────────────

type ParsedChunk = {
  id: string;
  text: string;
  path: string;
  source: string;
  startLine: number;
  endLine: number;
  score: number;
};

function fieldsToMap(fields: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < fields.length - 1; i += 2) {
    m.set(fields[i] ?? "", fields[i + 1] ?? "");
  }
  return m;
}

/** Parse vector KNN results (no WITHSCORES — distance from RETURN fields). */
function parseVectorSearchResults(raw: unknown[]): ParsedChunk[] {
  const results: ParsedChunk[] = [];
  for (let i = 1; i < raw.length; i += 2) {
    const fields = raw[i + 1] as string[];
    const map = fieldsToMap(fields);
    const distance = parseFloat(map.get("__embedding_score") ?? "2");
    results.push({
      id: map.get("$.id") ?? (raw[i] as string),
      text: map.get("$.text") ?? "",
      path: map.get("$.path") ?? "",
      source: map.get("$.source") ?? "memory",
      startLine: parseInt(map.get("$.start_line") ?? "0", 10),
      endLine: parseInt(map.get("$.end_line") ?? "0", 10),
      score: 1 - distance, // cosine distance → similarity
    });
  }
  return results;
}

/** Parse text search results (WITHSCORES — score between key and fields). */
function parseTextSearchResults(raw: unknown[]): ParsedChunk[] {
  const results: ParsedChunk[] = [];
  for (let i = 1; i < raw.length; i += 3) {
    const score = parseFloat(raw[i + 1] as string);
    const fields = raw[i + 2] as string[];
    const map = fieldsToMap(fields);
    results.push({
      id: map.get("$.id") ?? (raw[i] as string),
      text: map.get("$.text") ?? "",
      path: map.get("$.path") ?? "",
      source: map.get("$.source") ?? "memory",
      startLine: parseInt(map.get("$.start_line") ?? "0", 10),
      endLine: parseInt(map.get("$.end_line") ?? "0", 10),
      score,
    });
  }
  return results;
}

// ── RedisMemoryManager ───────────────────────────────────────────────────────

export class RedisMemoryManager implements MemorySearchManager {
  private static readonly CACHE = new Map<string, RedisMemoryManager>();
  private syncPromise: Promise<void> | null = null;
  private readonly cacheKey: string;

  private constructor(
    private readonly client: Redis,
    private readonly cfg: OpenClawConfig,
    private readonly agentId: string,
    private readonly workspaceDir: string,
    private readonly settings: ResolvedMemorySearchConfig,
    private provider: EmbeddingProvider,
    private readonly requestedProvider: string,
    private vectorDims: number | undefined,
    private dirty: boolean,
    cacheKey: string,
  ) {
    this.cacheKey = cacheKey;
  }

  static async create(params: {
    cfg: OpenClawConfig;
    agentId: string;
    redisUrl: string;
  }): Promise<RedisMemoryManager> {
    const { cfg, agentId, redisUrl } = params;
    const settings = resolveMemorySearchConfig(cfg, agentId);
    if (!settings) {
      throw new Error("memory search is disabled for this agent");
    }

    const cacheKey = `${agentId}:${redisUrl}:${settings.provider}:${settings.model}`;
    const cached = RedisMemoryManager.CACHE.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Dedicated client without keyPrefix — FT.* commands need explicit full keys
    const client = createRedisClient({ url: redisUrl, keyPrefix: "" });
    await client.connect();

    const { provider } = await createEmbeddingProvider({
      config: cfg,
      provider: settings.provider,
      model: settings.model,
      fallback: settings.fallback,
      local: settings.local,
      remote: settings.remote,
    });

    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);

    // Check existing index dims; recreate if mismatched
    const indexInfo = await getChunkIndexInfo(client);
    let vectorDims = indexInfo.dims;
    if (indexInfo.exists && vectorDims) {
      // Probe actual dims from provider
      try {
        const probe = await provider.embedQuery("dim probe");
        if (probe.length !== vectorDims) {
          log.info(`vector dims changed ${vectorDims} → ${probe.length}; recreating index`);
          await recreateChunkIndex(client, probe.length);
          vectorDims = probe.length;
        }
      } catch {
        // Keep existing dims if probe fails
      }
    }

    if (vectorDims) {
      await ensureChunkIndex(client, vectorDims);
    }
    await ensureFileIndex(client);

    const dirty = !indexInfo.exists || (indexInfo.numDocs ?? 0) === 0;
    const instance = new RedisMemoryManager(
      client,
      cfg,
      agentId,
      workspaceDir,
      settings,
      provider,
      settings.provider,
      vectorDims,
      dirty,
      cacheKey,
    );

    RedisMemoryManager.CACHE.set(cacheKey, instance);
    return instance;
  }

  // ── search ───────────────────────────────────────────────────────────────

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    const maxResults = opts?.maxResults ?? this.settings.query.maxResults;
    const minScore = opts?.minScore ?? this.settings.query.minScore;
    const { vectorWeight, textWeight, candidateMultiplier } = this.settings.query.hybrid;
    const candidatePool = maxResults * candidateMultiplier;

    // Truncate query to stay within embedding model token limits (~6K tokens ≈ 24K chars).
    // Embedding models (OpenAI text-embedding-3-small, Gemini, Voyage) cap at 8K tokens;
    // for search we only need the semantic gist, not the full conversation prompt.
    const MAX_QUERY_CHARS = 24_000;
    const truncatedQuery = query.length > MAX_QUERY_CHARS ? query.slice(0, MAX_QUERY_CHARS) : query;

    // Embed query
    const queryVec = await this.provider.embedQuery(truncatedQuery);
    if (!this.vectorDims) {
      this.vectorDims = queryVec.length;
      await ensureChunkIndex(this.client, this.vectorDims);
    }

    const sourceFilter = this.buildSourceFilter();
    const blob = embeddingToBuffer(queryVec);

    // Two parallel FT.SEARCH calls: vector KNN + full-text
    const [vectorRaw, textRaw] = await Promise.all([
      this.client
        .call(
          "FT.SEARCH",
          CHUNK_INDEX,
          `(${sourceFilter})=>[KNN ${candidatePool} @embedding $BLOB EF_RUNTIME 20]`,
          "PARAMS",
          "2",
          "BLOB",
          blob,
          "SORTBY",
          "__embedding_score",
          "ASC",
          "LIMIT",
          "0",
          String(candidatePool),
          "RETURN",
          "7",
          "$.id",
          "$.text",
          "$.path",
          "$.source",
          "$.start_line",
          "$.end_line",
          "__embedding_score",
          "DIALECT",
          "2",
        )
        .catch((err: unknown) => {
          log.warn(`vector search failed: ${err instanceof Error ? err.message : String(err)}`);
          return [0] as unknown[];
        }) as Promise<unknown[]>,

      this.client
        .call(
          "FT.SEARCH",
          CHUNK_INDEX,
          `${sourceFilter} @text:(${this.escapeRedisQuery(query)})`,
          "WITHSCORES",
          "LIMIT",
          "0",
          String(candidatePool),
          "RETURN",
          "6",
          "$.id",
          "$.text",
          "$.path",
          "$.source",
          "$.start_line",
          "$.end_line",
          "DIALECT",
          "2",
        )
        .catch((err: unknown) => {
          log.warn(`text search failed: ${err instanceof Error ? err.message : String(err)}`);
          return [0] as unknown[];
        }) as Promise<unknown[]>,
    ]);

    const vectorResults = parseVectorSearchResults(vectorRaw);
    const textResults = parseTextSearchResults(textRaw);

    // Normalize text scores: RediSearch BM25 scores vary widely; map to [0,1]
    const maxTextScore = textResults.reduce((m, r) => Math.max(m, r.score), 0);
    const normalizedText =
      maxTextScore > 0
        ? textResults.map((r) => ({ ...r, score: r.score / maxTextScore }))
        : textResults;

    // Weighted merge
    const byId = new Map<string, { chunk: ParsedChunk; vecScore: number; txtScore: number }>();
    for (const r of vectorResults) {
      byId.set(r.id, { chunk: r, vecScore: Math.max(0, r.score), txtScore: 0 });
    }
    for (const r of normalizedText) {
      const existing = byId.get(r.id);
      if (existing) {
        existing.txtScore = r.score;
      } else {
        byId.set(r.id, { chunk: r, vecScore: 0, txtScore: r.score });
      }
    }

    const merged = Array.from(byId.values())
      .map(({ chunk, vecScore, txtScore }) => ({
        path: chunk.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        score: vectorWeight * vecScore + textWeight * txtScore,
        snippet: truncateUtf16Safe(chunk.text, SNIPPET_MAX_CHARS),
        source: (chunk.source === "sessions" ? "sessions" : "memory") as MemorySource,
        id: chunk.id,
      }))
      .filter((r) => r.score >= minScore)
      .toSorted((a, b) => b.score - a.score)
      .slice(0, maxResults);

    // Bump access_count on returned chunks (fire-and-forget)
    if (merged.length > 0) {
      const pipeline = this.client.pipeline();
      for (const r of merged) {
        pipeline.call("JSON.NUMINCRBY", chunkKey(r.id), "$.access_count", "1");
      }
      pipeline.exec().catch(() => {});
    }

    return merged.map(({ id: _id, ...rest }) => rest);
  }

  // ── readFile ─────────────────────────────────────────────────────────────

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const rawPath = params.relPath.trim();
    if (!rawPath) {
      throw new Error("path required");
    }

    const absPath = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(this.workspaceDir, rawPath);
    const relPath = path.relative(this.workspaceDir, absPath).replace(/\\/g, "/");

    const inWorkspace =
      relPath.length > 0 && !relPath.startsWith("..") && !path.isAbsolute(relPath);
    const allowedWorkspace = inWorkspace && isMemoryPath(relPath);

    let allowedAdditional = false;
    if (!allowedWorkspace && this.settings.extraPaths.length > 0) {
      const additionalPaths = normalizeExtraMemoryPaths(
        this.workspaceDir,
        this.settings.extraPaths,
      );
      for (const additionalPath of additionalPaths) {
        try {
          const stat = await fs.lstat(additionalPath);
          if (stat.isSymbolicLink()) {
            continue;
          }
          if (stat.isDirectory()) {
            if (absPath === additionalPath || absPath.startsWith(`${additionalPath}${path.sep}`)) {
              allowedAdditional = true;
              break;
            }
            continue;
          }
          if (stat.isFile() && absPath === additionalPath && absPath.endsWith(".md")) {
            allowedAdditional = true;
            break;
          }
        } catch {}
      }
    }

    if (!allowedWorkspace && !allowedAdditional) {
      throw new Error("path required");
    }
    if (!absPath.endsWith(".md")) {
      throw new Error("path required");
    }

    const stat = await fs.lstat(absPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("path required");
    }

    const content = await fs.readFile(absPath, "utf-8");
    if (!params.from && !params.lines) {
      return { text: content, path: relPath };
    }

    const lines = content.split("\n");
    const start = Math.max(1, params.from ?? 1);
    const count = Math.max(1, params.lines ?? lines.length);
    return { text: lines.slice(start - 1, start - 1 + count).join("\n"), path: relPath };
  }

  // ── status ───────────────────────────────────────────────────────────────

  status(): MemoryProviderStatus {
    return {
      backend: "builtin",
      provider: this.provider.id,
      model: this.provider.model,
      requestedProvider: this.requestedProvider,
      workspaceDir: this.workspaceDir,
      sources: Array.from(this.settings.sources ?? ["memory"]) as MemorySource[],
      vector: { enabled: true, available: true, dims: this.vectorDims },
      fts: { enabled: true, available: true },
      cache: { enabled: true },
      custom: { driver: "redis", agentId: this.agentId },
    };
  }

  // ── sync ─────────────────────────────────────────────────────────────────

  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    // Deduplicate concurrent syncs
    if (this.syncPromise) {
      return this.syncPromise;
    }
    this.syncPromise = this.doSync(params).finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  private async doSync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    const progress = params?.progress ?? (() => {});
    const force = params?.force ?? false;

    log.info(`sync starting (reason=${params?.reason ?? "manual"}, force=${force})`);

    if (force) {
      log.info("force sync: deleting agent chunks and file keys");
      await this.deleteAgentChunks();
      await this.deleteKeysByPrefix(`oc:file:${this.agentId}:`);
    }

    // List memory files from disk
    const filePaths = await listMemoryFiles(this.workspaceDir, this.settings.extraPaths);
    const totalFiles = filePaths.length;
    progress({ completed: 0, total: totalFiles, label: "scanning files" });

    const diskFileHashes = new Map<string, string>(); // pathHash → contentHash
    let completed = 0;

    const tasks = filePaths.map((absPath) => async () => {
      try {
        const entry = await buildFileEntry(absPath, this.workspaceDir);
        const pathHash = hashText(entry.path);
        diskFileHashes.set(pathHash, entry.hash);

        // Check if file is unchanged
        const agentPathHash = `${this.agentId}:${pathHash}`;
        const storedRaw = (await this.client.call("JSON.GET", fileKey(agentPathHash), "$.hash")) as
          | string
          | null;
        const storedHash = storedRaw ? parseJsonField(storedRaw) : null;

        if (storedHash === entry.hash && !force) {
          completed++;
          progress({ completed, total: totalFiles, label: entry.path });
          return;
        }

        // File is new or changed — chunk, embed, store
        const content = await fs.readFile(absPath, "utf-8");
        const chunks = chunkMarkdown(content, this.settings.chunking);

        if (chunks.length > 0) {
          await this.embedAndStoreChunks(chunks, entry.path, "memory");
        }

        // Store file entry
        const fileDoc: RedisFileDoc = {
          path: entry.path,
          source: "memory",
          hash: entry.hash,
          mtime: entry.mtimeMs,
          size: entry.size,
        };
        await this.client.call("JSON.SET", fileKey(agentPathHash), "$", JSON.stringify(fileDoc));

        completed++;
        progress({ completed, total: totalFiles, label: entry.path });
      } catch (err) {
        log.warn(`sync error for ${absPath}: ${err instanceof Error ? err.message : String(err)}`);
        completed++;
        progress({ completed, total: totalFiles });
      }
    });

    await runWithConcurrency(tasks, SYNC_CONCURRENCY);

    // Delete stale files/chunks not on disk
    await this.deleteStaleEntries(diskFileHashes);

    // Enforce chunk budget
    await this.enforceChunkBudget();

    this.dirty = false;
    log.info(`sync complete: ${totalFiles} files processed`);
  }

  private async embedAndStoreChunks(
    chunks: Array<{ startLine: number; endLine: number; text: string; hash: string }>,
    filePath: string,
    source: string,
  ): Promise<void> {
    // Process in batches
    for (let i = 0; i < chunks.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = chunks.slice(i, i + EMBEDDING_BATCH_SIZE);
      const texts = batch.map((c) => c.text);

      // Check embedding cache
      const embeddings: Array<number[] | null> = await Promise.all(
        texts.map(async (text) => {
          const textHash = hashText(text);
          const cacheK = embCacheKey(this.provider.id, this.provider.model, textHash);
          try {
            const cached = (await this.client.call("GET", cacheK)) as string | null;
            if (cached) {
              return JSON.parse(cached) as number[];
            }
          } catch {}
          return null;
        }),
      );

      // Embed uncached texts
      const uncachedIndices = embeddings
        .map((e, idx) => (e === null ? idx : -1))
        .filter((idx) => idx >= 0);

      if (uncachedIndices.length > 0) {
        const uncachedTexts = uncachedIndices.map((idx) => texts[idx] ?? "");
        try {
          const newEmbeddings = await this.provider.embedBatch(uncachedTexts);

          // Ensure index exists with correct dims
          if (!this.vectorDims && newEmbeddings.length > 0 && (newEmbeddings[0]?.length ?? 0) > 0) {
            this.vectorDims = newEmbeddings[0]?.length ?? 0;
            await ensureChunkIndex(this.client, this.vectorDims);
          }

          for (let j = 0; j < uncachedIndices.length; j++) {
            const idx = uncachedIndices[j] ?? 0;
            const embedding = newEmbeddings[j];
            if (!embedding) {
              continue;
            }
            embeddings[idx] = embedding;

            // Cache the embedding (TTL 7 days)
            const textHash = hashText(texts[idx] ?? "");
            const cacheK = embCacheKey(this.provider.id, this.provider.model, textHash);
            this.client
              .call("SET", cacheK, JSON.stringify(embedding), "EX", "604800")
              .catch(() => {});
          }
        } catch (err) {
          log.warn(`embedding batch failed: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
      }

      // Store chunks via pipeline
      const pipeline = this.client.pipeline();
      const now = Date.now();
      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j];
        const embedding = embeddings[j];
        if (!chunk || !embedding) {
          continue;
        }

        const id = `${hashText(filePath)}:${chunk.hash}:${chunk.startLine}`;
        const doc: RedisChunkDoc = {
          id,
          path: filePath,
          source,
          agent_id: this.agentId,
          model: this.provider.model,
          start_line: chunk.startLine,
          end_line: chunk.endLine,
          hash: chunk.hash,
          text: chunk.text,
          embedding,
          updated_at: now,
          access_count: 0,
        };
        pipeline.call("JSON.SET", chunkKey(id), "$", JSON.stringify(doc));
      }
      await pipeline.exec();
    }
  }

  private async deleteStaleEntries(diskFileHashes: Map<string, string>): Promise<void> {
    // Scan for this agent's file keys and remove those not on disk
    const filePrefix = `oc:file:${this.agentId}:`;
    let cursor = "0";
    do {
      const [nextCursor, keys] = await this.client.scan(
        cursor,
        "MATCH",
        `${filePrefix}*`,
        "COUNT",
        "100",
      );
      cursor = nextCursor;
      for (const key of keys) {
        const pathHash = key.slice(filePrefix.length);
        if (!diskFileHashes.has(pathHash)) {
          // Get file path to find associated chunks
          const pathRaw = (await this.client.call("JSON.GET", key, "$.path")) as string | null;
          const filePath = pathRaw ? parseJsonField(pathRaw) : null;

          if (filePath) {
            await this.deleteChunksForFile(filePath);
          }
          await this.client.call("JSON.DEL", key);
        }
      }
    } while (cursor !== "0");
  }

  private async deleteChunksForFile(filePath: string): Promise<void> {
    const pathHash = hashText(filePath);
    // Scan for chunk keys matching this file's prefix
    let cursor = "0";
    do {
      const [nextCursor, keys] = await this.client.scan(
        cursor,
        "MATCH",
        `${CHUNK_KEY_PREFIX}${pathHash}:*`,
        "COUNT",
        "200",
      );
      cursor = nextCursor;
      if (keys.length > 0) {
        const pipeline = this.client.pipeline();
        for (const key of keys) {
          pipeline.call("JSON.DEL", key);
        }
        await pipeline.exec();
      }
    } while (cursor !== "0");
  }

  private async deleteKeysByPrefix(prefix: string): Promise<void> {
    let cursor = "0";
    do {
      const [nextCursor, keys] = await this.client.scan(
        cursor,
        "MATCH",
        `${prefix}*`,
        "COUNT",
        "200",
      );
      cursor = nextCursor;
      if (keys.length > 0) {
        const pipeline = this.client.pipeline();
        for (const key of keys) {
          pipeline.call("JSON.DEL", key);
        }
        await pipeline.exec();
      }
    } while (cursor !== "0");
  }

  private async deleteAgentChunks(): Promise<void> {
    const agentFilter = `@agent_id:{${this.escapeTag(this.agentId)}}`;
    let offset = 0;
    const batch = 200;
    while (true) {
      const raw = (await this.client.call(
        "FT.SEARCH",
        CHUNK_INDEX,
        agentFilter,
        "LIMIT",
        String(offset),
        String(batch),
        "RETURN",
        "0",
        "DIALECT",
        "2",
      )) as unknown[];
      const total = Number(raw[0]) || 0;
      if (total === 0 || raw.length <= 1) {
        break;
      }
      const pipeline = this.client.pipeline();
      for (let i = 1; i < raw.length; i++) {
        pipeline.call("JSON.DEL", raw[i] as string);
      }
      await pipeline.exec();
      if (offset + batch >= total) {
        break;
      }
      offset += batch;
    }
  }

  private async enforceChunkBudget(): Promise<void> {
    const count = await this.getAgentChunkCount();
    if (count <= DEFAULT_MAX_CHUNKS) {
      return;
    }

    const pruneCount = Math.ceil(
      count - DEFAULT_MAX_CHUNKS + DEFAULT_MAX_CHUNKS * PRUNE_BUFFER_PCT,
    );
    log.info(`chunk budget exceeded (${count}/${DEFAULT_MAX_CHUNKS}); pruning ${pruneCount}`);

    const agentFilter = `@agent_id:{${this.escapeTag(this.agentId)}}`;
    try {
      const raw = (await this.client.call(
        "FT.SEARCH",
        CHUNK_INDEX,
        agentFilter,
        "SORTBY",
        "updated_at",
        "ASC",
        "LIMIT",
        "0",
        String(pruneCount),
        "RETURN",
        "0",
        "DIALECT",
        "2",
      )) as unknown[];

      const pipeline = this.client.pipeline();
      // RETURN 0 format: [total, key1, key2, ...]
      for (let i = 1; i < raw.length; i++) {
        pipeline.call("JSON.DEL", raw[i] as string);
      }
      await pipeline.exec();
    } catch (err) {
      log.warn(`chunk pruning failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async getAgentChunkCount(): Promise<number> {
    try {
      const agentFilter = `@agent_id:{${this.escapeTag(this.agentId)}}`;
      const raw = (await this.client.call(
        "FT.SEARCH",
        CHUNK_INDEX,
        agentFilter,
        "LIMIT",
        "0",
        "0",
        "DIALECT",
        "2",
      )) as unknown[];
      return Number(raw[0]) || 0;
    } catch {
      return 0;
    }
  }

  // ── probes ───────────────────────────────────────────────────────────────

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    try {
      const result = await this.provider.embedQuery("test");
      return { ok: result.length > 0 };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async probeVectorAvailability(): Promise<boolean> {
    try {
      await this.client.call("FT._LIST");
      return true;
    } catch {
      return false;
    }
  }

  // ── close ────────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    RedisMemoryManager.CACHE.delete(this.cacheKey);
    await this.client.quit();
  }

  // ── private helpers ──────────────────────────────────────────────────────

  private buildSourceFilter(): string {
    const sources = this.settings.sources ?? ["memory"];
    const agentFilter = `@agent_id:{${this.escapeTag(this.agentId)}}`;
    if (sources.length === 0 || sources.length === 2) {
      return agentFilter;
    }
    return `${agentFilter} @source:{${sources[0]}}`;
  }

  private escapeTag(value: string): string {
    // Escape RediSearch TAG special chars
    return value.replace(/[,.<>{}[\]"':;!@#$%^&*()\-+=~\s/\\]/g, "\\$&");
  }

  private escapeRedisQuery(text: string): string {
    const tokens = text.match(/[A-Za-z0-9_]+/g) ?? [];
    return tokens.join(" ") || "*";
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Parse a JSON.GET response like '["value"]' to extract the first element. */
function parseJsonField(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0) {
      return String(parsed[0]);
    }
    if (typeof parsed === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export default RedisMemoryManager;
