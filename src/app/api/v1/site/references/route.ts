import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { listPublicSiteSpaceMediaAssetsByIds } from "@/db/media";
import { listSitePageScopes } from "@/db/site-pages";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { isPhiServerCmsAreaKey, resolvePhiServerCmsAreaMask } from "@/lib/constants/cms-areas";
import { readPhiPageReference } from "@/lib/internal-references";
import { serializeMediaAssetForPublicReference } from "@/lib/media-response";
import { requireSiteFromRequest } from "@/lib/site-context";

const MAX_REFERENCES_PER_REQUEST = 256;

/**
 * Bulk resolver for the internal reference forms defined by `REFERENCES.md`.
 *
 * Both `phis:page/<reference>` and `phis:asset/<id>` resolve here, in one round trip per render, because
 * they are one contract. The endpoint is internal-token only and therefore has no mode that returns a
 * management record: Assets are projected through the public rendering projection, and an id outside
 * the Site Space, not Ready, or not publicly deliverable is simply absent from the result.
 */
export async function POST(request: NextRequest) {
  const guardError = guardApiV1(request, { requireInternalToken: true });
  if (guardError) return guardError;
  const site = await requireSiteFromRequest(request);
  if (!site) return NextResponse.json({ error: "Site not found." }, { status: 404 });

  const body = (await request.json().catch(() => null)) as {
    area?: unknown;
    references?: unknown;
    assets?: unknown;
  } | null;
  const area = typeof body?.area === "string" ? body.area.trim().toLowerCase() : "";
  const requestedReferences = body?.references === undefined ? [] : body.references;
  const requestedAssets = body?.assets === undefined ? [] : body.assets;
  if (
    !Array.isArray(requestedReferences) || requestedReferences.length > MAX_REFERENCES_PER_REQUEST ||
    !Array.isArray(requestedAssets) || requestedAssets.length > MAX_REFERENCES_PER_REQUEST
  ) {
    return NextResponse.json({ error: "Invalid reference resolution request." }, { status: 400 });
  }
  // Page references resolve inside one Area; Assets are Site scoped and carry no Area. An Asset-only
  // request therefore does not have to name an Area, and must not be forced to invent one.
  if (requestedReferences.length > 0 && !isPhiServerCmsAreaKey(area)) {
    return NextResponse.json({ error: "Invalid reference resolution request." }, { status: 400 });
  }

  const references = requestedReferences.map((value) => readPhiPageReference(value));
  if (references.some((value) => value == null)) {
    return NextResponse.json({ error: "Invalid Page reference." }, { status: 400 });
  }
  if (requestedAssets.some((value) => !Number.isSafeInteger(value) || (value as number) <= 0)) {
    return NextResponse.json({ error: "Invalid Asset reference." }, { status: 400 });
  }

  const scopes = references.length === 0
    ? []
    : await listSitePageScopes(site.id, resolvePhiServerCmsAreaMask(area));
  const byId = new Map(scopes.map((scope) => [scope.id, scope] as const));
  const resolved = references.map((entry) => {
    const reference = entry!;
    if (reference.target.kind !== "site") {
      return { reference: reference.reference, path: null, deleted: false, targetKind: "module" as const };
    }
    const scope = byId.get(reference.target.pageScopeId);
    const deleted = !scope || scope.tombstonedAt != null || !scope.path;
    return {
      reference: reference.reference,
      path: deleted ? null : scope.path,
      deleted,
      targetKind: "site" as const,
    };
  });

  const assets = (await listPublicSiteSpaceMediaAssetsByIds(site.id, requestedAssets as number[]))
    .map(serializeMediaAssetForPublicReference);

  return NextResponse.json({ area: area || null, resolved, assets });
}
