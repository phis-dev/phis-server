import "server-only";

import { randomUUID } from "node:crypto";

import type { PhisAddonCommandContext } from "./contract.ts";
import { buildPhisAddonCapabilities } from "./capabilities.ts";
import { isPhisAddonRuntimeManifestCurrent } from "./installed.ts";
import { requirePhisAddonServableEntry } from "./jobs.ts";
import { verifyPhisAddonRegistryState } from "./registry-state.ts";
import { getPhisConfigSync } from "@/lib/config";
import { resolvePhiSiteSourceLocale } from "@/lib/config-core";

/**
 * Running one of an Add-on's declared commands, for one Site, as one of its members.
 *
 * The shell's counterpart of a `site-user` route (SERVER_ADDONS.md, Commands). The operator names the
 * person with `--as`, and everything below is bound to them as a request of theirs would be: the roles
 * capability answers for them, the guarded queries refuse what they may not do, and what they write
 * carries them as its author. Who that person may be is decided by the caller, which is the internal
 * route and therefore the operator -- never a request, which could otherwise act as somebody else.
 */

export type PhisAddonCommandOutcome =
  | { ok: true; runId: string; result: unknown }
  | { ok: false; runId: string; error: string };

/** A command that was refused before it ran: not installed, not declared, not ready. The caller's mistake. */
export class PhisAddonCommandError extends Error {}

/** How long a command may take. A bulk change is the Add-on's loop, and one bounded run is still one. */
const PHIS_ADDON_COMMAND_TIMEOUT_MS = 120_000;

export async function runPhisAddonCommand(input: {
  addonId: string;
  commandId: string;
  /** The Site as the caller read it; its source language is Core's configuration's, read here. */
  site: Omit<PhisAddonCommandContext["site"], "sourceLocale">;
  actorUserId: number;
  input: unknown;
  signal?: AbortSignal;
}): Promise<PhisAddonCommandOutcome> {
  const { addonId, commandId, site } = input;
  const runId = randomUUID();
  const refuse = (message: string) => new PhisAddonCommandError(message);
  const entry = requirePhisAddonServableEntry(addonId, refuse);

  const descriptor = (entry.manifest.commands ?? []).find((command) => command.id === commandId);
  if (!descriptor) {
    throw refuse(`${addonId} declares no command named ${commandId}.`);
  }
  // The answer a request of this person's would be given: an Add-on the Site does not have answers as
  // absent, and a build whose migrations have not run does not get to write against the old schema.
  const registryState = await verifyPhisAddonRegistryState(entry, site.id);
  if (registryState === "hidden") {
    throw refuse(`${addonId} is not enabled for ${site.key}.`);
  }
  if (registryState !== "ready") {
    throw refuse(
      `${addonId} is not ready: the registry does not describe this build. ` +
      "Run `phis addon migrate` and `phis addon reconcile` first.",
    );
  }

  const runtime = (await entry.load()).phisAddon;
  if (!isPhisAddonRuntimeManifestCurrent(entry, runtime)) {
    throw refuse(`${addonId} is loaded in a build other than the installed one; restart the server.`);
  }
  const handler = runtime.commandHandlers?.[descriptor.handler];
  if (typeof handler !== "function") {
    throw refuse(`${addonId} exports no command handler named ${descriptor.handler}.`);
  }

  const signal = AbortSignal.any([
    ...(input.signal ? [input.signal] : []),
    AbortSignal.timeout(PHIS_ADDON_COMMAND_TIMEOUT_MS),
  ]);
  const context: PhisAddonCommandContext = {
    addonId,
    commandId,
    runId,
    site: { ...site, sourceLocale: resolvePhiSiteSourceLocale(getPhisConfigSync(), site.key) },
    actor: { kind: "user", id: input.actorUserId },
    input: input.input,
    capabilities: buildPhisAddonCapabilities({
      manifest: entry.manifest,
      manifestDigest: entry.manifestDigest,
      siteId: site.id,
      siteKey: site.key,
      actorUserId: input.actorUserId,
      // The authority a request of this person's carries, so a refund from the shell is theirs as in the browser.
      paymentAuthority: { kind: "request", operator: false, actorUserId: input.actorUserId },
      signal,
    }),
    signal,
  };

  try {
    const result = await handler(context);
    // What goes back is printed by the CLI, so it has to survive JSON; undefined says "nothing to show".
    return { ok: true, runId, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) };
  } catch (error) {
    return { ok: false, runId, error: error instanceof Error ? error.message : "The command failed." };
  }
}
