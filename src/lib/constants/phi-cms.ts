/*
 * What phi-server alone keeps about a CMS row.
 *
 * The numbers a row is written with -- status, Region type, visibility mask, flags -- are read from
 * `@phis/contracts/cms`, where the site UI reads them too, and every call site here names that
 * contract. They are not re-exported through this file: nothing outside phi-server imports from it,
 * so a second name for the same value would buy nothing and could drift.
 *
 * A revision's scope and the audit vocabulary stay, because nothing outside asks about either.
 */

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
  AreaOverrideDeleted: "cms.area_override.deleted",
  PageOverrideDeleted: "cms.page_override.deleted",
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
