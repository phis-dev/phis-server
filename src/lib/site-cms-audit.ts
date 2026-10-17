import "server-only";

import type { NextRequest } from "next/server";

import { PhiCmsAuditEvent, type PhiCmsAuditEvent as PhiCmsAuditEventName } from "@/lib/constants/phi-cms";
import { logRuntimeEvent } from "@/lib/log";

const PHI_CMS_AUDIT_MESSAGES = {
  [PhiCmsAuditEvent.PageDraftSaved]: "CMS page draft saved.",
  [PhiCmsAuditEvent.PageDraftDeleted]: "CMS page draft deleted.",
  [PhiCmsAuditEvent.PageMetaUpserted]: "CMS page meta upserted.",
  [PhiCmsAuditEvent.PagePathChanged]: "CMS page path changed.",
  [PhiCmsAuditEvent.PagePublished]: "CMS page published.",
  [PhiCmsAuditEvent.AreaDraftSaved]: "CMS area draft saved.",
  [PhiCmsAuditEvent.AreaDraftDeleted]: "CMS area draft deleted.",
  [PhiCmsAuditEvent.AreaOverrideDeleted]: "CMS area override deleted.",
  [PhiCmsAuditEvent.PageOverrideDeleted]: "CMS page override deleted.",
  [PhiCmsAuditEvent.AreaPublished]: "CMS area published.",
  [PhiCmsAuditEvent.AreaModulesDraftSaved]: "CMS area Module draft saved.",
  [PhiCmsAuditEvent.AreaModulesDraftDeleted]: "CMS area Module draft deleted.",
  [PhiCmsAuditEvent.AreaModulesPublished]: "CMS area Modules published.",
  [PhiCmsAuditEvent.NavigationDraftSaved]: "CMS navigation draft saved.",
  [PhiCmsAuditEvent.NavigationDraftDeleted]: "CMS navigation draft deleted.",
  [PhiCmsAuditEvent.NavigationPublished]: "CMS navigation published.",
  [PhiCmsAuditEvent.ThemeDraftSaved]: "CMS theme draft saved.",
  [PhiCmsAuditEvent.ThemeDraftDeleted]: "CMS theme draft deleted.",
  [PhiCmsAuditEvent.ThemePublished]: "CMS theme published.",
  [PhiCmsAuditEvent.RevisionRestored]: "CMS revision restored.",
  [PhiCmsAuditEvent.RevisionDeleted]: "CMS revision deleted.",
} satisfies Record<PhiCmsAuditEventName, string>;

export function logSiteCmsAuditEvent(
  event: PhiCmsAuditEventName,
  input: {
    request: NextRequest;
    siteKey: string;
    area?: string | null;
    userId?: number | string | null;
    targetType: string;
    targetId?: number | string | null;
    meta?: Record<string, unknown>;
  },
) {
  logRuntimeEvent("info", event, {
    message: PHI_CMS_AUDIT_MESSAGES[event],
    siteKey: input.siteKey,
    area: input.area,
    userId: input.userId,
    method: input.request.method,
    path: input.request.nextUrl.pathname,
    targetType: input.targetType,
    targetId: input.targetId,
    meta: input.meta,
  });
}
