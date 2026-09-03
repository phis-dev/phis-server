import { PHIS_SPECIAL_AREA_KEYS, resolvePhisCmsAreaMask } from "@/lib/constants/cms-areas";
import {
  type PhiAuthorizationViewer,
  type PhiViewerAccessPolicy,
} from "@/lib/authorization";

export type PageAccessInput = {
  visibilityMask?: number | null;
  accessPolicy?: PhiViewerAccessPolicy | null;
  viewer: PhiAuthorizationViewer;
};

export type ResolvedCmsPath = {
  areaMask: number;
  path: string;
};

function normalizeRequestPath(path: string | null | undefined) {
  return `/${(path ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

export function resolveAreaFromPath(path: string | null | undefined) {
  const normalized = normalizeRequestPath(path);
  const first = normalized.split("/").filter(Boolean)[0] ?? "public";
  return resolvePhisCmsAreaMask(first);
}

export function resolveCmsPath(path: string | null | undefined): ResolvedCmsPath {
  const normalized = normalizeRequestPath(path);
  const segments = normalized === "/" ? [] : normalized.slice(1).split("/");
  const areaMask = resolveAreaFromPath(normalized);

  if (segments.length === 0) {
    return { areaMask, path: "/" };
  }

  const first = segments[0]?.toLowerCase();
  const knownArea = Boolean(first) && PHIS_SPECIAL_AREA_KEYS.includes(first as typeof PHIS_SPECIAL_AREA_KEYS[number]);

  if (!knownArea) {
    return { areaMask, path: normalized };
  }

  const remaining = segments.slice(1).join("/");
  return { areaMask, path: remaining ? `/${remaining}` : "/" };
}
