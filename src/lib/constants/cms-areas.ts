import { PhiCmsVisibilityContext } from "./phi-cms.ts";

export const PHIS_CMS_AREA_KEYS = [
  "public",
  "app",
  "admin",
  "builder",
  "editor",
  "accounting",
] as const;

export type PhisCmsAreaKey = (typeof PHIS_CMS_AREA_KEYS)[number];

export const PHIS_SPECIAL_AREA_KEYS = PHIS_CMS_AREA_KEYS.filter(
  (area): area is Exclude<PhisCmsAreaKey, "public"> => area !== "public",
);

export const PHIS_CORE_RESOLVED_USER_AREAS = [
  "public",
  "app",
  "admin",
  "builder",
  "editor",
  "accounting",
] as const;

export type PhiResolvedUserArea = (typeof PHIS_CORE_RESOLVED_USER_AREAS)[number];

const SERVER_AREA_MASK_BY_KEY: Record<PhisCmsAreaKey, number> = {
  public: PhiCmsVisibilityContext.PublicArea,
  app: PhiCmsVisibilityContext.AppArea,
  admin: PhiCmsVisibilityContext.AdminArea,
  builder: PhiCmsVisibilityContext.BuilderArea,
  editor: PhiCmsVisibilityContext.EditorArea,
  accounting: PhiCmsVisibilityContext.AccountingArea,
};

const SERVER_AREA_KEY_BY_MASK = new Map<number, PhisCmsAreaKey>(
  Object.entries(SERVER_AREA_MASK_BY_KEY).map(([area, mask]) => [mask, area as PhisCmsAreaKey]),
);
const SERVER_AREA_KEY_SET = new Set<string>(PHIS_CMS_AREA_KEYS);

export function isPhisCmsAreaKey(value: unknown): value is PhisCmsAreaKey {
  return typeof value === "string" && SERVER_AREA_KEY_SET.has(value);
}

export function resolvePhisCmsAreaMask(area: string | null | undefined) {
  return SERVER_AREA_MASK_BY_KEY[(area ?? "public") as PhisCmsAreaKey] ?? PhiCmsVisibilityContext.PublicArea;
}

export function resolvePhisCmsAreaKey(areaMask: number): PhisCmsAreaKey {
  return SERVER_AREA_KEY_BY_MASK.get(areaMask) ?? "public";
}
