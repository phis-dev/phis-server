import {
  PHIS_SUPPORT_REQUESTER_WINDOW_DEFAULT_DAYS,
  PhisSupportTicketFlag,
  PhisSupportTicketStatus,
} from "@phis/contracts/support";

/**
 * When a resolved ticket's requester window ends, as SQL over a ticket aliased `ticket`.
 *
 * The window belongs to the moment it ends rather than to whoever notices: a ticket resolved fifteen days
 * ago on a fourteen-day window has been closed for a day, whether or not anybody has touched it since.
 * So every reader derives that from the same expression, every writer that locks the ticket records it
 * before doing anything else, and `phis maintain` writes it down for tickets nobody touches again -- the
 * three must agree, which is why there is one spelling of it.
 *
 * `NULL` where no window runs: the ticket is not resolved, has no requester to wait for, its fix is not
 * delivered yet (`AwaitingDelivery`), or it waits for a Supporter because its type -- or its whole Site --
 * is at `0`. Once delivered, the window counts from `delivered_at` rather than from the resolution. A Site at `0` switches automatic closing
 * off for every type at once, rather than by setting each one; a rule spread over the catalogue is one
 * the next new type would quietly escape.
 *
 * Free of `server-only` because the maintenance task in the CLI reads it too.
 */
export function supportTicketWindowEndSql(ticket: string) {
  const days = `(
    SELECT CASE
             WHEN COALESCE(config.requester_window_days, ${PHIS_SUPPORT_REQUESTER_WINDOW_DEFAULT_DAYS}) = 0 THEN 0
             ELSE COALESCE(type.requester_window_days, config.requester_window_days,
                           ${PHIS_SUPPORT_REQUESTER_WINDOW_DEFAULT_DAYS})
           END
      FROM phis.support_ticket_types type
      LEFT JOIN phis.site_thread_config config ON config.site_id = type.site_id
     WHERE type.id = ${ticket}.type_id
  )`;
  return `(CASE
    WHEN ${ticket}.status = ${PhisSupportTicketStatus.Resolved}
     AND ${ticket}.requester_user_id IS NOT NULL
     AND ${ticket}.resolved_at IS NOT NULL
     AND (${ticket}.flags & ${PhisSupportTicketFlag.AwaitingDelivery}) = 0
     AND ${days} > 0
    THEN COALESCE(${ticket}.delivered_at, ${ticket}.resolved_at) + make_interval(days => ${days})
  END)`;
}

/** Whether the window of the ticket aliased `ticket` has run out. */
export function supportTicketWindowPassedSql(ticket: string) {
  return `(${supportTicketWindowEndSql(ticket)} <= NOW())`;
}

/** The ticket's status as it stands now: closed once its window has run out, whatever is stored. */
export function settledSupportTicketStatusSql(ticket: string) {
  return `(CASE WHEN ${supportTicketWindowPassedSql(ticket)} THEN ${PhisSupportTicketStatus.Closed} ELSE ${ticket}.status END)`;
}

/**
 * The ticket's status and close time as they stand now, as `settled_status` and `settled_closed_at`.
 *
 * What a reader selects beside the stored two, so a ticket whose window ran out reads as closed -- at
 * the moment the window ended -- without the read writing anything.
 */
export function settledSupportTicketColumnsSql(ticket: string) {
  return `${settledSupportTicketStatusSql(ticket)} AS settled_status,
    (CASE WHEN ${supportTicketWindowPassedSql(ticket)} THEN ${supportTicketWindowEndSql(ticket)}
          ELSE ${ticket}.closed_at END) AS settled_closed_at`;
}
