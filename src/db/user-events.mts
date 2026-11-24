import type { PoolClient } from "pg";

import type { PhisUserField } from "@phis/contracts/users";

import { PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED } from "../lib/constants/server-addons.ts";
import { newEntitlementSubjectReference } from "./entitlement-subject-reference.mts";

type DbQueryable = Pick<PoolClient, "query">;

/**
 * Owes `user.registered` or `user.changed` about one person (SERVER_ADDONS.md, users:v1).
 *
 * To the recipients named -- the caller's reading of the installed manifests: enabled, requiring
 * `users:v1` and declaring a handler for the event -- on the Sites named, or on every Site the person is a
 * member of, and there only where a recipient is enabled and configured. The event names the person by
 * their subject on that Site, issued here where they had none yet, since a handler can do nothing with a
 * user id; `user.changed` carries which fields changed and never a value. In the caller's transaction,
 * like every outbox row. Free of `server-only`, because `phis site admin` makes members too.
 *
 * Answers the Sites a row was written for, which the caller schedules a delivery for after its commit.
 */
export async function enqueuePhisUserEvent(
  db: DbQueryable,
  input: {
    userId: number;
    /** The Sites to announce it on; null for every Site the person is a member of. */
    siteIds: readonly number[] | null;
    event: "user.registered" | "user.changed";
    /** `user.changed` only: the groups of fields that changed, never empty. */
    fields?: readonly PhisUserField[];
    recipients: readonly string[];
  },
): Promise<number[]> {
  if (input.recipients.length === 0 || (input.event === "user.changed" && (input.fields ?? []).length === 0)) {
    return [];
  }
  const { rows: sites } = await db.query<{ site_id: number }>(
    `SELECT m.site_id
     FROM phis.user_site_memberships m
     WHERE m.user_id = $1
       AND ($2::smallint[] IS NULL OR m.site_id = ANY($2::smallint[]))
       AND EXISTS (
         SELECT 1 FROM phis.site_server_addons installed
         WHERE installed.site_id = m.site_id
           AND installed.addon_id = ANY($3::text[])
           AND (installed.flags & ${PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED}) <> 0
           AND installed.configuration_status = 'ready'
       )
     ORDER BY m.site_id`,
    [input.userId, input.siteIds, input.recipients],
  );
  const siteIds = sites.map((row) => row.site_id);
  if (siteIds.length === 0) {
    return [];
  }
  // The subject of the person on each of those Sites, issued as `ensureEntitlementSubject` issues one.
  await db.query(
    `INSERT INTO phis.entitlement_subjects (site_id, user_id, reference)
     SELECT site_id, $2::int, reference
     FROM unnest($1::smallint[], $3::text[]) AS issued(site_id, reference)
     ON CONFLICT (site_id, user_id) DO NOTHING`,
    [siteIds, input.userId, siteIds.map(() => newEntitlementSubjectReference())],
  );
  await db.query(
    `INSERT INTO phis.addon_event_outbox (site_id, addon_id, event, subject_kind, payload)
     SELECT s.site_id, installed.addon_id, $3::varchar, 'user',
            CASE WHEN $3::varchar = 'user.changed'
              THEN jsonb_build_object('subject', s.reference, 'fields', to_jsonb($5::text[]))
              ELSE jsonb_build_object('subject', s.reference) END
     FROM phis.entitlement_subjects s
     JOIN phis.site_server_addons installed
       ON installed.site_id = s.site_id
      AND installed.addon_id = ANY($4::text[])
      AND (installed.flags & ${PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED}) <> 0
      AND installed.configuration_status = 'ready'
     WHERE s.user_id = $1 AND s.site_id = ANY($2::smallint[])
     ORDER BY s.site_id, installed.addon_id`,
    [input.userId, siteIds, input.event, input.recipients, [...(input.fields ?? [])]],
  );
  return siteIds;
}
