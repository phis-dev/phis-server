import { Client } from "pg";

import {
  describePhiBootstrapWindow,
  parsePhiBootstrapWindowDuration,
  PHI_BOOTSTRAP_WINDOW_DEFAULT_MS,
  resolvePhiBootstrapWindowEnd,
  type PhiBootstrapWindow,
} from "../lib/bootstrap-window.ts";
import { readPhiRuntimeConfigSync, resolvePhiConfigPaths, writePhiRuntimeConfigSync } from "../lib/config-files-cli.ts";
import type { PhisConfig } from "../lib/config-core.ts";
import { fillPhiRuntimeKeys, listMissingPhiRuntimeKeys, type PhiRuntimeKeyName } from "../lib/runtime-keys.ts";

/**
 * `phis setup` and `phis config init-keys`: the setup pages' time window, and the keys an installation
 * makes for itself.
 *
 * The window is read by the server from the runtime file on every setup request, so writing it here takes
 * effect without a restart. Everything else this writes (the keys) is read through the four-hour cache.
 */

export function openPhiSetupWindow(configRoot: string, duration: string | null, now = Date.now()) {
  const durationMs = duration ? parsePhiBootstrapWindowDuration(duration) : PHI_BOOTSTRAP_WINDOW_DEFAULT_MS;
  const until = resolvePhiBootstrapWindowEnd(durationMs, now);
  const runtime = readPhiRuntimeConfigSync(configRoot);
  writePhiRuntimeConfigSync({ ...runtime, bootstrap: { ...runtime.bootstrap, enabledUntil: until.toISOString() } }, configRoot);
  return { until, path: resolvePhiConfigPaths(configRoot).runtime };
}

export function closePhiSetupWindow(configRoot: string) {
  const runtime = readPhiRuntimeConfigSync(configRoot);
  const wasOpen = describePhiBootstrapWindow(runtime).state === "open";
  if (runtime.bootstrap !== undefined) {
    const { bootstrap: _window, ...rest } = runtime;
    writePhiRuntimeConfigSync(rest, configRoot);
  }
  return { wasOpen, path: resolvePhiConfigPaths(configRoot).runtime };
}

export type PhiSetupStep = { key: string; done: boolean; detail: string };

/**
 * What is still missing before the installation serves, in the order the setup and `phis install` do it.
 *
 * Read from the runtime file and, once a database is named, from the database itself. A database that
 * cannot be reached is a missing step, not an error: telling the operator so is the point of the command.
 */
export async function readPhiSetupSteps(runtime: PhisConfig): Promise<PhiSetupStep[]> {
  const steps: PhiSetupStep[] = [];
  const uri = runtime.database?.uri?.trim();
  steps.push({ key: "database", done: Boolean(uri), detail: uri ? "database.uri is set" : "no database.uri (phis db bootstrap)" });

  let schema: PhiSetupStep = { key: "schema", done: false, detail: "needs a database first" };
  let sites: PhiSetupStep = { key: "site", done: false, detail: "needs the schema first" };
  if (uri) {
    const client = new Client({ connectionString: uri, connectionTimeoutMillis: 5000 });
    try {
      await client.connect();
      const { rows } = await client.query<{ present: boolean }>(
        "SELECT to_regclass('phis.sites') IS NOT NULL AS present",
      );
      const present = rows[0]?.present === true;
      schema = { key: "schema", done: present, detail: present ? "phis schema applied" : "schema missing (phis schema apply)" };
      if (present) {
        const count = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM phis.sites");
        const n = Number(count.rows[0]?.count ?? 0);
        sites = { key: "site", done: n > 0, detail: n > 0 ? `${n} Site(s)` : "no Site yet (phis site add)" };
      }
    } catch (error) {
      schema = { key: "schema", done: false, detail: `database not reachable: ${(error as Error).message}` };
    } finally {
      await client.end().catch(() => undefined);
    }
  }
  steps.push(schema);

  const missing = listMissingPhiRuntimeKeys(runtime);
  steps.push({
    key: "keys",
    done: missing.length === 0,
    detail: missing.length === 0 ? "all keys present" : `missing ${missing.join(", ")} (phis config init-keys)`,
  });

  const operators = (runtime.platformSuperUsers ?? []).filter((user) => user.enabled !== false).length;
  steps.push({
    key: "operator",
    done: operators > 0,
    detail: operators > 0 ? `${operators} operator(s)` : "no operator (phis operator add)",
  });
  steps.push(sites);
  return steps;
}

export async function readPhiSetupStatus(configRoot: string): Promise<{ window: PhiBootstrapWindow; steps: PhiSetupStep[] }> {
  const runtime = readPhiRuntimeConfigSync(configRoot);
  return { window: describePhiBootstrapWindow(runtime), steps: await readPhiSetupSteps(runtime) };
}

export function initPhiRuntimeKeys(configRoot: string): { created: PhiRuntimeKeyName[]; path: string } {
  const runtime = readPhiRuntimeConfigSync(configRoot);
  const { config, created } = fillPhiRuntimeKeys(runtime);
  if (created.length > 0) {
    writePhiRuntimeConfigSync(config, configRoot);
  }
  return { created, path: resolvePhiConfigPaths(configRoot).runtime };
}

export function formatPhiDuration(ms: number) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}
