import { describePhiBootstrapWindow, type PhiBootstrapWindow } from "./bootstrap-window";
import { logRuntimeEvent } from "./log";
import {
  readPhiRuntimeConfigSync,
  readMergedPhiConfigSync,
  type PhisConfig,
} from "./config-files";

const CACHE_TTL_MS = 1000 * 60 * 60 * 4;

let cachedConfig: PhisConfig | null = null;
let cachedAt = 0;

export function resetPhisConfigCache() {
  cachedConfig = null;
  cachedAt = 0;
}

export function getPhisConfigSync() {
  if (cachedConfig && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedConfig;
  }

  cachedConfig = readMergedPhiConfigSync();
  cachedAt = Date.now();
  return cachedConfig;
}

export async function getPhisConfig() {
  return getPhisConfigSync();
}

/** Whether the setup pages are open now; read uncached from the runtime file (`bootstrap-window.ts`). */
export function isBootstrapEnabled() {
  return readPhiBootstrapWindowSync().state === "open";
}

let lastLoggedState: string | null = null;

/**
 * Whether the setup is open right now, read from the runtime file on every call.
 *
 * Uncached on purpose. The rest of the configuration is cached for hours, and the setup must neither open
 * late after `phis setup enable` nor stay open after its end or after `phis setup disable`. The file is a
 * few kilobytes; reading it per setup request costs nothing worth saving.
 *
 * The first answer of a process and every change after it are logged, so the journal says when the setup
 * opened and closed and why.
 */
export function readPhiBootstrapWindowSync(): PhiBootstrapWindow {
  let setupWindow: PhiBootstrapWindow;
  try {
    setupWindow = describePhiBootstrapWindow(readPhiRuntimeConfigSync());
  } catch {
    setupWindow = { state: "closed", reason: "invalid", until: null };
  }
  const key = setupWindow.state === "open"
    ? `open:${setupWindow.until.toISOString()}`
    : `closed:${setupWindow.reason}:${setupWindow.until?.toISOString() ?? ""}`;
  if (key !== lastLoggedState) {
    lastLoggedState = key;
    const open = setupWindow.state === "open";
    logRuntimeEvent(open ? "warn" : "info", open ? "setup.window.open" : "setup.window.closed", {
      message: setupWindow.state === "open"
        ? `The setup pages are open until ${setupWindow.until.toISOString()}.`
        : `The setup pages are closed (${setupWindow.reason}).`,
      area: "setup",
      meta: {
        until: setupWindow.until?.toISOString() ?? null,
        ...(setupWindow.state === "closed" ? { reason: setupWindow.reason } : {}),
      },
    });
  }
  return setupWindow;
}
