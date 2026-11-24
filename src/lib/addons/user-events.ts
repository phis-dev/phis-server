import "server-only";

import type { PoolClient } from "pg";

import type { PhisUserField } from "@phis/contracts/users";

import { enqueuePhisUserEvent } from "@/db/user-events.mts";
import { listUserListenersOf } from "./commerce-listeners.ts";
import { schedulePhisAddonEventDelivery } from "./event-trigger.ts";
import { getPhisAddonInstalledManifest } from "./installed.ts";

/**
 * The user events as the server writes them (`user.registered`, `user.changed`; SERVER_ADDONS.md,
 * users:v1): the recipients read from the installed manifests, the rows written in the caller's
 * transaction by `enqueuePhisUserEvent`, the delivery scheduled by the caller after its commit.
 */

/** The enabled Add-ons that require `users:v1` and declare a handler for the event. */
export const listPhisUserListeners = (event: "user.registered" | "user.changed"): string[] =>
  listUserListenersOf(getPhisAddonInstalledManifest(), event);

/** Owes the event to its listeners; answers the Sites a row was written for. */
export async function announcePhisUserEvent(
  db: Pick<PoolClient, "query">,
  input: {
    userId: number;
    siteIds: readonly number[] | null;
    event: "user.registered" | "user.changed";
    fields?: readonly PhisUserField[];
  },
): Promise<number[]> {
  const recipients = listPhisUserListeners(input.event);
  return recipients.length === 0 ? [] : enqueuePhisUserEvent(db, { ...input, recipients });
}

/** The after-commit attempt for the Sites `announcePhisUserEvent` answered. */
export function schedulePhisUserEventDelivery(siteIds: readonly number[]) {
  for (const siteId of siteIds) {
    schedulePhisAddonEventDelivery(siteId);
  }
}
