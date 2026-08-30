import { PhiCmsVisibilityContext } from "@/lib/constants/phi-cms";

export const PHI_SERVER_CMS_AREA_KEYS = [
  "public",
  "app",
  "admin",
  "builder",
  "editor",
  "accounting",
] as const;

export type PhiServerCmsAreaKey = (typeof PHI_SERVER_CMS_AREA_KEYS)[number];

export const PHI_SERVER_SPECIAL_AREA_KEYS = PHI_SERVER_CMS_AREA_KEYS.filter(
  (area): area is Exclude<PhiServerCmsAreaKey, "public"> => area !== "public",
);

export const PHI_SERVER_CORE_RESOLVED_USER_AREAS = [
  "public",
  "app",
  "admin",
  "builder",
  "editor",
  "accounting",
] as const;

export type PhiResolvedUserArea = (typeof PHI_SERVER_CORE_RESOLVED_USER_AREAS)[number];

const SERVER_AREA_MASK_BY_KEY: Record<PhiServerCmsAreaKey, number> = {
  public: PhiCmsVisibilityContext.PublicArea,
  app: PhiCmsVisibilityContext.AppArea,
  admin: PhiCmsVisibilityContext.AdminArea,
  builder: PhiCmsVisibilityContext.BuilderArea,
  editor: PhiCmsVisibilityContext.EditorArea,
  accounting: PhiCmsVisibilityContext.AccountingArea,
};

const SERVER_AREA_KEY_BY_MASK = new Map<number, PhiServerCmsAreaKey>(
  Object.entries(SERVER_AREA_MASK_BY_KEY).map(([area, mask]) => [mask, area as PhiServerCmsAreaKey]),
);
const SERVER_AREA_KEY_SET = new Set<string>(PHI_SERVER_CMS_AREA_KEYS);

export function isPhiServerCmsAreaKey(value: unknown): value is PhiServerCmsAreaKey {
  return typeof value === "string" && SERVER_AREA_KEY_SET.has(value);
}

export function resolvePhiServerCmsAreaMask(area: string | null | undefined) {
  return SERVER_AREA_MASK_BY_KEY[(area ?? "public") as PhiServerCmsAreaKey] ?? PhiCmsVisibilityContext.PublicArea;
}

export function resolvePhiServerCmsAreaKey(areaMask: number): PhiServerCmsAreaKey {
  return SERVER_AREA_KEY_BY_MASK.get(areaMask) ?? "public";
}
