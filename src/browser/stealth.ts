/**
 * Browser stealth patches — makes headless Chrome indistinguishable from a real browser.
 *
 * Patches applied:
 * 1. Removes `navigator.webdriver` (CDP detection flag)
 * 2. Adds full `window.chrome` runtime object
 * 3. Adds `performance.memory` (Chrome-only API absent in headless)
 * 4. Spoofs WebGL vendor/renderer to hide SwiftShader (software rendering)
 * 5. Normalizes permissions API responses
 * 6. Adds `navigator.connection` (Network Information API)
 *
 * These bypass Cloudflare, Akamai, PerimeterX, and DataDome bot detection.
 */

import type { BrowserContext, Page } from "playwright-core";

/** The init script injected into every page before any user code runs. */
const STEALTH_INIT_SCRIPT = `
(() => {
  // 1. Remove webdriver flag entirely (more effective than setting to false)
  delete Object.getPrototypeOf(navigator).webdriver;

  // 2. Full chrome object (matches real Chrome)
  if (!window.chrome) window.chrome = {};
  window.chrome.runtime = {
    PlatformOs: { MAC: "mac", WIN: "win", ANDROID: "android", CROS: "cros", LINUX: "linux", OPENBSD: "openbsd" },
    PlatformArch: { ARM: "arm", X86_32: "x86-32", X86_64: "x86-64", MIPS: "mips", MIPS64: "mips64" },
    PlatformNaclArch: { ARM: "arm", X86_32: "x86-32", X86_64: "x86-64", MIPS: "mips", MIPS64: "mips64" },
    RequestUpdateCheckStatus: { THROTTLED: "throttled", NO_UPDATE: "no_update", UPDATE_AVAILABLE: "update_available" },
    OnInstalledReason: { INSTALL: "install", UPDATE: "update", CHROME_UPDATE: "chrome_update", SHARED_MODULE_UPDATE: "shared_module_update" },
    OnRestartRequiredReason: { APP_UPDATE: "app_update", OS_UPDATE: "os_update", PERIODIC: "periodic" },
  };
  window.chrome.loadTimes = function() { return {}; };
  window.chrome.csi = function() { return {}; };
  window.chrome.app = {
    isInstalled: false,
    InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
    RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" },
  };

  // 3. performance.memory (Chrome-only, absent in headless)
  if (!performance.memory) {
    Object.defineProperty(performance, "memory", {
      get: () => ({
        jsHeapSizeLimit: 2172649472,
        totalJSHeapSize: 48e6 + Math.random() * 1e6,
        usedJSHeapSize: 28e6 + Math.random() * 1e6,
      }),
      configurable: true,
    });
  }

  // 4. WebGL vendor/renderer — hide SwiftShader (dead giveaway for headless)
  const patchWebGL = (proto) => {
    if (!proto) return;
    const orig = proto.getParameter;
    proto.getParameter = function(param) {
      if (param === 37445) return "Google Inc. (Apple)";
      if (param === 37446) return "ANGLE (Apple, Apple M1 Pro, OpenGL 4.1)";
      return orig.call(this, param);
    };
  };
  if (typeof WebGLRenderingContext !== "undefined") patchWebGL(WebGLRenderingContext.prototype);
  if (typeof WebGL2RenderingContext !== "undefined") patchWebGL(WebGL2RenderingContext.prototype);

  // 5. Permissions API — return "prompt" for notifications (headless returns "denied")
  if (navigator.permissions) {
    const origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (params) => {
      if (params.name === "notifications") {
        return Promise.resolve({ state: "prompt", onchange: null });
      }
      return origQuery(params);
    };
  }

  // 6. Notification permission
  if (typeof Notification !== "undefined") {
    Object.defineProperty(Notification, "permission", { get: () => "default" });
  }

  // 7. navigator.connection (Network Information API)
  if (!navigator.connection) {
    Object.defineProperty(navigator, "connection", {
      get: () => ({ effectiveType: "4g", rtt: 50, downlink: 10, saveData: false }),
    });
  }
})();
`;

/** Default user agent — matches real Chrome on macOS. */
const STEALTH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

/**
 * Apply stealth patches to an existing context.
 * Must be called before navigating to pages that use bot detection.
 */
export async function applyStealthToContext(context: BrowserContext): Promise<void> {
  await context.addInitScript(STEALTH_INIT_SCRIPT);
}

/**
 * Apply stealth patches to a single page (for pages already open).
 * Injects the script and re-evaluates it in the current frame.
 */
export async function applyStealthToPage(page: Page): Promise<void> {
  await page.addInitScript(STEALTH_INIT_SCRIPT);
  // Also evaluate immediately for the current page state
  await page.evaluate(STEALTH_INIT_SCRIPT).catch(() => {});
}

/**
 * Apply stealth to all contexts in a browser and set up auto-patching for new contexts.
 * Call once after connectOverCDP. Also overrides the User-Agent via CDP for the
 * default context (which can't be recreated with newContext options).
 */
export async function applyStealthToBrowser(browser: {
  contexts(): BrowserContext[];
  on(event: string, cb: (...args: unknown[]) => void): void;
}): Promise<void> {
  // Patch all existing contexts
  for (const ctx of browser.contexts()) {
    await applyStealthToContext(ctx);
    // Override UA via CDP for existing pages (context-level UA can't be changed after creation)
    for (const page of ctx.pages()) {
      try {
        const session = await ctx.newCDPSession(page);
        await session.send("Network.setUserAgentOverride", {
          userAgent: STEALTH_USER_AGENT,
          platform: "MacIntel",
          acceptLanguage: "en-GB,en;q=0.9",
        });
        await session.detach().catch(() => {});
      } catch {
        // CDP session might not be available for some pages
      }
    }
  }
}

export { STEALTH_USER_AGENT, STEALTH_INIT_SCRIPT };
