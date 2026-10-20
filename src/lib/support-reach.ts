import "server-only";

import { PhiBaseRole } from "@phis/contracts/access";

import { PHI_CORE_ROLE_PROVIDER_ID } from "@/lib/authorization";

/*
 * Which tickets a Support reader reaches.
 *
 * The Support routes let a Supporter in at all; this says which tickets once they are in. A Supporter works
 * the queues they sit in -- their group is the queue's group -- and a ticket of another queue is not theirs
 * to read, move or answer: listing it beside their own only offered work they could not take. An Admin or
 * a Developer reaches every queue, as they reach every Staff member in a conversation. A ticket with no
 * queue is in triage, and triage is everybody's until somebody routes it.
 *
 * One rule for every route that names a ticket, so the listing and the ticket behind a row cannot disagree:
 * a ticket out of reach answers as one that does not exist.
 */
export type SupportTicketReach = { all: true } | { all: false; userId: number };

/** The reach of the reader a Support route was entered by. */
export function readSupportTicketReach(context: {
  session: { userId: number } | null;
  siteRole: { roleClaims: readonly { providerId: string; flags: number }[] } | null;
} | null): SupportTicketReach {
  const coreFlags = context?.siteRole?.roleClaims
    .find((claim) => claim.providerId === PHI_CORE_ROLE_PROVIDER_ID)?.flags ?? 0;
  const userId = context?.session?.userId ?? null;
  if ((coreFlags & (PhiBaseRole.Admin | PhiBaseRole.Developer)) !== 0 || userId == null) {
    return { all: true };
  }
  return { all: false, userId };
}

/**
 * The condition a ticket row `alias` meets within the reach, with the reader's id at `$userParam`; `null`
 * where the reach is everything and nothing needs saying.
 */
export function supportTicketReachSql(alias: string, userParam: string, reach: SupportTicketReach) {
  if (reach.all) return null;
  return `(${alias}.queue_id IS NULL OR EXISTS (
    SELECT 1
    FROM phis.support_queues reach_queue
    JOIN phis.site_groups reach_group ON reach_group.id = reach_queue.group_id
    JOIN phis.site_group_members reach_member
      ON reach_member.group_id = reach_queue.group_id
     AND reach_member.site_id = reach_queue.site_id
    WHERE reach_queue.id = ${alias}.queue_id
      AND reach_member.user_id = ${userParam}
      AND reach_group.retired_at IS NULL
      AND (reach_member.valid_until IS NULL OR reach_member.valid_until > NOW())
  ))`;
}
