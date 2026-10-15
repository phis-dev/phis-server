/**
 * How this server records what happened to a ticket: `support_ticket_events.event_type`.
 *
 * The numbers are the stored contract and never change. They are not in `@phis/contracts/support`
 * because no Site and no Add-on reads the event log; the ladder they record is the contract's.
 *
 * Kept free of `server-only` so `phis maintain` names the event it writes when a requester window runs
 * out, rather than writing a bare 9 into its SQL.
 */
export const SUPPORT_TICKET_EVENT_CREATED = 0;
export const SUPPORT_TICKET_EVENT_TRIAGED = 1;
export const SUPPORT_TICKET_EVENT_ASSIGNED = 2;
export const SUPPORT_TICKET_EVENT_REPLIED = 3;
export const SUPPORT_TICKET_EVENT_LINKED = 4;
export const SUPPORT_TICKET_EVENT_UNLINKED = 5;
export const SUPPORT_TICKET_EVENT_ESCALATED = 6;
export const SUPPORT_TICKET_EVENT_RESOLVED = 7;
export const SUPPORT_TICKET_EVENT_REOPENED = 8;
export const SUPPORT_TICKET_EVENT_CLOSED = 9;
export const SUPPORT_TICKET_EVENT_TASK_CREATED = 10;
export const SUPPORT_TICKET_EVENT_TASK_COMPLETED = 11;
export const SUPPORT_TICKET_EVENT_TASK_REOPENED = 12;

/** `support_ticket_tasks.type`: what kind of work a task is. */
export const SUPPORT_TICKET_TASK_TYPE_INTERNAL = 0;
export const SUPPORT_TICKET_TASK_TYPE_CUSTOMER_FOLLOWUP = 1;
export const SUPPORT_TICKET_TASK_TYPE_ENGINEERING = 2;
export const SUPPORT_TICKET_TASK_TYPE_QA = 3;
export const SUPPORT_TICKET_TASK_TYPE_DEPLOYMENT = 4;
export const SUPPORT_TICKET_TASK_TYPE_DOCUMENTATION = 5;

/** `support_ticket_tasks.status`. Done and canceled are both finished; the others are not. */
export const SUPPORT_TICKET_TASK_STATUS_OPEN = 0;
export const SUPPORT_TICKET_TASK_STATUS_IN_PROGRESS = 1;
export const SUPPORT_TICKET_TASK_STATUS_BLOCKED = 2;
export const SUPPORT_TICKET_TASK_STATUS_DONE = 3;
export const SUPPORT_TICKET_TASK_STATUS_CANCELED = 4;
