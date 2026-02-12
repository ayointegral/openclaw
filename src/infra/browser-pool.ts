import { randomUUID } from "node:crypto";
import { execDocker } from "../agents/sandbox/docker.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("browser").child("pool");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrowserPoolConfig {
  image: string;
  network: string;
  maxConcurrent: number;
  maxQueued: number;
  containerMemoryLimit: string;
  shmSize: string;
  containerTimeoutMs: number;
  healthTimeoutMs: number;
  healthIntervalMs: number;
  browserlessPort: number;
  containerPrefix: string;
  extraEnv?: Record<string, string>;
}

export interface PooledBrowser {
  id: string;
  containerName: string;
  cdpUrl: string;
  createdAt: number;
  release: () => Promise<void>;
}

const DEFAULT_CONFIG: BrowserPoolConfig = {
  image: "ghcr.io/browserless/chromium:latest",
  network: "bridge",
  maxConcurrent: 5,
  maxQueued: 10,
  containerMemoryLimit: "1g",
  shmSize: "256m",
  containerTimeoutMs: 300_000,
  healthTimeoutMs: 15_000,
  healthIntervalMs: 500,
  browserlessPort: 3000,
  containerPrefix: "claw-browser-",
  extraEnv: undefined,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ActiveEntry {
  browser: PooledBrowser;
  killTimer: ReturnType<typeof setTimeout>;
}

interface QueuedWaiter {
  resolve: (browser: PooledBrowser) => void;
  reject: (err: Error) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// BrowserPoolManager
// ---------------------------------------------------------------------------

export class BrowserPoolManager {
  private readonly cfg: BrowserPoolConfig;
  private readonly active = new Map<string, ActiveEntry>();
  private readonly queue: QueuedWaiter[] = [];
  private totalCreated = 0;
  private shuttingDown = false;

  constructor(config?: Partial<BrowserPoolConfig>) {
    this.cfg = { ...DEFAULT_CONFIG, ...config };
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  async acquire(): Promise<PooledBrowser> {
    if (this.shuttingDown) {
      throw new Error("BrowserPoolManager is shutting down");
    }

    if (this.active.size < this.cfg.maxConcurrent) {
      return this.startContainer();
    }

    if (this.queue.length >= this.cfg.maxQueued) {
      throw new Error(
        `Browser pool queue full (${this.queue.length}/${this.cfg.maxQueued}). ` +
          `Active: ${this.active.size}/${this.cfg.maxConcurrent}`,
      );
    }

    log.debug(`queuing request (active=${this.active.size}, queued=${this.queue.length + 1})`);

    return new Promise<PooledBrowser>((resolve, reject) => {
      this.queue.push({ resolve, reject });
    });
  }

  async release(id: string): Promise<void> {
    const entry = this.active.get(id);
    if (!entry) {
      return; // idempotent
    }

    this.active.delete(id);
    clearTimeout(entry.killTimer);

    const { containerName } = entry.browser;
    const elapsed = Date.now() - entry.browser.createdAt;
    log.info(`releasing ${containerName} after ${elapsed}ms`);

    await execDocker(["rm", "-f", containerName], { allowFailure: true });

    this.drainNext();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    // Reject all queued waiters
    for (const waiter of this.queue.splice(0)) {
      waiter.reject(new Error("BrowserPoolManager is shutting down"));
    }

    // Release all active containers in parallel
    const releases = [...this.active.keys()].map((id) => this.release(id));
    await Promise.allSettled(releases);

    log.info("pool shut down");
  }

  stats(): { active: number; queued: number; total: number; maxConcurrent: number } {
    return {
      active: this.active.size,
      queued: this.queue.length,
      total: this.totalCreated,
      maxConcurrent: this.cfg.maxConcurrent,
    };
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async startContainer(): Promise<PooledBrowser> {
    const id = randomUUID();
    const containerName = `${this.cfg.containerPrefix}${id.slice(0, 12)}`;
    const createdAt = Date.now();

    log.info(`starting ${containerName}`);

    try {
      await this.runContainer(containerName);
    } catch (err) {
      log.warn(`failed to start ${containerName}: ${String(err)}`);
      await execDocker(["rm", "-f", containerName], { allowFailure: true });
      throw new Error(`Failed to start browser container ${containerName}: ${String(err)}`, {
        cause: err,
      });
    }

    try {
      await this.waitForHealth(containerName);
    } catch (err) {
      log.warn(`health check timeout for ${containerName}`);
      await execDocker(["rm", "-f", containerName], { allowFailure: true });
      throw new Error(`Browser container ${containerName} failed health check: ${String(err)}`, {
        cause: err,
      });
    }

    const cdpUrl = `http://${containerName}:${this.cfg.browserlessPort}/chromium/playwright`;

    const browser: PooledBrowser = {
      id,
      containerName,
      cdpUrl,
      createdAt,
      release: () => this.release(id),
    };

    // Safety-net kill timer
    const killTimer = setTimeout(() => {
      log.warn(`force-killing ${containerName} after ${this.cfg.containerTimeoutMs}ms timeout`);
      void this.release(id);
    }, this.cfg.containerTimeoutMs);

    // Prevent the timer from keeping the process alive
    if (typeof killTimer === "object" && "unref" in killTimer) {
      killTimer.unref();
    }

    this.active.set(id, { browser, killTimer });
    this.totalCreated += 1;

    const elapsed = Date.now() - createdAt;
    log.info(`acquired ${containerName} in ${elapsed}ms (cdp=${cdpUrl})`);

    return browser;
  }

  private async runContainer(containerName: string): Promise<void> {
    const args = [
      "run",
      "-d",
      "--rm",
      "--name",
      containerName,
      "--network",
      this.cfg.network,
      "--memory",
      this.cfg.containerMemoryLimit,
      "--tmpfs",
      `/dev/shm:size=${this.cfg.shmSize}`,
      "-e",
      "PORT=3000",
      "-e",
      "CONCURRENT=1",
      "-e",
      "QUEUED=0",
      "-e",
      "TIMEOUT=120000",
    ];

    if (this.cfg.extraEnv) {
      for (const [key, value] of Object.entries(this.cfg.extraEnv)) {
        args.push("-e", `${key}=${value}`);
      }
    }

    args.push(this.cfg.image);

    await execDocker(args);
  }

  private async waitForHealth(containerName: string): Promise<void> {
    const deadline = Date.now() + this.cfg.healthTimeoutMs;

    while (Date.now() < deadline) {
      const result = await execDocker(
        ["exec", containerName, "curl", "-sf", "http://localhost:3000/config"],
        { allowFailure: true },
      );

      if (result.code === 0) {
        return;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }

      await sleep(Math.min(this.cfg.healthIntervalMs, remaining));
    }

    throw new Error(`Health check timed out after ${this.cfg.healthTimeoutMs}ms`);
  }

  private drainNext(): void {
    if (this.shuttingDown) {
      return;
    }

    if (this.queue.length === 0) {
      return;
    }

    if (this.active.size >= this.cfg.maxConcurrent) {
      return;
    }

    const waiter = this.queue.shift();
    if (!waiter) {
      return;
    }

    log.debug(`dequeuing request (active=${this.active.size}, queued=${this.queue.length})`);

    this.startContainer().then(waiter.resolve, waiter.reject);
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let _instance: BrowserPoolManager | null = null;

export function getBrowserPool(config?: Partial<BrowserPoolConfig>): BrowserPoolManager {
  if (!_instance) {
    _instance = new BrowserPoolManager(config);
  }
  return _instance;
}

export function shutdownBrowserPool(): Promise<void> {
  if (!_instance) {
    return Promise.resolve();
  }
  const p = _instance.shutdown();
  _instance = null;
  return p;
}
