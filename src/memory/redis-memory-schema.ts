import type { Redis } from "ioredis";

// ── Index names ──────────────────────────────────────────────────────────────

export const CHUNK_INDEX = "idx:chunks";
export const FILE_INDEX = "idx:files";

// ── Key prefixes (full — client.call() bypasses ioredis keyPrefix) ───────────

export const CHUNK_KEY_PREFIX = "oc:chunk:";
export const FILE_KEY_PREFIX = "oc:file:";
export const EMB_CACHE_KEY_PREFIX = "oc:emb:";
export const META_KEY_PREFIX = "oc:meta:memory:";

// ── Document types ───────────────────────────────────────────────────────────

export type RedisChunkDoc = {
  id: string;
  path: string;
  source: string; // "memory" | "sessions"
  agent_id: string;
  model: string;
  start_line: number;
  end_line: number;
  hash: string;
  text: string;
  embedding: number[];
  updated_at: number;
  access_count: number;
};

export type RedisFileDoc = {
  path: string;
  source: string;
  hash: string;
  mtime: number;
  size: number;
};

// ── Index management ─────────────────────────────────────────────────────────

function isIndexExistsError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("Index already exists");
}

/**
 * Ensure the chunk index exists. Idempotent — silently ignores "Index already exists".
 * client.call() bypasses ioredis keyPrefix, so we use full prefixes in FT.CREATE.
 */
export async function ensureChunkIndex(client: Redis, dims: number): Promise<void> {
  try {
    await client.call(
      "FT.CREATE",
      CHUNK_INDEX,
      "ON",
      "JSON",
      "PREFIX",
      "1",
      CHUNK_KEY_PREFIX,
      "SCHEMA",
      "$.text",
      "AS",
      "text",
      "TEXT",
      "WEIGHT",
      "1.0",
      "$.source",
      "AS",
      "source",
      "TAG",
      "SEPARATOR",
      "|",
      "$.model",
      "AS",
      "model",
      "TAG",
      "SEPARATOR",
      "|",
      "$.agent_id",
      "AS",
      "agent_id",
      "TAG",
      "SEPARATOR",
      "|",
      "$.path",
      "AS",
      "path",
      "TAG",
      "SEPARATOR",
      "|",
      "$.start_line",
      "AS",
      "start_line",
      "NUMERIC",
      "SORTABLE",
      "$.end_line",
      "AS",
      "end_line",
      "NUMERIC",
      "SORTABLE",
      "$.updated_at",
      "AS",
      "updated_at",
      "NUMERIC",
      "SORTABLE",
      "$.access_count",
      "AS",
      "access_count",
      "NUMERIC",
      "SORTABLE",
      "$.embedding",
      "AS",
      "embedding",
      "VECTOR",
      "HNSW",
      "10",
      "TYPE",
      "FLOAT32",
      "DIM",
      String(dims),
      "DISTANCE_METRIC",
      "COSINE",
      "M",
      "16",
      "EF_CONSTRUCTION",
      "200",
    );
  } catch (err) {
    if (!isIndexExistsError(err)) {
      throw err;
    }
  }
}

/** Ensure the file index exists. Idempotent. */
export async function ensureFileIndex(client: Redis): Promise<void> {
  try {
    await client.call(
      "FT.CREATE",
      FILE_INDEX,
      "ON",
      "JSON",
      "PREFIX",
      "1",
      FILE_KEY_PREFIX,
      "SCHEMA",
      "$.path",
      "AS",
      "path",
      "TAG",
      "SEPARATOR",
      "|",
      "$.source",
      "AS",
      "source",
      "TAG",
      "SEPARATOR",
      "|",
      "$.hash",
      "AS",
      "hash",
      "TAG",
      "SEPARATOR",
      "|",
      "$.mtime",
      "AS",
      "mtime",
      "NUMERIC",
      "SORTABLE",
      "$.size",
      "AS",
      "size",
      "NUMERIC",
      "SORTABLE",
    );
  } catch (err) {
    if (!isIndexExistsError(err)) {
      throw err;
    }
  }
}

/**
 * Drop and recreate the chunk index (e.g. when embedding dimensions change).
 * Does NOT delete underlying JSON data (no DD flag).
 */
export async function recreateChunkIndex(client: Redis, dims: number): Promise<void> {
  try {
    await client.call("FT.DROPINDEX", CHUNK_INDEX);
  } catch {
    // Index may not exist — ignore
  }
  await ensureChunkIndex(client, dims);
}

/**
 * Check if the chunk index exists and return basic info.
 * FT.INFO returns a flat array of alternating key-value pairs.
 */
export async function getChunkIndexInfo(
  client: Redis,
): Promise<{ exists: boolean; numDocs?: number; dims?: number }> {
  try {
    const raw = (await client.call("FT.INFO", CHUNK_INDEX)) as string[];
    const info = flatArrayToMap(raw);

    const numDocs = info.get("num_docs") !== undefined ? Number(info.get("num_docs")) : undefined;

    // Parse dims from the vector attribute definition
    const dims = parseVectorDims(raw);

    return { exists: true, numDocs, dims };
  } catch {
    return { exists: false };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Convert FT.INFO flat [key, value, key, value, ...] response to a Map. */
function flatArrayToMap(arr: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < arr.length - 1; i += 2) {
    map.set(String(arr[i]), String(arr[i + 1]));
  }
  return map;
}

/**
 * Walk the FT.INFO response to find DIM inside the vector attribute definition.
 * Redis returns nested arrays; ioredis gives: ["dim", 4] (lowercase key, numeric value).
 */
function parseVectorDims(raw: unknown[]): number | undefined {
  const flat = JSON.stringify(raw);
  // Match "dim",<number> — Redis returns lowercase key with numeric (not string) value
  const match = flat.match(/"dim",(\d+)/i);
  return match ? Number(match[1]) : undefined;
}

/** Convert a number[] embedding to a Float32 little-endian Buffer for KNN queries. */
export function embeddingToBuffer(embedding: number[]): Buffer {
  const buf = Buffer.alloc(embedding.length * 4);
  for (let i = 0; i < embedding.length; i++) {
    buf.writeFloatLE(embedding[i] ?? 0, i * 4);
  }
  return buf;
}

// ── Key builders (use full prefix — client.call() bypasses keyPrefix) ────────

export function chunkKey(id: string): string {
  return `${CHUNK_KEY_PREFIX}${id}`;
}

export function fileKey(pathHash: string): string {
  return `${FILE_KEY_PREFIX}${pathHash}`;
}

export function embCacheKey(provider: string, model: string, contentHash: string): string {
  return `${EMB_CACHE_KEY_PREFIX}${provider}:${model}:${contentHash}`;
}

export function metaKey(field: string): string {
  return `${META_KEY_PREFIX}${field}`;
}
