import "server-only";

import { PHIS_ADDON_EVENT_MAX_HOPS } from "@phis/contracts/addon";

import type {
  PhisAddonEmittedEventDescriptor,
  PhisAddonEmittedEventId,
  PhisEventsCapabilityV1,
} from "./contract.ts";
import { schedulePhisAddonEventDelivery } from "./event-trigger.ts";
import { getPhisAddonInstalledManifest } from "./installed.ts";
import { enqueuePhisAddonEmittedEvent } from "@/db/addon-events";
import { getPool } from "@/lib/db";
import { logRuntimeEvent } from "@/lib/log";

/**
 * An Add-on saying that something happened (SERVER_ADDONS.md, Events).
 *
 * Emitting is a write to the outbox and nothing more. The listeners are read off the installed
 * manifests -- every enabled Add-on whose `eventHandlers` names this event -- and one row is written per
 * listener that is asked for and configured on this Site; Core then delivers them exactly as it delivers
 * its own events, after the fact, in order, retried. Nobody listening is answered with zero rows, not
 * with an error: the emitter said its piece, and whether anybody wanted to hear it is the Site's affair.
 *
 * The facts are bounded and are values, never references into another Add-on's tables, because a
 * listener runs with authority over its own tables only. The hop count is the incoming event's plus one
 * where the emit happens inside an event handler, and the emit is refused at the contract's ceiling,
 * which is what stops two handlers answering each other forever.
 */

const FACTS_MAX_BYTES = 16 * 1024;
const DEDUPE_KEY_MAX_LENGTH = 200;
const DEDUPE_KEY_PATTERN = /^[^\s\u0000-\u001f\u007f]+$/;

class PhisEventEmitError extends Error {}

function refuse(message: string): never {
  throw new PhisEventEmitError(message);
}

function readFacts(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    refuse("facts must be an object.");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    refuse("facts must be plain JSON.");
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > FACTS_MAX_BYTES) {
    refuse(`facts must serialize to JSON of at most ${FACTS_MAX_BYTES} bytes.`);
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

/**
 * The Add-ons that declare a handler for this event, among those installed and enabled here.
 *
 * Read from the build manifests rather than the database because a declaration is a manifest fact; the
 * insert then narrows to the Sites that asked for each listener, which is the database's fact.
 */
export function listPhisAddonEventListeners(
  event: PhisAddonEmittedEventId,
  descriptor: PhisAddonEmittedEventDescriptor,
  emitter: string,
): string[] {
  const listeners: string[] = [];
  for (const [addonId, entry] of Object.entries(getPhisAddonInstalledManifest())) {
    if (!entry.enabled) continue;
    if (descriptor.audience === "self" && addonId !== emitter) continue;
    if ((entry.manifest.eventHandlers ?? []).some((handler) => handler.event === event)) {
      listeners.push(addonId);
    }
  }
  return listeners;
}

export function buildPhisAddonEventsCapability(input: {
  addonId: string;
  siteId: number;
  siteKey: string;
  declared: readonly PhisAddonEmittedEventDescriptor[];
  unauthenticated: boolean;
  /** The hop of the event being handled, where the emit happens inside an event handler; 0 elsewhere. */
  hop: number;
}): PhisEventsCapabilityV1 {
  const { addonId, siteId, siteKey, declared, unauthenticated, hop } = input;
  const byId = new Map(declared.map((event) => [event.id, event]));

  return Object.freeze({
    async emit(call) {
      if (unauthenticated) {
        refuse("An unverified hook may not emit an event.");
      }
      if (typeof call !== "object" || call === null) {
        refuse("emit takes an object.");
      }
      const descriptor = typeof call.event === "string" ? byId.get(call.event) : undefined;
      if (!descriptor) {
        refuse(`${addonId} declares no event "${String(call.event)}" under emits.`);
      }
      const facts = readFacts(call.facts);
      let dedupeKey: string | null = null;
      if (call.dedupeKey !== undefined) {
        if (
          typeof call.dedupeKey !== "string" ||
          call.dedupeKey.length === 0 ||
          call.dedupeKey.length > DEDUPE_KEY_MAX_LENGTH ||
          !DEDUPE_KEY_PATTERN.test(call.dedupeKey)
        ) {
          refuse(`dedupeKey must be 1 to ${DEDUPE_KEY_MAX_LENGTH} characters without whitespace or control characters.`);
        }
        dedupeKey = call.dedupeKey;
      }
      if (hop >= PHIS_ADDON_EVENT_MAX_HOPS) {
        logRuntimeEvent("warn", "addon.event.hop_limit", {
          message: `${addonId} emitted ${descriptor.id} at hop ${hop}, the limit; the event was not written.`,
          siteKey,
          pluginKey: addonId,
          meta: { event: descriptor.id, hop },
        });
        refuse(`An event may pass through at most ${PHIS_ADDON_EVENT_MAX_HOPS} handlers; this emit is the ${hop + 1}th.`);
      }

      const recipients = listPhisAddonEventListeners(descriptor.id, descriptor, addonId);
      const written = await enqueuePhisAddonEmittedEvent(getPool(), {
        siteId,
        emitter: addonId,
        event: descriptor.id,
        recipients,
        facts,
        dedupeKey,
        hop: hop + 1,
      });
      if (written > 0) {
        schedulePhisAddonEventDelivery(siteId);
      }
      return { recipients: written };
    },
  });
}
