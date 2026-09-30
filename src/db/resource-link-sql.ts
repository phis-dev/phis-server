/**
 * The joins that reach a resource link's thread, whichever of the three things it is linked to.
 *
 * A link names a thread directly, a ticket that has one, or a task whose ticket has one; `link` must be
 * the alias of `phis.resource_links` in the query it is placed in, and it brings `ticket` and
 * `task_ticket` into scope. Four queries spelled the chain out, and the reach question -- which
 * threads a provider may see -- is only answered alike if they read the same one.
 */
export const PHIS_RESOURCE_LINK_THREAD_JOINS_SQL = `
  LEFT JOIN phis.support_tickets ticket
    ON ticket.id = link.ticket_id
  LEFT JOIN phis.support_ticket_tasks task
    ON task.id = link.ticket_task_id
  LEFT JOIN phis.support_tickets task_ticket
    ON task_ticket.id = task.ticket_id`;
