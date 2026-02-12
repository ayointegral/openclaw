export type BrowserProfileConfig = {
  /** CDP port for this profile. Allocated once at creation, persisted permanently. */
  cdpPort?: number;
  /** CDP URL for this profile (use for remote Chrome). */
  cdpUrl?: string;
  /** Profile driver (default: openclaw). "pool" uses ephemeral Docker containers. */
  driver?: "openclaw" | "extension" | "pool";
  /** Profile color (hex). Auto-assigned at creation. */
  color: string;
};
export type BrowserSnapshotDefaults = {
  /** Default snapshot mode (applies when mode is not provided). */
  mode?: "efficient";
};
export type BrowserConfig = {
  enabled?: boolean;
  /** If false, disable browser act:evaluate (arbitrary JS). Default: true */
  evaluateEnabled?: boolean;
  /** Base URL of the CDP endpoint (for remote browsers). Default: loopback CDP on the derived port. */
  cdpUrl?: string;
  /** Remote CDP HTTP timeout (ms). Default: 1500. */
  remoteCdpTimeoutMs?: number;
  /** Remote CDP WebSocket handshake timeout (ms). Default: max(remoteCdpTimeoutMs * 2, 2000). */
  remoteCdpHandshakeTimeoutMs?: number;
  /** Accent color for the openclaw browser profile (hex). Default: #FF4500 */
  color?: string;
  /** Override the browser executable path (all platforms). */
  executablePath?: string;
  /** Start Chrome headless (best-effort). Default: false */
  headless?: boolean;
  /** Pass --no-sandbox to Chrome (Linux containers). Default: false */
  noSandbox?: boolean;
  /** If true: never launch; only attach to an existing browser. Default: false */
  attachOnly?: boolean;
  /** Default profile to use when profile param is omitted. Default: "chrome" */
  defaultProfile?: string;
  /** Named browser profiles with explicit CDP ports or URLs. */
  profiles?: Record<string, BrowserProfileConfig>;
  /** Default snapshot options (applied by the browser tool/CLI when unset). */
  snapshotDefaults?: BrowserSnapshotDefaults;
  /** Ephemeral browser pool configuration (used when a profile has driver="pool"). */
  pool?: {
    /** Docker image for ephemeral containers. Default: "ghcr.io/browserless/chromium:latest" */
    image?: string;
    /** Docker network to join. Default: derived from compose project. */
    network?: string;
    /** Max concurrent ephemeral containers. Default: 5 */
    maxConcurrent?: number;
    /** Max queued requests. Default: 10 */
    maxQueued?: number;
    /** Container memory limit. Default: "1g" */
    memoryLimit?: string;
    /** Shared memory size. Default: "256m" */
    shmSize?: string;
    /** Kill container after this many ms. Default: 300000 (5 min) */
    timeoutMs?: number;
  };
  /** Ephemeral FlareSolverr configuration (Cloudflare bypass). */
  flaresolverr?: {
    /** Docker image. Default: "ghcr.io/flaresolverr/flaresolverr:latest" */
    image?: string;
    /** Docker network to join. Default: "bridge" */
    network?: string;
    /** Container memory limit. Default: "1g" */
    memoryLimit?: string;
    /** Idle timeout (ms) — auto-destroy after inactivity. Default: 300000 (5 min) */
    idleTimeoutMs?: number;
  };
};
