import "server-only";
import { PHI_CORE_ROLE_PROVIDER_ID } from "@/lib/authorization";

import type { PoolClient } from "pg";

import { getPool } from "@/lib/db";
import { USER_SITE_FLAG_DISABLED } from "@/lib/user-site-flags";

export const SUPPORT_TICKET_TYPE_QUESTION = 0;
export const SUPPORT_TICKET_TYPE_BUG = 1;
export const SUPPORT_TICKET_TYPE_INCIDENT = 2;
export const SUPPORT_TICKET_TYPE_BILLING = 3;
export const SUPPORT_TICKET_TYPE_ACCESS = 4;
export const SUPPORT_TICKET_TYPE_CONTENT = 5;
export const SUPPORT_TICKET_TYPE_INTEGRATION = 6;

export const SUPPORT_TICKET_STATUS_NEW = 0;
export const SUPPORT_TICKET_STATUS_TRIAGED = 1;
export const SUPPORT_TICKET_STATUS_ASSIGNED = 2;
export const SUPPORT_TICKET_STATUS_IN_PROGRESS = 3;
export const SUPPORT_TICKET_STATUS_WAITING_CUSTOMER = 4;
export const SUPPORT_TICKET_STATUS_WAITING_INTERNAL = 5;
export const SUPPORT_TICKET_STATUS_ESCALATED = 6;
export const SUPPORT_TICKET_STATUS_RESOLVED = 7;
export const SUPPORT_TICKET_STATUS_CLOSED = 8;

export const SUPPORT_TICKET_CHANNEL_PORTAL = 0;
export const SUPPORT_TICKET_CHANNEL_EMAIL = 1;
export const SUPPORT_TICKET_CHANNEL_GITHUB = 2;
export const SUPPORT_TICKET_CHANNEL_API = 3;
export const SUPPORT_TICKET_CHANNEL_INTERNAL = 4;

export const SUPPORT_TICKET_PRIORITY_LOW = 0;
export const SUPPORT_TICKET_PRIORITY_NORMAL = 1;
export const SUPPORT_TICKET_PRIORITY_HIGH = 2;
export const SUPPORT_TICKET_PRIORITY_URGENT = 3;

export const SUPPORT_TICKET_SEVERITY_MINOR = 0;
export const SUPPORT_TICKET_SEVERITY_MAJOR = 1;
export const SUPPORT_TICKET_SEVERITY_CRITICAL = 2;

export const SUPPORT_TICKET_MESSAGE_VISIBILITY_PUBLIC = 0;
export const SUPPORT_TICKET_MESSAGE_VISIBILITY_INTERNAL = 1;

export const SUPPORT_TICKET_MESSAGE_AUTHOR_REQUESTER = 0;
export const SUPPORT_TICKET_MESSAGE_AUTHOR_SUPPORTER = 1;
export const SUPPORT_TICKET_MESSAGE_AUTHOR_SYSTEM = 2;
export const SUPPORT_TICKET_MESSAGE_AUTHOR_INTEGRATION = 3;

export const SUPPORT_TICKET_TASK_TYPE_INTERNAL = 0;
export const SUPPORT_TICKET_TASK_TYPE_CUSTOMER_FOLLOWUP = 1;
export const SUPPORT_TICKET_TASK_TYPE_ENGINEERING = 2;
export const SUPPORT_TICKET_TASK_TYPE_QA = 3;
export const SUPPORT_TICKET_TASK_TYPE_DEPLOYMENT = 4;
export const SUPPORT_TICKET_TASK_TYPE_DOCUMENTATION = 5;

export const SUPPORT_TICKET_TASK_STATUS_OPEN = 0;
export const SUPPORT_TICKET_TASK_STATUS_IN_PROGRESS = 1;
export const SUPPORT_TICKET_TASK_STATUS_BLOCKED = 2;
export const SUPPORT_TICKET_TASK_STATUS_DONE = 3;
export const SUPPORT_TICKET_TASK_STATUS_CANCELED = 4;

export const SUPPORT_TICKET_LINK_SYSTEM_PHI = 0;
export const SUPPORT_TICKET_LINK_SYSTEM_MEDUSA = 1;
export const SUPPORT_TICKET_LINK_SYSTEM_GITHUB = 2;

export const SUPPORT_TICKET_LINK_TYPE_CMS_PAGE = 0;
export const SUPPORT_TICKET_LINK_TYPE_CMS_REVISION = 1;
export const SUPPORT_TICKET_LINK_TYPE_LOG_ENTRY = 2;
export const SUPPORT_TICKET_LINK_TYPE_DEPLOYMENT = 3;
export const SUPPORT_TICKET_LINK_TYPE_MEDUSA_ORDER = 10;
export const SUPPORT_TICKET_LINK_TYPE_MEDUSA_RETURN = 11;
export const SUPPORT_TICKET_LINK_TYPE_GITHUB_ISSUE = 20;
export const SUPPORT_TICKET_LINK_TYPE_GITHUB_PR = 21;

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

export const SUPPORT_GITHUB_SYNC_MODE_LINK_ONLY = 0;
export const SUPPORT_GITHUB_SYNC_MODE_OUTBOUND = 1;
export const SUPPORT_GITHUB_SYNC_MODE_BIDIRECTIONAL = 2;

export const SUPPORT_GITHUB_MAPPING_DIRECTION_OUTBOUND = 0;
export const SUPPORT_GITHUB_MAPPING_DIRECTION_INBOUND = 1;

export const SUPPORT_GITHUB_MAPPING_SYNC_STATE_ACTIVE = 0;
export const SUPPORT_GITHUB_MAPPING_SYNC_STATE_MUTED = 1;
export const SUPPORT_GITHUB_MAPPING_SYNC_STATE_FAILED = 2;

export const SUPPORT_THREAD_TYPE_DIRECT = 0;
export const SUPPORT_THREAD_TYPE_TEAM = 1;
export const SUPPORT_THREAD_TYPE_MIXED = 2;
export const SUPPORT_THREAD_TYPE_BROADCAST = 3;

export const SUPPORT_THREAD_STATUS_OPEN = 0;
export const SUPPORT_THREAD_STATUS_ARCHIVED = 1;

export const SUPPORT_THREAD_RECIPIENT_TYPE_USER = 0;
export const SUPPORT_THREAD_RECIPIENT_TYPE_TEAM = 1;

export const SUPPORT_DEFAULT_TEAM_KEY_L1 = "support_l1";
export const SUPPORT_DEFAULT_TEAM_KEY_L2 = "support_l2";
export const SUPPORT_DEFAULT_TEAM_KEY_DEV = "dev";
export const SUPPORT_DEFAULT_TEAM_KEY_BILLING = "billing";

type DbQueryable = Pick<PoolClient, "query">;

type SupportTicketListRow = {
  id: number;
  type: number;
  status: number;
  channel: number;
  priority: number;
  severity: number | null;
  flags: number;
  requester_user_id: number | null;
  requester_email: string | null;
  assignee_user_id: number | null;
  assignee_email: string | null;
  team_id: number | null;
  team_name: string | null;
  subject: string;
  summary: string | null;
  meta: Record<string, unknown> | null;
  first_response_due_at: string | null;
  resolution_due_at: string | null;
  last_public_message_at: string | null;
  last_internal_message_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  created_by_user_id: number | null;
  updated_by_user_id: number | null;
  created_at: string;
  updated_at: string;
  total_count?: number;
};

type SupportTicketMessageRow = {
  id: number;
  ticket_id: number;
  channel: number;
  visibility: number;
  author_type: number;
  flags: number;
  author_user_id: number | null;
  author_email: string | null;
  external_message_ref: string | null;
  body_text: string;
  body_markdown: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type SupportTicketTaskRow = {
  id: number;
  ticket_id: number;
  type: number;
  status: number;
  flags: number;
  sort_order: number;
  assignee_user_id: number | null;
  assignee_email: string | null;
  title: string;
  description: string | null;
  meta: Record<string, unknown> | null;
  due_at: string | null;
  completed_at: string | null;
  created_by_user_id: number | null;
  updated_by_user_id: number | null;
  created_at: string;
  updated_at: string;
};

type SupportTicketLinkRow = {
  id: number;
  ticket_id: number;
  system: number;
  type: number;
  state: number | null;
  flags: number;
  external_id: string;
  external_key: string | null;
  external_url: string | null;
  meta: Record<string, unknown> | null;
  created_by_user_id: number | null;
  created_at: string;
};

type SupportTicketEventInsertPayload = Record<string, unknown>;

type SupportTeamRow = {
  id: number;
  site_id: number;
  key: string;
  name: string;
  flags: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

type SupportTeamMemberRow = {
  team_id: number;
  user_id: number;
  flags: number;
  created_at: string;
  email_normalized: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  core_role_flags: number;
  user_site_flags: number;
};

type SupportThreadListRow = {
  id: number;
  site_id: number;
  ticket_id: number | null;
  type: number;
  status: number;
  subject: string | null;
  flags: number;
  created_by_user_id: number | null;
  created_at: string;
  updated_at: string;
  latest_message_id: number | null;
  latest_message_body_text: string | null;
  latest_message_created_at: string | null;
  latest_message_author_user_id: number | null;
  latest_message_author_email: string | null;
  latest_message_author_display_name: string | null;
  latest_message_author_company_name: string | null;
  last_read_message_id: number | null;
  total_count?: number;
};

type SupportThreadMessageRow = {
  id: number;
  thread_id: number;
  author_user_id: number | null;
  author_email: string | null;
  author_display_name: string | null;
  author_company_name: string | null;
  body_text: string;
  body_markdown: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type SupportThreadRecipientRow = {
  id: number;
  thread_id: number;
  recipient_type: number;
  user_id: number | null;
  team_id: number | null;
  flags: number;
  created_at: string;
  user_email: string | null;
  user_display_name: string | null;
  user_company_name: string | null;
  team_key: string | null;
  team_name: string | null;
};

export type SupportTeamRecord = {
  id: number;
  siteId: number;
  key: string;
  name: string;
  flags: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type SupportTeamMemberRecord = {
  teamId: number;
  userId: number;
  flags: number;
  createdAt: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  displayName: string;
  coreRoleFlags: number;
  siteFlags: number;
};

export type SupportThreadRecord = {
  id: number;
  siteId: number;
  ticketId: number | null;
  type: number;
  status: number;
  subject: string | null;
  flags: number;
  createdByUserId: number | null;
  createdAt: string;
  updatedAt: string;
  latestMessageId: number | null;
  latestMessageBodyText: string | null;
  latestMessageCreatedAt: string | null;
  latestMessageAuthorUserId: number | null;
  latestMessageAuthorEmail: string | null;
  latestMessageAuthorDisplayName: string | null;
  latestMessageAuthorCompanyName: string | null;
  lastReadMessageId: number | null;
  unread: boolean;
};

export type SupportThreadMessageRecord = {
  id: number;
  threadId: number;
  authorUserId: number | null;
  authorEmail: string | null;
  authorDisplayName: string | null;
  authorCompanyName: string | null;
  bodyText: string;
  bodyMarkdown: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type SupportThreadRecipientRecord = {
  id: number;
  threadId: number;
  recipientType: number;
  userId: number | null;
  teamId: number | null;
  flags: number;
  createdAt: string;
  userEmail: string | null;
  userDisplayName: string | null;
  userCompanyName: string | null;
  teamKey: string | null;
  teamName: string | null;
};

export type SupportThreadDetailRecord = {
  thread: SupportThreadRecord;
  messages: SupportThreadMessageRecord[];
  recipients: SupportThreadRecipientRecord[];
};

export type SupportInboxSummary = {
  unreadCount: number;
  hasUnread: boolean;
  latestThreadAt: string | null;
};

export type SupportRecipientUserRecord = {
  id: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  displayName: string;
  coreRoleFlags: number;
};

export type SupportTicketRecord = {
  id: number;
  type: number;
  status: number;
  channel: number;
  priority: number;
  severity: number | null;
  flags: number;
  requesterUserId: number | null;
  requesterEmail: string | null;
  assigneeUserId: number | null;
  assigneeEmail: string | null;
  teamId: number | null;
  teamName: string | null;
  subject: string;
  summary: string | null;
  meta: Record<string, unknown>;
  firstResponseDueAt: string | null;
  resolutionDueAt: string | null;
  lastPublicMessageAt: string | null;
  lastInternalMessageAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  createdByUserId: number | null;
  updatedByUserId: number | null;
  createdAt: string;
  updatedAt: string;
};

export type SupportTicketMessageRecord = {
  id: number;
  ticketId: number;
  channel: number;
  visibility: number;
  authorType: number;
  flags: number;
  authorUserId: number | null;
  authorEmail: string | null;
  externalMessageRef: string | null;
  bodyText: string;
  bodyMarkdown: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type SupportTicketTaskRecord = {
  id: number;
  ticketId: number;
  type: number;
  status: number;
  flags: number;
  sortOrder: number;
  assigneeUserId: number | null;
  assigneeEmail: string | null;
  title: string;
  description: string | null;
  meta: Record<string, unknown>;
  dueAt: string | null;
  completedAt: string | null;
  createdByUserId: number | null;
  updatedByUserId: number | null;
  createdAt: string;
  updatedAt: string;
};

export type SupportTicketLinkRecord = {
  id: number;
  ticketId: number;
  system: number;
  type: number;
  state: number | null;
  flags: number;
  externalId: string;
  externalKey: string | null;
  externalUrl: string | null;
  meta: Record<string, unknown>;
  createdByUserId: number | null;
  createdAt: string;
};

export type SupportTicketDetailRecord = {
  ticket: SupportTicketRecord;
  messages: SupportTicketMessageRecord[];
  tasks: SupportTicketTaskRecord[];
  links: SupportTicketLinkRecord[];
};

export type CreateSupportTeamInput = {
  siteId: number;
  key: string;
  name: string;
  flags?: number;
  sortOrder?: number;
};

export type UpdateSupportTeamInput = {
  siteId: number;
  teamId: number;
  key?: string;
  name?: string;
  flags?: number;
  sortOrder?: number;
};

export type UpsertSupportTeamMemberInput = {
  siteId: number;
  teamId: number;
  userId: number;
  flags?: number;
};

export type ListSupportThreadsOptions = {
  ticketId?: number | null;
  type?: number | null;
  unreadOnly?: boolean;
  page?: number;
  pageSize?: number;
};

export type ListSupportTicketsOptions = {
  search?: string;
  status?: number | null;
  channel?: number | null;
  assigneeUserId?: number | null;
  teamId?: number | null;
  page?: number;
  pageSize?: number;
};

export type CreateSupportTicketInput = {
  siteId: number;
  type: number;
  status?: number;
  channel: number;
  priority?: number;
  severity?: number | null;
  flags?: number;
  requesterUserId?: number | null;
  requesterEmail?: string | null;
  assigneeUserId?: number | null;
  teamId?: number | null;
  subject: string;
  summary?: string | null;
  meta?: Record<string, unknown>;
  firstResponseDueAt?: string | null;
  resolutionDueAt?: string | null;
  createdByUserId?: number | null;
};

export type UpdateSupportTicketInput = {
  siteId: number;
  ticketId: number;
  type?: number;
  status?: number;
  channel?: number;
  priority?: number;
  severity?: number | null;
  requesterUserId?: number | null;
  requesterEmail?: string | null;
  assigneeUserId?: number | null;
  teamId?: number | null;
  subject?: string;
  summary?: string | null;
  meta?: Record<string, unknown>;
  firstResponseDueAt?: string | null;
  resolutionDueAt?: string | null;
  resolvedAt?: string | null;
  closedAt?: string | null;
  updatedByUserId?: number | null;
};

export type AddSupportTicketMessageInput = {
  siteId: number;
  ticketId: number;
  channel: number;
  visibility: number;
  authorType: number;
  authorUserId?: number | null;
  externalMessageRef?: string | null;
  bodyText: string;
  bodyMarkdown?: string | null;
  meta?: Record<string, unknown>;
};

export type AddSupportTicketTaskInput = {
  siteId: number;
  ticketId: number;
  type?: number;
  status?: number;
  flags?: number;
  sortOrder?: number;
  assigneeUserId?: number | null;
  title: string;
  description?: string | null;
  meta?: Record<string, unknown>;
  dueAt?: string | null;
  completedAt?: string | null;
  createdByUserId?: number | null;
};

export type AddSupportTicketLinkInput = {
  siteId: number;
  ticketId: number;
  system: number;
  type: number;
  state?: number | null;
  flags?: number;
  externalId: string;
  externalKey?: string | null;
  externalUrl?: string | null;
  meta?: Record<string, unknown>;
  createdByUserId?: number | null;
};

export type UpdateSupportTicketTaskInput = {
  siteId: number;
  ticketId: number;
  taskId: number;
  type?: number;
  status?: number;
  flags?: number;
  sortOrder?: number;
  assigneeUserId?: number | null;
  title?: string;
  description?: string | null;
  meta?: Record<string, unknown>;
  dueAt?: string | null;
  completedAt?: string | null;
  updatedByUserId?: number | null;
};

export type UpdateSupportTicketLinkInput = {
  siteId: number;
  ticketId: number;
  linkId: number;
  system?: number;
  type?: number;
  state?: number | null;
  flags?: number;
  externalId?: string;
  externalKey?: string | null;
  externalUrl?: string | null;
  meta?: Record<string, unknown>;
  updatedByUserId?: number | null;
};

export type CreateSupportThreadInput = {
  siteId: number;
  ticketId?: number | null;
  type?: number;
  status?: number;
  subject?: string | null;
  flags?: number;
  recipientUserIds?: number[];
  recipientTeamIds?: number[];
  message: string;
  messageMarkdown?: string | null;
  messageMeta?: Record<string, unknown>;
  createdByUserId?: number | null;
};

export type AddSupportThreadMessageInput = {
  siteId: number;
  threadId: number;
  bodyText: string;
  bodyMarkdown?: string | null;
  meta?: Record<string, unknown>;
  authorUserId?: number | null;
};

export type SupportTicketAssignmentActionInput =
  | {
      siteId: number;
      ticketId: number;
      action: "assign_to_me";
      userId: number;
    }
  | {
      siteId: number;
      ticketId: number;
      action: "assign_to_user";
      userId: number;
      targetUserId: number;
    }
  | {
      siteId: number;
      ticketId: number;
      action: "unassign";
      userId: number;
    }
  | {
      siteId: number;
      ticketId: number;
      action: "move_to_team";
      userId: number;
      teamId: number;
    };

function toJsonRecord(value: Record<string, unknown> | null | undefined) {
  return value ?? {};
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function normalizeSearch(value?: string) {
  return value?.trim().toLowerCase() ?? "";
}

function mapSupportTicket(row: SupportTicketListRow): SupportTicketRecord {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    channel: row.channel,
    priority: row.priority,
    severity: row.severity,
    flags: row.flags,
    requesterUserId: row.requester_user_id,
    requesterEmail: row.requester_email,
    assigneeUserId: row.assignee_user_id,
    assigneeEmail: row.assignee_email,
    teamId: row.team_id,
    teamName: row.team_name,
    subject: row.subject,
    summary: row.summary,
    meta: toJsonRecord(row.meta),
    firstResponseDueAt: row.first_response_due_at,
    resolutionDueAt: row.resolution_due_at,
    lastPublicMessageAt: row.last_public_message_at,
    lastInternalMessageAt: row.last_internal_message_at,
    resolvedAt: row.resolved_at,
    closedAt: row.closed_at,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSupportTeam(row: SupportTeamRow): SupportTeamRecord {
  return {
    id: row.id,
    siteId: row.site_id,
    key: row.key,
    name: row.name,
    flags: row.flags,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSupportTeamMember(row: SupportTeamMemberRow): SupportTeamMemberRecord {
  const displayName = [row.first_name?.trim() ?? "", row.last_name?.trim() ?? ""]
    .filter(Boolean)
    .join(" ")
    .trim();

  return {
    teamId: row.team_id,
    userId: row.user_id,
    flags: row.flags,
    createdAt: row.created_at,
    email: row.email_normalized,
    firstName: row.first_name,
    lastName: row.last_name,
    companyName: row.company_name,
    displayName: displayName || row.email_normalized,
    coreRoleFlags: row.core_role_flags,
    siteFlags: row.user_site_flags,
  };
}

function mapSupportThread(row: SupportThreadListRow): SupportThreadRecord {
  return {
    id: row.id,
    siteId: row.site_id,
    ticketId: row.ticket_id,
    type: row.type,
    status: row.status,
    subject: row.subject,
    flags: row.flags,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    latestMessageId: row.latest_message_id,
    latestMessageBodyText: row.latest_message_body_text,
    latestMessageCreatedAt: row.latest_message_created_at,
    latestMessageAuthorUserId: row.latest_message_author_user_id,
    latestMessageAuthorEmail: row.latest_message_author_email,
    latestMessageAuthorDisplayName: row.latest_message_author_display_name,
    latestMessageAuthorCompanyName: row.latest_message_author_company_name,
    lastReadMessageId: row.last_read_message_id,
    unread:
      row.latest_message_id !== null &&
      row.latest_message_id > (row.last_read_message_id ?? 0),
  };
}

function mapSupportThreadMessage(row: SupportThreadMessageRow): SupportThreadMessageRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    authorUserId: row.author_user_id,
    authorEmail: row.author_email,
    authorDisplayName: row.author_display_name,
    authorCompanyName: row.author_company_name,
    bodyText: row.body_text,
    bodyMarkdown: row.body_markdown,
    meta: toJsonRecord(row.meta),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSupportThreadRecipient(row: SupportThreadRecipientRow): SupportThreadRecipientRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    recipientType: row.recipient_type,
    userId: row.user_id,
    teamId: row.team_id,
    flags: row.flags,
    createdAt: row.created_at,
    userEmail: row.user_email,
    userDisplayName: row.user_display_name,
    userCompanyName: row.user_company_name,
    teamKey: row.team_key,
    teamName: row.team_name,
  };
}

function mapSupportTicketMessage(row: SupportTicketMessageRow): SupportTicketMessageRecord {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    channel: row.channel,
    visibility: row.visibility,
    authorType: row.author_type,
    flags: row.flags,
    authorUserId: row.author_user_id,
    authorEmail: row.author_email,
    externalMessageRef: row.external_message_ref,
    bodyText: row.body_text,
    bodyMarkdown: row.body_markdown,
    meta: toJsonRecord(row.meta),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSupportTicketTask(row: SupportTicketTaskRow): SupportTicketTaskRecord {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    type: row.type,
    status: row.status,
    flags: row.flags,
    sortOrder: row.sort_order,
    assigneeUserId: row.assignee_user_id,
    assigneeEmail: row.assignee_email,
    title: row.title,
    description: row.description,
    meta: toJsonRecord(row.meta),
    dueAt: row.due_at,
    completedAt: row.completed_at,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSupportTicketLink(row: SupportTicketLinkRow): SupportTicketLinkRecord {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    system: row.system,
    type: row.type,
    state: row.state,
    flags: row.flags,
    externalId: row.external_id,
    externalKey: row.external_key,
    externalUrl: row.external_url,
    meta: toJsonRecord(row.meta),
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
  };
}

async function insertSupportTicketEvent(
  queryable: DbQueryable,
  input: {
    ticketId: number;
    eventType: number;
    createdByUserId?: number | null;
    payload?: SupportTicketEventInsertPayload;
  },
) {
  await queryable.query(
    `INSERT INTO phis.support_ticket_events (
       ticket_id,
       event_type,
       payload,
       created_by_user_id
     )
     VALUES ($1, $2, $3::jsonb, $4)`,
    [input.ticketId, input.eventType, JSON.stringify(input.payload ?? {}), input.createdByUserId ?? null],
  );
}

async function insertSupportTicketAssignment(
  queryable: DbQueryable,
  input: {
    ticketId: number;
    fromUserId?: number | null;
    toUserId?: number | null;
    fromTeamId?: number | null;
    toTeamId?: number | null;
    createdByUserId?: number | null;
    reason?: string | null;
  },
) {
  await queryable.query(
    `INSERT INTO phis.support_ticket_assignments (
       ticket_id,
       from_user_id,
       to_user_id,
       from_team_id,
       to_team_id,
       reason,
       created_by_user_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.ticketId,
      input.fromUserId ?? null,
      input.toUserId ?? null,
      input.fromTeamId ?? null,
      input.toTeamId ?? null,
      input.reason ?? null,
      input.createdByUserId ?? null,
    ],
  );
}

async function getSupportTicketRowById(queryable: DbQueryable, siteId: number, ticketId: number) {
  const { rows } = await queryable.query<SupportTicketListRow>(
    `SELECT
       t.*,
       assignee.email_normalized AS assignee_email,
       team.name AS team_name
     FROM phis.support_tickets t
     LEFT JOIN phis.user_account_directory assignee
       ON assignee.id = t.assignee_user_id
     LEFT JOIN phis.support_teams team
       ON team.id = t.team_id
     WHERE t.site_id = $1
       AND t.id = $2
     LIMIT 1`,
    [siteId, ticketId],
  );

  return rows[0] ?? null;
}

async function getSupportTicketTaskRowById(
  queryable: DbQueryable,
  siteId: number,
  ticketId: number,
  taskId: number,
) {
  const { rows } = await queryable.query<SupportTicketTaskRow>(
    `SELECT
       t.*,
       assignee.email_normalized AS assignee_email
     FROM phis.support_ticket_tasks t
     JOIN phis.support_tickets ticket
       ON ticket.id = t.ticket_id
     LEFT JOIN phis.user_account_directory assignee
       ON assignee.id = t.assignee_user_id
     WHERE ticket.site_id = $1
       AND t.ticket_id = $2
       AND t.id = $3
     LIMIT 1`,
    [siteId, ticketId, taskId],
  );

  return rows[0] ?? null;
}

async function getSupportTicketLinkRowById(
  queryable: DbQueryable,
  siteId: number,
  ticketId: number,
  linkId: number,
) {
  const { rows } = await queryable.query<SupportTicketLinkRow>(
    `SELECT l.*
     FROM phis.support_ticket_links l
     JOIN phis.support_tickets ticket
       ON ticket.id = l.ticket_id
     WHERE ticket.site_id = $1
       AND l.ticket_id = $2
       AND l.id = $3
     LIMIT 1`,
    [siteId, ticketId, linkId],
  );

  return rows[0] ?? null;
}

async function getSupportTeamMemberRowByIds(
  queryable: DbQueryable,
  siteId: number,
  teamId: number,
  userId: number,
) {
  const { rows } = await queryable.query<SupportTeamMemberRow>(
    `SELECT
       member.team_id,
       member.user_id,
       member.flags,
       member.created_at,
       account.email_normalized,
       profile.first_name,
       profile.last_name,
       profile.company_name,
       COALESCE(core_claim.role_flags, 0) AS core_role_flags,
       COALESCE(membership.user_site_flags, 0) AS user_site_flags
     FROM phis.support_team_members member
     JOIN phis.support_teams team
       ON team.id = member.team_id
     JOIN phis.user_account_directory account
       ON account.id = member.user_id
     LEFT JOIN phis.user_profiles profile
       ON profile.user_id = account.id
     LEFT JOIN phis.user_site_memberships membership
       ON membership.user_id = account.id
      AND membership.site_id = team.site_id
     LEFT JOIN phis.user_site_role_claims core_claim
       ON core_claim.user_id = account.id
      AND core_claim.site_id = team.site_id
      AND core_claim.provider_id = '${PHI_CORE_ROLE_PROVIDER_ID}'
     WHERE team.site_id = $1
       AND member.team_id = $2
       AND member.user_id = $3
     LIMIT 1`,
    [siteId, teamId, userId],
  );

  return rows[0] ?? null;
}

async function getAccessibleSupportThreadRowById(
  queryable: DbQueryable,
  siteId: number,
  userId: number,
  threadId: number,
) {
  const { rows } = await queryable.query<SupportThreadListRow>(
    `SELECT
       t.id,
       t.site_id,
       t.ticket_id,
       t.type,
       t.status,
       t.subject,
       t.flags,
       t.created_by_user_id,
       t.created_at,
       t.updated_at,
       latest.id AS latest_message_id,
       latest.body_text AS latest_message_body_text,
       latest.created_at AS latest_message_created_at,
       latest.author_user_id AS latest_message_author_user_id,
       latest.author_email AS latest_message_author_email,
       latest.author_display_name AS latest_message_author_display_name,
       latest.author_company_name AS latest_message_author_company_name,
       reads.last_read_message_id
     FROM phis.support_threads t
     LEFT JOIN LATERAL (
       SELECT
         m.id,
         m.body_text,
         m.created_at,
         m.author_user_id,
         author.email_normalized AS author_email,
         profile.first_name,
         profile.last_name,
         profile.company_name,
         COALESCE(NULLIF(TRIM(CONCAT_WS(' ', profile.first_name, profile.last_name)), ''), author.email_normalized) AS author_display_name,
         profile.company_name AS author_company_name
       FROM phis.support_thread_messages m
       LEFT JOIN phis.user_account_directory author
         ON author.id = m.author_user_id
       LEFT JOIN phis.user_profiles profile
         ON profile.user_id = author.id
       WHERE m.thread_id = t.id
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT 1
     ) latest ON true
     LEFT JOIN phis.support_thread_reads reads
       ON reads.thread_id = t.id
      AND reads.user_id = $2
     WHERE t.site_id = $1
       AND t.id = $3
       AND (
         t.created_by_user_id = $2
         OR EXISTS (
           SELECT 1
           FROM phis.support_thread_recipients recipient
           WHERE recipient.thread_id = t.id
             AND recipient.user_id = $2
         )
         OR EXISTS (
           SELECT 1
           FROM phis.support_thread_recipients recipient
           JOIN phis.support_team_members member
             ON member.team_id = recipient.team_id
           JOIN phis.support_teams team
             ON team.id = member.team_id
           WHERE recipient.thread_id = t.id
             AND member.user_id = $2
             AND team.site_id = $1
         )
       )
     LIMIT 1`,
    [siteId, userId, threadId],
  );

  return rows[0] ?? null;
}

async function listSupportThreadMessagesByThreadId(queryable: DbQueryable, threadId: number) {
  const { rows } = await queryable.query<SupportThreadMessageRow>(
    `SELECT
       message.*,
       author.email_normalized AS author_email,
       profile.first_name,
       profile.last_name,
       profile.company_name,
       COALESCE(NULLIF(TRIM(CONCAT_WS(' ', profile.first_name, profile.last_name)), ''), author.email_normalized) AS author_display_name,
       profile.company_name AS author_company_name
     FROM phis.support_thread_messages message
     LEFT JOIN phis.user_account_directory author
       ON author.id = message.author_user_id
     LEFT JOIN phis.user_profiles profile
       ON profile.user_id = author.id
     WHERE message.thread_id = $1
     ORDER BY message.created_at ASC, message.id ASC`,
    [threadId],
  );

  return rows.map(mapSupportThreadMessage);
}

async function listSupportThreadRecipientsByThreadId(queryable: DbQueryable, threadId: number) {
  const { rows } = await queryable.query<SupportThreadRecipientRow>(
    `SELECT
       recipient.id,
       recipient.thread_id,
       recipient.recipient_type,
       recipient.user_id,
       recipient.team_id,
       recipient.flags,
       recipient.created_at,
       account.email_normalized AS user_email,
       profile.first_name,
       profile.last_name,
       profile.company_name,
       COALESCE(NULLIF(TRIM(CONCAT_WS(' ', profile.first_name, profile.last_name)), ''), account.email_normalized) AS user_display_name,
       profile.company_name AS user_company_name,
       team.key AS team_key,
       team.name AS team_name
     FROM phis.support_thread_recipients recipient
     LEFT JOIN phis.user_account_directory account
       ON account.id = recipient.user_id
     LEFT JOIN phis.user_profiles profile
       ON profile.user_id = account.id
     LEFT JOIN phis.support_teams team
       ON team.id = recipient.team_id
     WHERE recipient.thread_id = $1
     ORDER BY recipient.id ASC`,
    [threadId],
  );

  return rows.map(mapSupportThreadRecipient);
}

async function listSupportTicketMessagesByTicketId(queryable: DbQueryable, ticketId: number) {
  const { rows } = await queryable.query<SupportTicketMessageRow>(
    `SELECT
       m.*,
       author.email_normalized AS author_email
     FROM phis.support_ticket_messages m
     LEFT JOIN phis.user_account_directory author
       ON author.id = m.author_user_id
     WHERE m.ticket_id = $1
     ORDER BY m.created_at ASC, m.id ASC`,
    [ticketId],
  );

  return rows.map(mapSupportTicketMessage);
}

async function listSupportTicketTasksByTicketId(queryable: DbQueryable, ticketId: number) {
  const { rows } = await queryable.query<SupportTicketTaskRow>(
    `SELECT
       t.*,
       assignee.email_normalized AS assignee_email
     FROM phis.support_ticket_tasks t
     LEFT JOIN phis.user_account_directory assignee
       ON assignee.id = t.assignee_user_id
     WHERE t.ticket_id = $1
     ORDER BY t.sort_order ASC, t.id ASC`,
    [ticketId],
  );

  return rows.map(mapSupportTicketTask);
}

async function listSupportTicketLinksByTicketId(queryable: DbQueryable, ticketId: number) {
  const { rows } = await queryable.query<SupportTicketLinkRow>(
    `SELECT *
     FROM phis.support_ticket_links
     WHERE ticket_id = $1
     ORDER BY created_at ASC, id ASC`,
    [ticketId],
  );

  return rows.map(mapSupportTicketLink);
}

export async function listSupportTicketsForSite(siteId: number, options: ListSupportTicketsOptions = {}) {
  const pool = getPool();
  const params: unknown[] = [siteId];
  const conditions: string[] = [`t.site_id = $1`];

  const search = normalizeSearch(options.search);
  if (search) {
    params.push(`%${escapeLike(search)}%`);
    const searchIndex = params.length;
    conditions.push(
      `(
        lower(t.subject) LIKE $${searchIndex} ESCAPE '\\'
        OR lower(COALESCE(t.summary, '')) LIKE $${searchIndex} ESCAPE '\\'
        OR lower(COALESCE(t.requester_email, '')) LIKE $${searchIndex} ESCAPE '\\'
      )`,
    );
  }

  if (Number.isInteger(options.status)) {
    params.push(options.status);
    conditions.push(`t.status = $${params.length}`);
  }

  if (Number.isInteger(options.channel)) {
    params.push(options.channel);
    conditions.push(`t.channel = $${params.length}`);
  }

  if (Number.isInteger(options.assigneeUserId)) {
    params.push(options.assigneeUserId);
    conditions.push(`t.assignee_user_id = $${params.length}`);
  }

  if (Number.isInteger(options.teamId)) {
    params.push(options.teamId);
    conditions.push(`t.team_id = $${params.length}`);
  }

  const pageSize = Math.max(1, Math.min(200, Math.trunc(options.pageSize ?? 25) || 25));
  const page = Math.max(1, Math.trunc(options.page ?? 1) || 1);
  const offset = (page - 1) * pageSize;
  params.push(pageSize, offset);

  const { rows } = await pool.query<SupportTicketListRow>(
    `WITH base AS (
       SELECT
         t.*,
         COUNT(*) OVER()::int AS total_count
       FROM phis.support_tickets t
       WHERE ${conditions.join(" AND ")}
     )
     SELECT
       base.*,
       assignee.email_normalized AS assignee_email,
       team.name AS team_name
     FROM base
     LEFT JOIN phis.user_account_directory assignee
       ON assignee.id = base.assignee_user_id
     LEFT JOIN phis.support_teams team
       ON team.id = base.team_id
     ORDER BY base.updated_at DESC, base.id DESC
     LIMIT $${params.length - 1}
     OFFSET $${params.length}`,
    params,
  );

  return {
    rows: rows.map(mapSupportTicket),
    total: rows[0]?.total_count ?? 0,
    page,
    pageSize,
  };
}

export async function listSupportTeams(siteId: number) {
  const pool = getPool();
  const { rows } = await pool.query<SupportTeamRow>(
    `SELECT id, site_id, key, name, flags, sort_order, created_at, updated_at
     FROM phis.support_teams
     WHERE site_id = $1
     ORDER BY sort_order ASC, id ASC`,
    [siteId],
  );

  return rows.map(mapSupportTeam);
}

export async function listSupportRecipientUsers(siteId: number) {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: number;
    email_normalized: string;
    first_name: string | null;
    last_name: string | null;
    company_name: string | null;
    core_role_flags: number;
  }>(
    `SELECT
       account.id,
       account.email_normalized,
       profile.first_name,
       profile.last_name,
       profile.company_name,
       COALESCE(core_claim.role_flags, 0) AS core_role_flags
     FROM phis.user_site_memberships membership
     JOIN phis.user_account_directory account
       ON account.id = membership.user_id
     LEFT JOIN phis.user_profiles profile
       ON profile.user_id = account.id
     LEFT JOIN phis.user_site_role_claims core_claim
       ON core_claim.user_id = account.id
      AND core_claim.site_id = membership.site_id
      AND core_claim.provider_id = '${PHI_CORE_ROLE_PROVIDER_ID}'
     WHERE membership.site_id = $1
       AND (COALESCE(membership.user_site_flags, 0) & $2) = 0
       AND EXISTS (
         SELECT 1
         FROM phis.user_site_role_claims claim
         WHERE claim.user_id = membership.user_id
           AND claim.site_id = membership.site_id
       )
     ORDER BY COALESCE(NULLIF(TRIM(CONCAT_WS(' ', profile.first_name, profile.last_name)), ''), account.email_normalized) ASC,
              account.id ASC`,
    [siteId, USER_SITE_FLAG_DISABLED],
  );

  return rows.map((row) => ({
    id: row.id,
    email: row.email_normalized,
    firstName: row.first_name,
    lastName: row.last_name,
    companyName: row.company_name,
    displayName:
      [row.first_name?.trim() ?? "", row.last_name?.trim() ?? ""].filter(Boolean).join(" ").trim() ||
      row.email_normalized,
    coreRoleFlags: row.core_role_flags,
  }));
}

export async function listSupportTeamMembers(siteId: number, teamId: number) {
  const pool = getPool();
  const { rows } = await pool.query<SupportTeamMemberRow>(
    `SELECT
       member.team_id,
       member.user_id,
       member.flags,
       member.created_at,
       account.email_normalized,
       profile.first_name,
       profile.last_name,
       profile.company_name,
       COALESCE(core_claim.role_flags, 0) AS core_role_flags,
       COALESCE(membership.user_site_flags, 0) AS user_site_flags
     FROM phis.support_team_members member
     JOIN phis.support_teams team
       ON team.id = member.team_id
     JOIN phis.user_account_directory account
       ON account.id = member.user_id
     LEFT JOIN phis.user_profiles profile
       ON profile.user_id = account.id
     LEFT JOIN phis.user_site_memberships membership
       ON membership.user_id = account.id
      AND membership.site_id = team.site_id
     LEFT JOIN phis.user_site_role_claims core_claim
       ON core_claim.user_id = account.id
      AND core_claim.site_id = team.site_id
      AND core_claim.provider_id = '${PHI_CORE_ROLE_PROVIDER_ID}'
     WHERE team.site_id = $1
       AND member.team_id = $2
     ORDER BY COALESCE(profile.first_name, ''), COALESCE(profile.last_name, ''), account.email_normalized`,
    [siteId, teamId],
  );

  return rows.map(mapSupportTeamMember);
}

export async function listSupportThreadsForUser(
  siteId: number,
  userId: number,
  options: ListSupportThreadsOptions = {},
) {
  const pool = getPool();
  const params: unknown[] = [siteId, userId];
  const conditions: string[] = [
    `t.site_id = $1`,
    `(
      t.created_by_user_id = $2
      OR EXISTS (
        SELECT 1
        FROM phis.support_thread_recipients recipient
        WHERE recipient.thread_id = t.id
          AND recipient.user_id = $2
      )
      OR EXISTS (
        SELECT 1
        FROM phis.support_thread_recipients recipient
        JOIN phis.support_team_members member
          ON member.team_id = recipient.team_id
        JOIN phis.support_teams team
          ON team.id = member.team_id
        WHERE recipient.thread_id = t.id
          AND member.user_id = $2
          AND team.site_id = $1
      )
    )`,
  ];

  if (Number.isInteger(options.ticketId) && (options.ticketId ?? 0) > 0) {
    params.push(options.ticketId);
    conditions.push(`t.ticket_id = $${params.length}`);
  }

  if (Number.isInteger(options.type)) {
    params.push(options.type);
    conditions.push(`t.type = $${params.length}`);
  }

  const pageSize = Math.max(1, Math.min(200, Math.trunc(options.pageSize ?? 25) || 25));
  const page = Math.max(1, Math.trunc(options.page ?? 1) || 1);
  const offset = (page - 1) * pageSize;
  params.push(pageSize, offset);

  const unreadCondition = options.unreadOnly
    ? `AND latest.id IS NOT NULL AND latest.id > COALESCE(reads.last_read_message_id, 0)`
    : "";

  const { rows } = await pool.query<SupportThreadListRow>(
    `WITH base AS (
       SELECT
         t.id,
         t.site_id,
         t.ticket_id,
         t.type,
         t.status,
         t.subject,
         t.flags,
         t.created_by_user_id,
         t.created_at,
         t.updated_at,
         latest.id AS latest_message_id,
         latest.body_text AS latest_message_body_text,
         latest.created_at AS latest_message_created_at,
         latest.author_user_id AS latest_message_author_user_id,
         latest.author_email AS latest_message_author_email,
         latest.author_display_name AS latest_message_author_display_name,
         latest.author_company_name AS latest_message_author_company_name,
         reads.last_read_message_id,
         COUNT(*) OVER()::int AS total_count
       FROM phis.support_threads t
       LEFT JOIN LATERAL (
         SELECT
           m.id,
           m.body_text,
           m.created_at,
           m.author_user_id,
           author.email_normalized AS author_email,
           profile.first_name,
           profile.last_name,
           profile.company_name,
           COALESCE(NULLIF(TRIM(CONCAT_WS(' ', profile.first_name, profile.last_name)), ''), author.email_normalized) AS author_display_name,
           profile.company_name AS author_company_name
         FROM phis.support_thread_messages m
         LEFT JOIN phis.user_account_directory author
           ON author.id = m.author_user_id
         LEFT JOIN phis.user_profiles profile
           ON profile.user_id = author.id
         WHERE m.thread_id = t.id
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT 1
       ) latest ON true
       LEFT JOIN phis.support_thread_reads reads
         ON reads.thread_id = t.id
        AND reads.user_id = $2
       WHERE ${conditions.join(" AND ")}
       ${unreadCondition}
     )
     SELECT *
     FROM base
     ORDER BY COALESCE(latest_message_created_at, updated_at) DESC, id DESC
     LIMIT $${params.length - 1}
     OFFSET $${params.length}`,
    params,
  );

  return {
    rows: rows.map(mapSupportThread),
    total: rows[0]?.total_count ?? 0,
    page,
    pageSize,
  };
}

export async function getSupportThreadDetail(siteId: number, userId: number, threadId: number) {
  const pool = getPool();
  const threadRow = await getAccessibleSupportThreadRowById(pool, siteId, userId, threadId);
  if (!threadRow) {
    return null;
  }

  const [messages, recipients] = await Promise.all([
    listSupportThreadMessagesByThreadId(pool, threadId),
    listSupportThreadRecipientsByThreadId(pool, threadId),
  ]);

  return {
    thread: mapSupportThread(threadRow),
    messages,
    recipients,
  } satisfies SupportThreadDetailRecord;
}

export async function createSupportTeam(input: CreateSupportTeamInput) {
  const pool = getPool();
  const { rows } = await pool.query<SupportTeamRow>(
    `INSERT INTO phis.support_teams (
       site_id,
       key,
       name,
       flags,
       sort_order
     )
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, site_id, key, name, flags, sort_order, created_at, updated_at`,
    [input.siteId, input.key, input.name, input.flags ?? 0, input.sortOrder ?? 0],
  );

  return rows[0] ? mapSupportTeam(rows[0]) : null;
}

export async function getSupportTeamBySiteAndId(siteId: number, teamId: number) {
  const pool = getPool();
  const { rows } = await pool.query<SupportTeamRow>(
    `SELECT id, site_id, key, name, flags, sort_order, created_at, updated_at
     FROM phis.support_teams
     WHERE site_id = $1
       AND id = $2
     LIMIT 1`,
    [siteId, teamId],
  );

  return rows[0] ? mapSupportTeam(rows[0]) : null;
}

export async function updateSupportTeam(input: UpdateSupportTeamInput) {
  const pool = getPool();
  const sets: string[] = [];
  const params: unknown[] = [input.siteId, input.teamId];
  const addSet = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (typeof input.key === "string") addSet("key", input.key);
  if (typeof input.name === "string") addSet("name", input.name);
  if (typeof input.flags === "number") addSet("flags", input.flags);
  if (typeof input.sortOrder === "number") addSet("sort_order", input.sortOrder);
  sets.push("updated_at = NOW()");

  if (sets.length === 1) {
    return getSupportTeamBySiteAndId(input.siteId, input.teamId);
  }

  const { rowCount } = await pool.query(
    `UPDATE phis.support_teams
     SET ${sets.join(", ")}
     WHERE site_id = $1
       AND id = $2`,
    params,
  );

  if (!rowCount) {
    return null;
  }

  return getSupportTeamBySiteAndId(input.siteId, input.teamId);
}

export async function deleteSupportTeamBySite(siteId: number, teamId: number) {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM phis.support_teams
     WHERE site_id = $1
       AND id = $2`,
    [siteId, teamId],
  );

  return (rowCount ?? 0) > 0;
}

export async function upsertSupportTeamMember(input: UpsertSupportTeamMemberInput) {
  const pool = getPool();
  const { rows } = await pool.query<{ team_id: number; user_id: number }>(
    `INSERT INTO phis.support_team_members (
       team_id,
       user_id,
       flags
     )
     SELECT
       team.id,
       account.id,
       $3
     FROM phis.support_teams team
     JOIN phis.user_site_memberships membership
       ON membership.user_id = $2
      AND membership.site_id = $1
     JOIN phis.user_accounts account
       ON account.id = membership.user_id
     WHERE team.site_id = $1
       AND team.id = $4
     ON CONFLICT (team_id, user_id) DO UPDATE
     SET flags = EXCLUDED.flags
     RETURNING team_id, user_id`,
    [input.siteId, input.userId, input.flags ?? 0, input.teamId],
  );

  if (!rows[0]) {
    return null;
  }

  const member = await getSupportTeamMemberRowByIds(pool, input.siteId, rows[0].team_id, rows[0].user_id);
  return member ? mapSupportTeamMember(member) : null;
}

async function filterExistingSupportRecipientUserIds(queryable: DbQueryable, siteId: number, userIds: number[]) {
  if (userIds.length === 0) {
    return [];
  }

  const { rows } = await queryable.query<{ id: number }>(
    `SELECT user_id AS id
     FROM phis.user_site_memberships
     WHERE site_id = $1
       AND user_id = ANY($2::int[])`,
    [siteId, userIds],
  );

  return rows.map((row) => row.id);
}

async function filterExistingSupportRecipientTeamIds(queryable: DbQueryable, siteId: number, teamIds: number[]) {
  if (teamIds.length === 0) {
    return [];
  }

  const { rows } = await queryable.query<{ id: number }>(
    `SELECT id
     FROM phis.support_teams
     WHERE site_id = $1
       AND id = ANY($2::smallint[])`,
    [siteId, teamIds],
  );

  return rows.map((row) => row.id);
}

function normalizeUniqueIds(values: number[] | undefined) {
  return Array.from(
    new Set((values ?? []).filter((value) => Number.isInteger(value) && value > 0)),
  );
}

function resolveSupportThreadType(userIds: number[], teamIds: number[]) {
  if (teamIds.length > 0 && userIds.length > 0) {
    return SUPPORT_THREAD_TYPE_MIXED;
  }
  if (teamIds.length > 0) {
    return SUPPORT_THREAD_TYPE_TEAM;
  }
  if (userIds.length === 1) {
    return SUPPORT_THREAD_TYPE_DIRECT;
  }
  return SUPPORT_THREAD_TYPE_BROADCAST;
}

export async function createSupportThread(input: CreateSupportThreadInput) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (input.ticketId) {
      const ticket = await getSupportTicketRowById(client, input.siteId, input.ticketId);
      if (!ticket) {
        await client.query("ROLLBACK");
        return null;
      }
    }

    const requestedUserIds = normalizeUniqueIds(input.recipientUserIds);
    const requestedTeamIds = normalizeUniqueIds(input.recipientTeamIds);
    const userIds = await filterExistingSupportRecipientUserIds(client, input.siteId, requestedUserIds);
    const teamIds = await filterExistingSupportRecipientTeamIds(client, input.siteId, requestedTeamIds);

    if (userIds.length !== requestedUserIds.length || teamIds.length !== requestedTeamIds.length) {
      throw new Error("One or more support thread recipients are invalid for the site.");
    }

    if (userIds.length === 0 && teamIds.length === 0) {
      throw new Error("At least one support thread recipient is required.");
    }

    const type = input.type ?? resolveSupportThreadType(userIds, teamIds);
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO phis.support_threads (
         site_id,
         ticket_id,
         type,
         status,
         subject,
         flags,
         created_by_user_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        input.siteId,
        input.ticketId ?? null,
        type,
        input.status ?? SUPPORT_THREAD_STATUS_OPEN,
        input.subject ?? null,
        input.flags ?? 0,
        input.createdByUserId ?? null,
      ],
    );

    const threadId = rows[0]?.id;
    if (!threadId) {
      throw new Error("Failed to create support thread.");
    }

    if (userIds.length > 0) {
      await client.query(
        `INSERT INTO phis.support_thread_recipients (thread_id, recipient_type, user_id)
         SELECT $1, $2, unnest($3::int[])`,
        [threadId, SUPPORT_THREAD_RECIPIENT_TYPE_USER, userIds],
      );
    }

    if (teamIds.length > 0) {
      await client.query(
        `INSERT INTO phis.support_thread_recipients (thread_id, recipient_type, team_id)
         SELECT $1, $2, unnest($3::int[])`,
        [threadId, SUPPORT_THREAD_RECIPIENT_TYPE_TEAM, teamIds],
      );
    }

    const messageRows = await client.query<{ id: number }>(
      `INSERT INTO phis.support_thread_messages (
         thread_id,
         author_user_id,
         body_text,
         body_markdown,
         meta
       )
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id`,
      [
        threadId,
        input.createdByUserId ?? null,
        input.message,
        input.messageMarkdown ?? null,
        JSON.stringify(input.messageMeta ?? {}),
      ],
    );

    if (input.createdByUserId) {
      await client.query(
        `INSERT INTO phis.support_thread_reads (
           thread_id,
           user_id,
           last_read_message_id,
           read_at
         )
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (thread_id, user_id) DO UPDATE
         SET last_read_message_id = EXCLUDED.last_read_message_id,
             read_at = EXCLUDED.read_at`,
        [threadId, input.createdByUserId, messageRows.rows[0]?.id ?? null],
      );
    }

    await client.query(
      `UPDATE phis.support_threads
       SET updated_at = NOW()
       WHERE id = $1`,
      [threadId],
    );

    await client.query("COMMIT");
    return getSupportThreadDetail(input.siteId, input.createdByUserId ?? 0, threadId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteSupportTeamMember(siteId: number, teamId: number, userId: number) {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM phis.support_team_members member
     USING phis.support_teams team
     WHERE member.team_id = team.id
       AND team.site_id = $1
       AND member.team_id = $2
       AND member.user_id = $3`,
    [siteId, teamId, userId],
  );

  return (rowCount ?? 0) > 0;
}

export async function isSupportTeamMember(siteId: number, teamId: number, userId: number) {
  const pool = getPool();
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM phis.support_team_members member
       JOIN phis.support_teams team
         ON team.id = member.team_id
       WHERE team.site_id = $1
         AND member.team_id = $2
         AND member.user_id = $3
     ) AS exists`,
    [siteId, teamId, userId],
  );

  return rows[0]?.exists ?? false;
}

export async function isSupportSiteUser(siteId: number, userId: number) {
  const pool = getPool();
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM phis.user_site_memberships
       WHERE user_id = $2
         AND site_id = $1
     ) AS exists`,
    [siteId, userId],
  );

  return rows[0]?.exists ?? false;
}

export async function addSupportThreadMessage(input: AddSupportThreadMessageInput) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const thread = await getAccessibleSupportThreadRowById(
      client,
      input.siteId,
      input.authorUserId ?? 0,
      input.threadId,
    );
    if (!thread) {
      await client.query("ROLLBACK");
      return null;
    }

    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO phis.support_thread_messages (
         thread_id,
         author_user_id,
         body_text,
         body_markdown,
         meta
       )
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id`,
      [
        input.threadId,
        input.authorUserId ?? null,
        input.bodyText,
        input.bodyMarkdown ?? null,
        JSON.stringify(input.meta ?? {}),
      ],
    );

    await client.query(
      `UPDATE phis.support_threads
       SET updated_at = NOW()
       WHERE id = $1`,
      [input.threadId],
    );

    if (input.authorUserId) {
      await client.query(
        `INSERT INTO phis.support_thread_reads (
           thread_id,
           user_id,
           last_read_message_id,
           read_at
         )
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (thread_id, user_id) DO UPDATE
         SET last_read_message_id = EXCLUDED.last_read_message_id,
             read_at = EXCLUDED.read_at`,
        [input.threadId, input.authorUserId, rows[0]?.id ?? null],
      );
    }

    await client.query("COMMIT");
    return getSupportThreadDetail(input.siteId, input.authorUserId ?? 0, input.threadId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markSupportThreadRead(siteId: number, userId: number, threadId: number, messageId?: number | null) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const thread = await getAccessibleSupportThreadRowById(client, siteId, userId, threadId);
    if (!thread) {
      await client.query("ROLLBACK");
      return null;
    }

    const readMessageId =
      Number.isInteger(messageId) && (messageId ?? 0) > 0
        ? (messageId as number)
        : thread.latest_message_id;

    await client.query(
      `INSERT INTO phis.support_thread_reads (
         thread_id,
         user_id,
         last_read_message_id,
         read_at
       )
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (thread_id, user_id) DO UPDATE
       SET last_read_message_id = EXCLUDED.last_read_message_id,
           read_at = EXCLUDED.read_at`,
      [threadId, userId, readMessageId ?? null],
    );

    await client.query("COMMIT");
    return getSupportThreadDetail(siteId, userId, threadId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function applySupportTicketAssignmentAction(input: SupportTicketAssignmentActionInput) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const existing = await getSupportTicketRowById(client, input.siteId, input.ticketId);
    if (!existing) {
      await client.query("ROLLBACK");
      return null;
    }

    if (input.action === "assign_to_me") {
      if (existing.team_id) {
        const member = await isSupportTeamMember(input.siteId, existing.team_id, input.userId);
        if (!member) {
          throw new Error("You must belong to the assigned team before claiming this ticket.");
        }
      }

      if (existing.assignee_user_id !== input.userId) {
        await client.query(
          `UPDATE phis.support_tickets
           SET assignee_user_id = $3,
               updated_by_user_id = $3,
               updated_at = NOW()
           WHERE site_id = $1
             AND id = $2`,
          [input.siteId, input.ticketId, input.userId],
        );

        await insertSupportTicketAssignment(client, {
          ticketId: input.ticketId,
          fromUserId: existing.assignee_user_id,
          toUserId: input.userId,
          fromTeamId: existing.team_id,
          toTeamId: existing.team_id,
          createdByUserId: input.userId,
          reason: "assign_to_me",
        });

        await insertSupportTicketEvent(client, {
          ticketId: input.ticketId,
          eventType: SUPPORT_TICKET_EVENT_ASSIGNED,
          createdByUserId: input.userId,
          payload: {
            action: "assign_to_me",
            fromUserId: existing.assignee_user_id,
            toUserId: input.userId,
            teamId: existing.team_id,
          },
        });
      }
    }

    if (input.action === "assign_to_user") {
      const targetUserExists = await isSupportSiteUser(input.siteId, input.targetUserId);
      if (!targetUserExists) {
        throw new Error("Target user is not available for this site.");
      }

      if (existing.team_id) {
        const member = await isSupportTeamMember(input.siteId, existing.team_id, input.targetUserId);
        if (!member) {
          throw new Error("Target user must belong to the assigned team.");
        }
      }

      if (existing.assignee_user_id !== input.targetUserId) {
        await client.query(
          `UPDATE phis.support_tickets
           SET assignee_user_id = $3,
               updated_by_user_id = $4,
               updated_at = NOW()
           WHERE site_id = $1
             AND id = $2`,
          [input.siteId, input.ticketId, input.targetUserId, input.userId],
        );

        await insertSupportTicketAssignment(client, {
          ticketId: input.ticketId,
          fromUserId: existing.assignee_user_id,
          toUserId: input.targetUserId,
          fromTeamId: existing.team_id,
          toTeamId: existing.team_id,
          createdByUserId: input.userId,
          reason: "assign_to_user",
        });

        await insertSupportTicketEvent(client, {
          ticketId: input.ticketId,
          eventType: SUPPORT_TICKET_EVENT_ASSIGNED,
          createdByUserId: input.userId,
          payload: {
            action: "assign_to_user",
            fromUserId: existing.assignee_user_id,
            toUserId: input.targetUserId,
            teamId: existing.team_id,
          },
        });
      }
    }

    if (input.action === "unassign") {
      if (existing.assignee_user_id !== null) {
        await client.query(
          `UPDATE phis.support_tickets
           SET assignee_user_id = NULL,
               updated_by_user_id = $3,
               updated_at = NOW()
           WHERE site_id = $1
             AND id = $2`,
          [input.siteId, input.ticketId, input.userId],
        );

        await insertSupportTicketAssignment(client, {
          ticketId: input.ticketId,
          fromUserId: existing.assignee_user_id,
          toUserId: null,
          fromTeamId: existing.team_id,
          toTeamId: existing.team_id,
          createdByUserId: input.userId,
          reason: "unassign",
        });

        await insertSupportTicketEvent(client, {
          ticketId: input.ticketId,
          eventType: SUPPORT_TICKET_EVENT_ASSIGNED,
          createdByUserId: input.userId,
          payload: {
            action: "unassign",
            fromUserId: existing.assignee_user_id,
            toUserId: null,
            teamId: existing.team_id,
          },
        });
      }
    }

    if (input.action === "move_to_team") {
      const targetTeam = await getSupportTeamBySiteAndId(input.siteId, input.teamId);
      if (!targetTeam) {
        throw new Error("Target team not found.");
      }

      if (existing.team_id !== input.teamId || existing.assignee_user_id !== null) {
        await client.query(
          `UPDATE phis.support_tickets
           SET team_id = $3,
               assignee_user_id = NULL,
               updated_by_user_id = $4,
               updated_at = NOW()
           WHERE site_id = $1
             AND id = $2`,
          [input.siteId, input.ticketId, input.teamId, input.userId],
        );

        await insertSupportTicketAssignment(client, {
          ticketId: input.ticketId,
          fromUserId: existing.assignee_user_id,
          toUserId: null,
          fromTeamId: existing.team_id,
          toTeamId: input.teamId,
          createdByUserId: input.userId,
          reason: "move_to_team",
        });

        await insertSupportTicketEvent(client, {
          ticketId: input.ticketId,
          eventType: SUPPORT_TICKET_EVENT_ASSIGNED,
          createdByUserId: input.userId,
          payload: {
            action: "move_to_team",
            fromUserId: existing.assignee_user_id,
            toUserId: null,
            fromTeamId: existing.team_id,
            toTeamId: input.teamId,
          },
        });
      }
    }

    await client.query("COMMIT");
    return getSupportTicketDetail(input.siteId, input.ticketId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getSupportTicketDetail(siteId: number, ticketId: number) {
  const pool = getPool();
  const ticketRow = await getSupportTicketRowById(pool, siteId, ticketId);
  if (!ticketRow) {
    return null;
  }

  const [messages, tasks, links] = await Promise.all([
    listSupportTicketMessagesByTicketId(pool, ticketId),
    listSupportTicketTasksByTicketId(pool, ticketId),
    listSupportTicketLinksByTicketId(pool, ticketId),
  ]);

  return {
    ticket: mapSupportTicket(ticketRow),
    messages,
    tasks,
    links,
  } satisfies SupportTicketDetailRecord;
}

export async function createSupportTicket(input: CreateSupportTicketInput) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const resolvedTeamId =
      input.teamId ??
      ((
        await client.query<{ id: number }>(
          `SELECT id
           FROM phis.support_teams
           WHERE site_id = $1
             AND key = $2
           LIMIT 1`,
          [input.siteId, SUPPORT_DEFAULT_TEAM_KEY_L1],
        )
      ).rows[0]?.id ?? null);

    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO phis.support_tickets (
         site_id,
         type,
         status,
         channel,
         priority,
         severity,
         flags,
         requester_user_id,
         requester_email,
         assignee_user_id,
         team_id,
         subject,
         summary,
         meta,
         first_response_due_at,
         resolution_due_at,
         created_by_user_id,
         updated_by_user_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17, $17)
       RETURNING id`,
      [
        input.siteId,
        input.type,
        input.status ?? SUPPORT_TICKET_STATUS_NEW,
        input.channel,
        input.priority ?? SUPPORT_TICKET_PRIORITY_NORMAL,
        input.severity ?? null,
        input.flags ?? 0,
        input.requesterUserId ?? null,
        input.requesterEmail ?? null,
        input.assigneeUserId ?? null,
        resolvedTeamId,
        input.subject,
        input.summary ?? null,
        JSON.stringify(input.meta ?? {}),
        input.firstResponseDueAt ?? null,
        input.resolutionDueAt ?? null,
        input.createdByUserId ?? null,
      ],
    );

    const ticketId = rows[0]?.id;
    if (!ticketId) {
      throw new Error("Failed to create support ticket.");
    }

    if (input.assigneeUserId || resolvedTeamId) {
      await insertSupportTicketAssignment(client, {
        ticketId,
        toUserId: input.assigneeUserId ?? null,
        toTeamId: resolvedTeamId,
        createdByUserId: input.createdByUserId ?? null,
        reason: "initial_assignment",
      });
    }

    await insertSupportTicketEvent(client, {
      ticketId,
      eventType: SUPPORT_TICKET_EVENT_CREATED,
      createdByUserId: input.createdByUserId ?? null,
      payload: {
        status: input.status ?? SUPPORT_TICKET_STATUS_NEW,
        assigneeUserId: input.assigneeUserId ?? null,
        teamId: resolvedTeamId,
      },
    });

    await client.query("COMMIT");
    return getSupportTicketDetail(input.siteId, ticketId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateSupportTicket(input: UpdateSupportTicketInput) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const existing = await getSupportTicketRowById(client, input.siteId, input.ticketId);
    if (!existing) {
      await client.query("ROLLBACK");
      return null;
    }

    const sets: string[] = [];
    const params: unknown[] = [input.siteId, input.ticketId];
    const addSet = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (typeof input.type === "number") addSet("type", input.type);
    if (typeof input.status === "number") addSet("status", input.status);
    if (typeof input.channel === "number") addSet("channel", input.channel);
    if (typeof input.priority === "number") addSet("priority", input.priority);
    if (input.severity !== undefined) addSet("severity", input.severity ?? null);
    if (input.requesterUserId !== undefined) addSet("requester_user_id", input.requesterUserId ?? null);
    if (input.requesterEmail !== undefined) addSet("requester_email", input.requesterEmail ?? null);
    if (input.assigneeUserId !== undefined) addSet("assignee_user_id", input.assigneeUserId ?? null);
    if (input.teamId !== undefined) addSet("team_id", input.teamId ?? null);
    if (typeof input.subject === "string") addSet("subject", input.subject);
    if (input.summary !== undefined) addSet("summary", input.summary ?? null);
    if (input.meta !== undefined) {
      params.push(JSON.stringify(input.meta ?? {}));
      sets.push(`meta = $${params.length}::jsonb`);
    }
    if (input.firstResponseDueAt !== undefined) addSet("first_response_due_at", input.firstResponseDueAt ?? null);
    if (input.resolutionDueAt !== undefined) addSet("resolution_due_at", input.resolutionDueAt ?? null);
    if (input.resolvedAt !== undefined) addSet("resolved_at", input.resolvedAt ?? null);
    if (input.closedAt !== undefined) addSet("closed_at", input.closedAt ?? null);
    addSet("updated_by_user_id", input.updatedByUserId ?? null);
    sets.push("updated_at = NOW()");

    await client.query(
      `UPDATE phis.support_tickets
       SET ${sets.join(", ")}
       WHERE site_id = $1
         AND id = $2`,
      params,
    );

    const assigneeChanged =
      (input.assigneeUserId !== undefined && (input.assigneeUserId ?? null) !== existing.assignee_user_id) ||
      (input.teamId !== undefined && (input.teamId ?? null) !== existing.team_id);
    if (assigneeChanged) {
      await insertSupportTicketAssignment(client, {
        ticketId: input.ticketId,
        fromUserId: existing.assignee_user_id,
        toUserId: input.assigneeUserId !== undefined ? (input.assigneeUserId ?? null) : existing.assignee_user_id,
        fromTeamId: existing.team_id,
        toTeamId: input.teamId !== undefined ? (input.teamId ?? null) : existing.team_id,
        createdByUserId: input.updatedByUserId ?? null,
        reason: "ticket_update",
      });
      await insertSupportTicketEvent(client, {
        ticketId: input.ticketId,
        eventType: SUPPORT_TICKET_EVENT_ASSIGNED,
        createdByUserId: input.updatedByUserId ?? null,
        payload: {
          fromUserId: existing.assignee_user_id,
          toUserId: input.assigneeUserId !== undefined ? (input.assigneeUserId ?? null) : existing.assignee_user_id,
          fromTeamId: existing.team_id,
          toTeamId: input.teamId !== undefined ? (input.teamId ?? null) : existing.team_id,
        },
      });
    }

    if (typeof input.status === "number" && input.status !== existing.status) {
      await insertSupportTicketEvent(client, {
        ticketId: input.ticketId,
        eventType:
          input.status === SUPPORT_TICKET_STATUS_RESOLVED
            ? SUPPORT_TICKET_EVENT_RESOLVED
            : input.status === SUPPORT_TICKET_STATUS_CLOSED
              ? SUPPORT_TICKET_EVENT_CLOSED
              : SUPPORT_TICKET_EVENT_TRIAGED,
        createdByUserId: input.updatedByUserId ?? null,
        payload: {
          fromStatus: existing.status,
          toStatus: input.status,
        },
      });
    }

    await client.query("COMMIT");
    return getSupportTicketDetail(input.siteId, input.ticketId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function addSupportTicketMessage(input: AddSupportTicketMessageInput) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const existing = await getSupportTicketRowById(client, input.siteId, input.ticketId);
    if (!existing) {
      await client.query("ROLLBACK");
      return null;
    }

    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO phis.support_ticket_messages (
         ticket_id,
         channel,
         visibility,
         author_type,
         flags,
         author_user_id,
         external_message_ref,
         body_text,
         body_markdown,
         meta
       )
       VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8, $9::jsonb)
       RETURNING id`,
      [
        input.ticketId,
        input.channel,
        input.visibility,
        input.authorType,
        input.authorUserId ?? null,
        input.externalMessageRef ?? null,
        input.bodyText,
        input.bodyMarkdown ?? null,
        JSON.stringify(input.meta ?? {}),
      ],
    );

    await client.query(
      `UPDATE phis.support_tickets
       SET ${input.visibility === SUPPORT_TICKET_MESSAGE_VISIBILITY_PUBLIC ? "last_public_message_at" : "last_internal_message_at"} = NOW(),
           updated_at = NOW(),
           updated_by_user_id = $3
       WHERE site_id = $1
         AND id = $2`,
      [input.siteId, input.ticketId, input.authorUserId ?? null],
    );

    await insertSupportTicketEvent(client, {
      ticketId: input.ticketId,
      eventType: SUPPORT_TICKET_EVENT_REPLIED,
      createdByUserId: input.authorUserId ?? null,
      payload: { visibility: input.visibility, messageId: rows[0]?.id ?? null },
    });

    await client.query("COMMIT");
    return getSupportTicketDetail(input.siteId, input.ticketId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function addSupportTicketTask(input: AddSupportTicketTaskInput) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const existing = await getSupportTicketRowById(client, input.siteId, input.ticketId);
    if (!existing) {
      await client.query("ROLLBACK");
      return null;
    }

    const nextSortOrder =
      typeof input.sortOrder === "number"
        ? input.sortOrder
        : (
            await client.query<{ next_sort_order: number }>(
              `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
               FROM phis.support_ticket_tasks
               WHERE ticket_id = $1`,
              [input.ticketId],
            )
          ).rows[0]?.next_sort_order ?? 0;

    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO phis.support_ticket_tasks (
         ticket_id,
         type,
         status,
         flags,
         sort_order,
         assignee_user_id,
         title,
         description,
         meta,
         due_at,
         completed_at,
         created_by_user_id,
         updated_by_user_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $12)
       RETURNING id`,
      [
        input.ticketId,
        input.type ?? SUPPORT_TICKET_TASK_TYPE_INTERNAL,
        input.status ?? SUPPORT_TICKET_TASK_STATUS_OPEN,
        input.flags ?? 0,
        nextSortOrder,
        input.assigneeUserId ?? null,
        input.title,
        input.description ?? null,
        JSON.stringify(input.meta ?? {}),
        input.dueAt ?? null,
        input.completedAt ?? null,
        input.createdByUserId ?? null,
      ],
    );

    await client.query(
      `UPDATE phis.support_tickets
       SET updated_at = NOW(),
           updated_by_user_id = $3
       WHERE site_id = $1
         AND id = $2`,
      [input.siteId, input.ticketId, input.createdByUserId ?? null],
    );

    await insertSupportTicketEvent(client, {
      ticketId: input.ticketId,
      eventType: SUPPORT_TICKET_EVENT_TASK_CREATED,
      createdByUserId: input.createdByUserId ?? null,
      payload: { taskId: rows[0]?.id ?? null },
    });

    await client.query("COMMIT");
    return getSupportTicketDetail(input.siteId, input.ticketId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function addSupportTicketLink(input: AddSupportTicketLinkInput) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const existing = await getSupportTicketRowById(client, input.siteId, input.ticketId);
    if (!existing) {
      await client.query("ROLLBACK");
      return null;
    }

    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO phis.support_ticket_links (
         ticket_id,
         system,
         type,
         state,
         flags,
         external_id,
         external_key,
         external_url,
         meta,
         created_by_user_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       RETURNING id`,
      [
        input.ticketId,
        input.system,
        input.type,
        input.state ?? null,
        input.flags ?? 0,
        input.externalId,
        input.externalKey ?? null,
        input.externalUrl ?? null,
        JSON.stringify(input.meta ?? {}),
        input.createdByUserId ?? null,
      ],
    );

    await client.query(
      `UPDATE phis.support_tickets
       SET updated_at = NOW(),
           updated_by_user_id = $3
       WHERE site_id = $1
         AND id = $2`,
      [input.siteId, input.ticketId, input.createdByUserId ?? null],
    );

    await insertSupportTicketEvent(client, {
      ticketId: input.ticketId,
      eventType: SUPPORT_TICKET_EVENT_LINKED,
      createdByUserId: input.createdByUserId ?? null,
      payload: {
        linkId: rows[0]?.id ?? null,
        system: input.system,
        type: input.type,
      },
    });

    await client.query("COMMIT");
    return getSupportTicketDetail(input.siteId, input.ticketId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateSupportTicketTask(input: UpdateSupportTicketTaskInput) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const existing = await getSupportTicketTaskRowById(client, input.siteId, input.ticketId, input.taskId);
    if (!existing) {
      await client.query("ROLLBACK");
      return null;
    }

    const sets: string[] = [];
    const params: unknown[] = [input.taskId];
    const addSet = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (typeof input.type === "number") addSet("type", input.type);
    if (typeof input.status === "number") addSet("status", input.status);
    if (typeof input.flags === "number") addSet("flags", input.flags);
    if (typeof input.sortOrder === "number") addSet("sort_order", input.sortOrder);
    if (input.assigneeUserId !== undefined) addSet("assignee_user_id", input.assigneeUserId ?? null);
    if (typeof input.title === "string") addSet("title", input.title);
    if (input.description !== undefined) addSet("description", input.description ?? null);
    if (input.meta !== undefined) {
      params.push(JSON.stringify(input.meta ?? {}));
      sets.push(`meta = $${params.length}::jsonb`);
    }
    if (input.dueAt !== undefined) addSet("due_at", input.dueAt ?? null);
    if (input.completedAt !== undefined) addSet("completed_at", input.completedAt ?? null);
    addSet("updated_by_user_id", input.updatedByUserId ?? null);
    sets.push("updated_at = NOW()");

    await client.query(
      `UPDATE phis.support_ticket_tasks
       SET ${sets.join(", ")}
       WHERE id = $1`,
      params,
    );

    await client.query(
      `UPDATE phis.support_tickets
       SET updated_at = NOW(),
           updated_by_user_id = $3
       WHERE site_id = $1
         AND id = $2`,
      [input.siteId, input.ticketId, input.updatedByUserId ?? null],
    );

    if (typeof input.status === "number" && input.status !== existing.status) {
      await insertSupportTicketEvent(client, {
        ticketId: input.ticketId,
        eventType:
          input.status === SUPPORT_TICKET_TASK_STATUS_DONE
            ? SUPPORT_TICKET_EVENT_TASK_COMPLETED
            : SUPPORT_TICKET_EVENT_TASK_REOPENED,
        createdByUserId: input.updatedByUserId ?? null,
        payload: {
          taskId: input.taskId,
          fromStatus: existing.status,
          toStatus: input.status,
        },
      });
    }

    await client.query("COMMIT");
    return getSupportTicketDetail(input.siteId, input.ticketId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteSupportTicketTask(siteId: number, ticketId: number, taskId: number, userId?: number | null) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const existing = await getSupportTicketTaskRowById(client, siteId, ticketId, taskId);
    if (!existing) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(
      `DELETE FROM phis.support_ticket_tasks
       WHERE id = $1`,
      [taskId],
    );

    await client.query(
      `UPDATE phis.support_tickets
       SET updated_at = NOW(),
           updated_by_user_id = $3
       WHERE site_id = $1
         AND id = $2`,
      [siteId, ticketId, userId ?? null],
    );

    await client.query("COMMIT");
    return getSupportTicketDetail(siteId, ticketId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateSupportTicketLink(input: UpdateSupportTicketLinkInput) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const existing = await getSupportTicketLinkRowById(client, input.siteId, input.ticketId, input.linkId);
    if (!existing) {
      await client.query("ROLLBACK");
      return null;
    }

    const sets: string[] = [];
    const params: unknown[] = [input.linkId];
    const addSet = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (typeof input.system === "number") addSet("system", input.system);
    if (typeof input.type === "number") addSet("type", input.type);
    if (input.state !== undefined) addSet("state", input.state ?? null);
    if (typeof input.flags === "number") addSet("flags", input.flags);
    if (typeof input.externalId === "string") addSet("external_id", input.externalId);
    if (input.externalKey !== undefined) addSet("external_key", input.externalKey ?? null);
    if (input.externalUrl !== undefined) addSet("external_url", input.externalUrl ?? null);
    if (input.meta !== undefined) {
      params.push(JSON.stringify(input.meta ?? {}));
      sets.push(`meta = $${params.length}::jsonb`);
    }

    if (sets.length > 0) {
      await client.query(
        `UPDATE phis.support_ticket_links
         SET ${sets.join(", ")}
         WHERE id = $1`,
        params,
      );
    }

    await client.query(
      `UPDATE phis.support_tickets
       SET updated_at = NOW(),
           updated_by_user_id = $3
       WHERE site_id = $1
         AND id = $2`,
      [input.siteId, input.ticketId, input.updatedByUserId ?? null],
    );

    await client.query("COMMIT");
    return getSupportTicketDetail(input.siteId, input.ticketId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteSupportTicketLink(siteId: number, ticketId: number, linkId: number, userId?: number | null) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const existing = await getSupportTicketLinkRowById(client, siteId, ticketId, linkId);
    if (!existing) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(
      `DELETE FROM phis.support_ticket_links
       WHERE id = $1`,
      [linkId],
    );

    await client.query(
      `UPDATE phis.support_tickets
       SET updated_at = NOW(),
           updated_by_user_id = $3
       WHERE site_id = $1
         AND id = $2`,
      [siteId, ticketId, userId ?? null],
    );

    await insertSupportTicketEvent(client, {
      ticketId,
      eventType: SUPPORT_TICKET_EVENT_UNLINKED,
      createdByUserId: userId ?? null,
      payload: {
        linkId,
        system: existing.system,
        type: existing.type,
      },
    });

    await client.query("COMMIT");
    return getSupportTicketDetail(siteId, ticketId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
