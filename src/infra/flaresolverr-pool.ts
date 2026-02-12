import { randomUUID } from "node:crypto";
import { execDocker } from "../agents/sandbox/docker.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("flaresolverr").child("pool");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface FlaresolverrConfig {
  /** Docker image. Default: "ghcr.io/flaresolverr/flaresolverr:latest" */
  image: string;
  /** Docker network to join. Default: "bridge" */
  network: string;
  /** Container memory limit. Default: "1g" */
  memoryLimit: string;
  /** Container name prefix. Default: "claw-flaresolverr-" */
  containerPrefix: string;
  /** How long (ms) to wait for the health endpoint after starting. */
  healthTimeoutMs: number;
  /** Polling interval (ms) during health check. */
  healthIntervalMs: number;
  /** Idle timeout (ms) — container is killed if no request arrives within this window. */
  idleTimeoutMs: number;
  /** Extra environment variables for the container. */
  extraEnv?: Record<string, string>;
}

const DEFAULT_CONFIG: FlaresolverrConfig = {
  image: "ghcr.io/flaresolverr/flaresolverr:latest",
  network: "bridge",
  memoryLimit: "1g",
  containerPrefix: "claw-flaresolverr-",
  healthTimeoutMs: 30_000,
  healthIntervalMs: 1_000,
  idleTimeoutMs: 5 * 60_000, // 5 minutes
  extraEnv: {
    LOG_LEVEL: "info",
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// FlaresolverrInstance — one ephemeral container per session
// ---------------------------------------------------------------------------

export class FlaresolverrInstance {
  readonly label: string;
  private readonly cfg: FlaresolverrConfig;
  private containerName: string | null = null;
  private containerUrl: string | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private starting: Promise<string> | null = null;
  private shuttingDown = false;

  constructor(label: string, config?: Partial<FlaresolverrConfig>) {
    this.label = label;
    this.cfg = { ...DEFAULT_CONFIG, ...config };
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Ensure this instance's FlareSolverr is running. Returns the base URL
   * (e.g. `http://claw-flaresolverr-abc123:8191`). Spawns a container if
   * one isn't already up. Resets the idle timer on every call.
   */
  async ensureRunning(): Promise<string> {
    if (this.shuttingDown) {
      throw new Error(`FlaresolverrInstance[${this.label}] is shutting down`);
    }

    // Already running — just bump the idle timer
    if (this.containerUrl && this.containerName) {
      this.resetIdleTimer();
      return this.containerUrl;
    }

    // Another caller is already starting it — piggyback
    if (this.starting) {
      return this.starting;
    }

    this.starting = this.spawnContainer().finally(() => {
      this.starting = null;
    });

    return this.starting;
  }

  /** Return the current URL if running, or null. */
  getUrl(): string | null {
    return this.containerUrl;
  }

  /** Return the container name if running, or null. */
  getContainerName(): string | null {
    return this.containerName;
  }

  /** Return true if a FlareSolverr container is tracked. */
  isRunning(): boolean {
    return this.containerName !== null;
  }

  /** Forcefully shut down the container and clean up. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.clearIdleTimer();

    if (this.containerName) {
      log.info(`[${this.label}] shutting down ${this.containerName}`);
      await execDocker(["rm", "-f", this.containerName], { allowFailure: true });
      this.containerName = null;
      this.containerUrl = null;
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async spawnContainer(): Promise<string> {
    const id = randomUUID().slice(0, 12);
    const name = `${this.cfg.containerPrefix}${id}`;

    log.info(`[${this.label}] spawning ${name}`);

    const args = [
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "--network",
      this.cfg.network,
      "--memory",
      this.cfg.memoryLimit,
    ];

    // Environment variables
    const envVars: Record<string, string> = {
      ...this.cfg.extraEnv,
    };
    for (const [key, value] of Object.entries(envVars)) {
      args.push("-e", `${key}=${value}`);
    }

    args.push(this.cfg.image);

    try {
      await execDocker(args);
    } catch (err) {
      log.warn(`[${this.label}] failed to start ${name}: ${String(err)}`);
      await execDocker(["rm", "-f", name], { allowFailure: true });
      throw new Error(`Failed to start FlareSolverr container: ${String(err)}`, {
        cause: err,
      });
    }

    // Wait for the health endpoint
    try {
      await this.waitForHealth(name);
    } catch (err) {
      log.warn(`[${this.label}] health check timeout for ${name}`);
      await execDocker(["rm", "-f", name], { allowFailure: true });
      throw new Error(`FlareSolverr container failed health check: ${String(err)}`, {
        cause: err,
      });
    }

    const url = `http://${name}:8191`;
    this.containerName = name;
    this.containerUrl = url;
    this.resetIdleTimer();

    log.info(`[${this.label}] flaresolverr ready at ${url}`);
    return url;
  }

  private async waitForHealth(containerName: string): Promise<void> {
    const deadline = Date.now() + this.cfg.healthTimeoutMs;

    while (Date.now() < deadline) {
      const result = await execDocker(
        ["exec", containerName, "curl", "-sf", "--max-time", "2", "http://localhost:8191"],
        { allowFailure: true },
      );

      if (result.code === 0 && result.stdout.includes("FlareSolverr is ready")) {
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

  private resetIdleTimer(): void {
    this.clearIdleTimer();

    this.idleTimer = setTimeout(() => {
      log.info(
        `[${this.label}] idle timeout (${this.cfg.idleTimeoutMs}ms) — destroying ${this.containerName}`,
      );
      void this.destroyContainer();
    }, this.cfg.idleTimeoutMs);

    // Don't keep the process alive just for the idle timer
    if (typeof this.idleTimer === "object" && "unref" in this.idleTimer) {
      this.idleTimer.unref();
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async destroyContainer(): Promise<void> {
    this.clearIdleTimer();

    if (!this.containerName) {
      return;
    }

    const name = this.containerName;
    this.containerName = null;
    this.containerUrl = null;

    log.info(`[${this.label}] destroying ${name}`);
    await execDocker(["rm", "-f", name], { allowFailure: true });

    // Remove ourselves from the pool
    _instances.delete(this.label);
  }
}

// ---------------------------------------------------------------------------
// Pool — keyed instances (one per session / label)
// ---------------------------------------------------------------------------

const _instances = new Map<string, FlaresolverrInstance>();

/**
 * Get or create a FlareSolverr instance for the given label. Each label
 * gets its own independent container so concurrent sessions never conflict.
 */
export function getFlaresolverrInstance(
  label: string,
  config?: Partial<FlaresolverrConfig>,
): FlaresolverrInstance {
  let inst = _instances.get(label);
  if (!inst) {
    inst = new FlaresolverrInstance(label, config);
    _instances.set(label, inst);
  }
  return inst;
}

/**
 * Convenience: ensure a FlareSolverr instance for `label` is running and
 * return its base URL.
 */
export async function ensureFlaresolverr(
  label: string,
  config?: Partial<FlaresolverrConfig>,
): Promise<string> {
  return getFlaresolverrInstance(label, config).ensureRunning();
}

/** Return the current FlareSolverr URL for a label, or null. */
export function getFlaresolverrUrl(label: string): string | null {
  return _instances.get(label)?.getUrl() ?? null;
}

/** Shut down a single instance by label. */
export async function shutdownFlaresolverrInstance(label: string): Promise<void> {
  const inst = _instances.get(label);
  if (inst) {
    await inst.shutdown();
    _instances.delete(label);
  }
}

/** Shut down ALL FlareSolverr instances and clean up orphans. */
export async function shutdownFlaresolverr(): Promise<void> {
  const labels = [..._instances.keys()];
  if (labels.length === 0) {
    // Still sweep orphans in case containers survived a crash
    await cleanupOrphanContainers();
    return;
  }

  log.info(`shutting down ${labels.length} flaresolverr instance(s)`);
  await Promise.allSettled(labels.map((l) => shutdownFlaresolverrInstance(l)));

  // Final orphan sweep
  await cleanupOrphanContainers();
  log.info("flaresolverr pool shut down");
}

/** Find and kill any orphaned `claw-flaresolverr-*` containers. */
async function cleanupOrphanContainers(prefix = DEFAULT_CONFIG.containerPrefix): Promise<number> {
  try {
    const result = await execDocker(
      ["ps", "-a", "--filter", `name=${prefix}`, "--format", "{{.Names}}"],
      { allowFailure: true },
    );

    if (result.code !== 0 || !result.stdout?.trim()) {
      return 0;
    }

    // Collect names of containers we're actively tracking
    const tracked = new Set<string>();
    for (const inst of _instances.values()) {
      const name = inst.getContainerName();
      if (name) {
        tracked.add(name);
      }
    }

    const orphans = result.stdout
      .trim()
      .split("\n")
      .filter((n) => n.startsWith(prefix) && !tracked.has(n));

    if (orphans.length === 0) {
      return 0;
    }

    log.info(
      `cleaning up ${orphans.length} orphaned flaresolverr container(s): ${orphans.join(", ")}`,
    );
    await execDocker(["rm", "-f", ...orphans], { allowFailure: true });
    return orphans.length;
  } catch (err) {
    log.warn(`orphan cleanup failed: ${String(err)}`);
    return 0;
  }
}
