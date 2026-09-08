/*
 * The CMS row vocabulary, held in the contract both sides read it from.
 *
 * A status, a Region type, a visibility mask and a flag set are written by the site UI, checked and
 * stored here, and read back by both. They stood in two identical files until 2026-09-08 -- the same
 * arrangement the node identity had, and the same silent failure waiting in it: a renumbering on one
 * side would have been read as a different Area or a different status on the other, with every row
 * looking correct where it was written.
 *
 * Re-exported rather than imported at every call site, so the guards, routes and DB layer that use
 * them keep naming one place.
 */
export {
  DEFAULT_PHI_CMS_VISIBILITY_MASK,
  PhiCmsFlags,
  PhiCmsPageType,
  PhiCmsRegionStatus,
  PhiCmsRegionType,
  PhiCmsRevisionFlags,
  PhiCmsStatus,
  PhiCmsVisibilityContext,
  type PhiCmsRegionTypeValue,
} from "@phis/contracts/cms";

/* What phi-server alone keeps: a revision's scope, and the audit vocabulary nothing outside reads. */
export const PhiCmsRevisionScopeType = {
  Page: 0,
  Area: 1,
} as const;

export const PhiCmsAuditEvent = {
  PageDraftSaved: "cms.page_draft.saved",
  PageDraftDeleted: "cms.page_draft.deleted",
  PageMetaUpserted: "cms.page_meta.upserted",
  PagePathChanged: "cms.page_path.changed",
  PagePublished: "cms.page.published",
  AreaDraftSaved: "cms.area_draft.saved",
  AreaDraftDeleted: "cms.area_draft.deleted",
  AreaPublished: "cms.area.published",
  AreaModulesDraftSaved: "cms.area_modules_draft.saved",
  AreaModulesDraftDeleted: "cms.area_modules_draft.deleted",
  AreaModulesPublished: "cms.area_modules.published",
  NavigationDraftSaved: "cms.navigation_draft.saved",
  NavigationDraftDeleted: "cms.navigation_draft.deleted",
  NavigationPublished: "cms.navigation.published",
  ThemeDraftSaved: "cms.theme_draft.saved",
  ThemeDraftDeleted: "cms.theme_draft.deleted",
  ThemePublished: "cms.theme.published",
  RevisionRestored: "cms.revision.restored",
  RevisionDeleted: "cms.revision.deleted",
} as const;

export type PhiCmsAuditEvent = (typeof PhiCmsAuditEvent)[keyof typeof PhiCmsAuditEvent];
