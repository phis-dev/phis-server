import "server-only";

import type { PhisAddonEventContext, PhisAddonEventId, PhisAddonManifestV1 } from "./contract.ts";
import { buildPhisAddonCapabilities } from "./capabilities.ts";
import { isPhisAddonCapabilityDeliverable } from "./core-capabilities.ts";
import { getPhisAddonInstalledManifest } from "./installed.ts";
import { digestPhisAddonManifest, validatePhisAddonManifest } from "./manifest.ts";
import { verifyPhisAddonRegistryState } from "./registry-state.ts";
import {
  listPendingPhisAddonEvents,
  listPhisAddonEventAddonIds,
  markPhisAddonEventDelivered,
  markPhisAddonEventFailed,
  type PhisAddonEventRow,
} from "@/db/addon-events";
import { getSiteIdentityById } from "@/db/sites";
import { logRuntimeEvent } from "@/lib/log";

/**
 * Handing an Add-on what Core owes it.
 *
 * The outbox is written with the change and drained here, after it. Two things drain it: the request
 * that caused the row, which tries once and does not report failure to the person who was only writing
 * a message, and `phis addon job run`, which is what eventually gets it there. That division is the
 * same one the job runner already states -- Core keeps no scheduler, and an operator's own scheduler is
 * the thing that runs on a clock.
 *
 * A handler runs with no actor and system authority over its own tables, exactly as a job does. It is
 * Core telling the Add-on about a thread the Add-on is already allowed to reach, so there is nobody
 * whose ladder would apply.
 */

const EVENT_TIMEOUT_MS = 15_000;
const EVENT_BATCH_SIZE = 200;

async function readSite(siteId: number) {
  return getSiteIdentityById(siteId);
}

async function invokeEventHandler(input: {
  addonId: string;
  event: PhisAddonEventId;
  row: PhisAddonEventRow;
  site: { id: number; key: string };
  handler: (context: PhisAddonEventContext) => Promise<void> | void;
  manifest: PhisAddonManifestV1;
  manifestDigest: string;
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EVENT_TIMEOUT_MS);
  try {
    const common = { addonId: input.addonId, deliveryId: input.row.id, site: input.site,
      capabilities: buildPhisAddonCapabilities({ manifest: input.manifest, manifestDigest: input.manifestDigest,
        siteId: input.site.id, siteKey: input.site.key, actorUserId: null, systemAuthority: true,
        paymentAuthority: { kind: "event", id: input.event }, signal: controller.signal,
      }), signal: controller.signal };
    if (input.event === "payment.changed") {
      if (input.row.subjectKind !== "payment" || !input.row.paymentId
        || typeof input.row.payload.reference !== "string" || !Number.isInteger(input.row.payload.version)) throw new Error("Invalid Payment outbox subject.");
      await input.handler({ ...common, event: input.event, subject: {
        kind: "payment", paymentId: input.row.paymentId, reference: input.row.payload.reference,
        version: input.row.payload.version as number,
        operationId: typeof input.row.payload.operationId === "string" ? input.row.payload.operationId : null,
        refundId: typeof input.row.payload.refundId === "string" ? input.row.payload.refundId : null,
      } });
    } else {
      if (input.row.subjectKind !== "thread" || input.row.threadId === null) throw new Error("Invalid thread outbox subject.");
      await input.handler({ ...common, event: input.event, subject: {
        kind: "thread", threadId: input.row.threadId,
        messageId: typeof input.row.payload.messageId === "number" ? input.row.payload.messageId : null,
      } });
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Delivers what one Add-on is owed on one Site.
 *
 * Strictly in order, and it stops at the first failure. Events about one thread are a sequence -- a
 * message, then a status, then the link going away -- and delivering the later ones while an earlier
 * one is still owed would leave the Add-on holding a state that never happened.
 */
export async function deliverPhisAddonEvents(input: {
  addonId: string;
  siteId: number;
}): Promise<{ delivered: number; failed: number }> {
  const { addonId, siteId } = input;
  const pending = await listPendingPhisAddonEvents({
    addonId,
    siteId,
    limit: EVENT_BATCH_SIZE,
  });
  if (pending.length === 0) {
    return { delivered: 0, failed: 0 };
  }

  const entry = getPhisAddonInstalledManifest()[addonId];
  if (!entry || !entry.enabled) {
    // Not installed here, or switched off. The rows stay owed: a release that is rolled forward again
    // should find its events, and a release rolled back should not silently lose them.
    return { delivered: 0, failed: pending.length };
  }
  const validation = validatePhisAddonManifest(entry.manifest);
  if (
    !validation.manifest ||
    digestPhisAddonManifest(validation.manifest) !== entry.manifestDigest ||
    entry.manifest.requiredCoreCapabilities.some(
      (capability) => !isPhisAddonCapabilityDeliverable(capability),
    )
  ) {
    return { delivered: 0, failed: pending.length };
  }
  // A build whose schema is not migrated yet, or that the registry does not describe, handles no event:
  // the rows stay owed, as they do for an Add-on switched off.
  if (await verifyPhisAddonRegistryState(entry, siteId) !== "ready") {
    return { delivered: 0, failed: pending.length };
  }

  const declared = new Map(
    (entry.manifest.eventHandlers ?? []).map((handler) => [handler.event, handler.handler]),
  );
  const site = await readSite(siteId);
  if (!site) {
    return { delivered: 0, failed: pending.length };
  }

  let runtime: Awaited<ReturnType<typeof entry.load>> | null = null;


  let delivered = 0;
  for (const row of pending) {
    const handlerName = declared.get(row.event);
    if (!handlerName) {
      /*
       * Enqueued for an Add-on that does not want this event.
       *
       * The outbox writes one row per synced link because a link is a database fact and a declaration
       * is a manifest one; filtering by the manifest inside the transaction that wrote the message
       * would have put the loaded build in the way of somebody's reply. So the row is closed here, with
       * no attempt, which is also what happens when an Add-on stops declaring an event it once wanted.
       */
      await markPhisAddonEventDelivered(row.id);
      continue;
    }

    try {
      runtime ??= await entry.load();
      const handler = runtime.phisAddon.eventHandlers?.[handlerName];
      if (typeof handler !== "function") {
        throw new Error(`${addonId} exports no event handler named ${handlerName}.`);
      }
      await invokeEventHandler({
        addonId,
        event: row.event,
        row,
        site,
        handler,
        manifest: entry.manifest,
        manifestDigest: entry.manifestDigest,
      });
      await markPhisAddonEventDelivered(row.id);
      delivered += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The event handler failed.";
      await markPhisAddonEventFailed(row.id, message);
      logRuntimeEvent("error", "addon.event.failed", {
        message,
        siteKey: site.key,
        pluginKey: addonId,
        meta: { event: row.event, threadId: row.threadId, attempts: row.attempts + 1 },
      });
      // In order means in order: what follows this row waits for the next run.
      return { delivered, failed: pending.length - delivered };
    }
  }

  return { delivered, failed: 0 };
}

/**
 * Drains everything owed on one Site, for every Add-on that is owed something.
 *
 * This is the after-commit attempt. It never throws and never reports: the person whose message caused
 * it was writing a message, not operating an integration, and a third party being unreachable is not
 * their failure to hear about. What it does not get through stays in the outbox.
 */
export async function drainPhisAddonEventsForSite(siteId: number) {
  try {
    const addonIds = await listPhisAddonEventAddonIds(siteId);
    for (const addonId of addonIds) {
      await deliverPhisAddonEvents({ addonId, siteId });
    }
  } catch (error) {
    logRuntimeEvent("error", "addon.event.drain_failed", {
      message: error instanceof Error ? error.message : "The event drain failed.",
      meta: { siteId },
    });
  }
}
