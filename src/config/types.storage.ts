export interface StorageConfig {
  backend?: "fs" | "redis";
  redis?: {
    url?: string;
    keyPrefix?: string;
    tls?: boolean;
    maxRetries?: number;
    connectTimeoutMs?: number;
    commandTimeoutMs?: number;
  };
  encryption?: {
    enabled?: boolean;
  };
}
