import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  ensureSiteMediaConfig,
  getMediaSpaceById,
  PhisMediaSpaceKind,
  resolveMediaQuotaCeilingBytes,
  setMediaSpaceQuotaBytes,
} from "@/db/media-spaces";
import { readSiteMediaStorageSettings, setSiteMediaSpaceStorageProfile } from "@/db/media-storage-settings";
import { getPool } from "@/lib/db";
import { requireSiteMaintainerApiContext } from "@/lib/guards/site-admin-api";
import { requireJsonObjectBody } from "@/lib/helpers/request";
import { logRuntimeEvent } from "@/lib/log";
import { checkPhisStorageProviderReadiness } from "@/lib/media-storage-readiness";

/**
 * One User or Group Space departing from the Site's defaults: the Profile it writes to, its quota, or both.
 *
 * Under the rules of the settings above it. The Profile is one the Site offers and not a paused one where
 * it changes, and every serving Instance must hold its Provider; pointing elsewhere moves no files. The
 * quota is the Space's own figure -- `null` hands it back to the Site default -- and may not pass the
 * ceiling the Site set for the kind.
 */

export const dynamic = "force-dynamic";

function refuse(message: string, status = 400) {
  return NextResponse.json({ error: "Invalid Media Space update.", details: [message] }, { status });
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const guarded = await requireSiteMaintainerApiContext(request);
  if (guarded.error) return guarded.error;
  const site = guarded.context!.site!;
  const spaceId = Number.parseInt((await context.params).id, 10);
  if (!Number.isSafeInteger(spaceId) || spaceId <= 0) return refuse("Unknown Media Space.", 404);
  const space = await getMediaSpaceById(site.id, spaceId);
  if (!space || (space.kind !== PhisMediaSpaceKind.User && space.kind !== PhisMediaSpaceKind.Group)) {
    return refuse("Unknown Media Space.", 404);
  }
  const parsed = await requireJsonObjectBody(request, "Invalid Media Space update.");
  if (!parsed.ok) return parsed.response;
  const { body } = parsed;

  let profileId: number | undefined;
  if (body.storageProfileId !== undefined) {
    const raw = body.storageProfileId;
    const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
    if (!/^[1-9][0-9]{0,9}$/u.test(text)) return refuse("storageProfileId must be a Storage Profile id.");
    profileId = Number(text);
    const storage = await readSiteMediaStorageSettings(site.id);
    const profile = storage.profiles.find((candidate) => candidate.id === profileId);
    if (!profile) return refuse(`Storage Profile #${profileId} does not belong to this Site.`);
    if (storage.allowedProfileIds.length > 0 && !storage.allowedProfileIds.includes(profileId)) {
      return refuse(`Storage Profile #${profileId} is not among the offered Profiles.`);
    }
    if (profileId !== space.defaultStorageProfileId) {
      if (profile.disabled) return refuse(`Storage Profile #${profileId} is paused and takes no new uploads.`);
      try {
        await checkPhisStorageProviderReadiness(getPool(), profile.providerId);
      } catch (readinessError) {
        return NextResponse.json({
          error: "storage_provider_not_ready",
          message: readinessError instanceof Error ? readinessError.message : "The Storage Provider is not ready.",
        }, { status: 409 });
      }
    }
  }

  let quotaBytes: number | null | undefined;
  if (body.quotaBytes !== undefined) {
    const raw = body.quotaBytes;
    if (raw !== null && (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0)) {
      return refuse("quotaBytes must be null or a non-negative integer.");
    }
    quotaBytes = raw as number | null;
    const ceiling = resolveMediaQuotaCeilingBytes(space.kind, await ensureSiteMediaConfig(site.id));
    if (quotaBytes != null && ceiling != null && quotaBytes > ceiling) {
      return refuse(`The quota may not exceed the Site's ceiling of ${ceiling} bytes for this kind of Space.`);
    }
  }

  if (profileId !== undefined) await setSiteMediaSpaceStorageProfile(site.id, space.id, profileId);
  const updated = quotaBytes !== undefined ? await setMediaSpaceQuotaBytes(site.id, space.id, quotaBytes) : null;
  logRuntimeEvent("info", "admin.media.space.updated", {
    siteKey: site.key,
    userId: guarded.context!.session!.userId,
    method: request.method,
    path: request.nextUrl.pathname,
    meta: { spaceId: space.id, ...(profileId !== undefined ? { storageProfileId: profileId } : {}), ...(quotaBytes !== undefined ? { quotaBytes } : {}) },
  });
  return NextResponse.json({
    space: {
      id: space.id,
      storageProfileId: profileId ?? space.defaultStorageProfileId,
      quotaBytes: quotaBytes !== undefined ? (updated?.quotaBytes ?? quotaBytes) : space.quotaBytes,
    },
  });
}
