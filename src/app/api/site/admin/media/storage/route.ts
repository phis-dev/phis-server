import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  checkSiteMediaStorageSettingsUpdate,
  readSiteMediaStorageSettings,
  updateSiteMediaStorageSettings,
  type SiteMediaStorageSettingsUpdate,
} from "@/db/media-storage-settings";
import { getPool } from "@/lib/db";
import { requireSiteMaintainerApiContext } from "@/lib/guards/site-admin-api";
import { requireJsonObjectBody } from "@/lib/helpers/request";
import { logRuntimeEvent } from "@/lib/log";
import { checkPhisStorageProviderReadiness } from "@/lib/media-storage-readiness";

/**
 * Where this Site's Spaces write, among the Storage Profiles the operator created.
 *
 * The Maintainer policy, as on `/api/site/admin/media` beside it: storage is capacity, a Site setting, and
 * not something an author decides. Creating a Profile is not here -- it names a bucket and a secret, which
 * is the operator's (`phis storage add`). What is: the Profile the Site Space writes to, the one new User
 * and Group Spaces start on, which Profiles may be pointed at, and which ones take new objects at all.
 * Nothing here moves bytes; a Space that is pointed elsewhere keeps what it holds where it is.
 */

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteMaintainerApiContext(request);
  if (error) return error;
  return NextResponse.json({ storage: await readSiteMediaStorageSettings(context!.site!.id) });
}

/**
 * A Profile id as a form sends it: a select answers its option's value, which travels as text, and an
 * emptied one answers `""` or `null`. Anything else is refused rather than read as something.
 */
function parseProfileId(value: unknown) {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : null;
  return text !== null && /^[1-9][0-9]{0,9}$/u.test(text) ? Number(text) : null;
}

function readId(value: unknown, field: string, issues: string[], nullable: boolean) {
  if (value === undefined) return undefined;
  if ((value === null || value === "") && nullable) return null;
  const id = parseProfileId(value);
  if (id !== null) return id;
  issues.push(`${field} must be ${nullable ? "empty or " : ""}a Storage Profile id.`);
  return undefined;
}

function readIds(value: unknown, field: string, issues: string[]) {
  if (value === undefined) return undefined;
  const ids = Array.isArray(value) ? value.map(parseProfileId) : null;
  if (ids && ids.every((id) => id !== null)) return [...new Set(ids as number[])];
  issues.push(`${field} must be a list of Storage Profile ids.`);
  return undefined;
}

export async function PATCH(request: NextRequest) {
  const { context, error } = await requireSiteMaintainerApiContext(request);
  if (error) return error;
  const site = context!.site!;
  const parsed = await requireJsonObjectBody(request, "Invalid Media storage settings payload.");
  if (!parsed.ok) return parsed.response;
  const { body } = parsed;

  const issues: string[] = [];
  const update: SiteMediaStorageSettingsUpdate = {
    siteSpaceProfileId: readId(body.siteSpaceProfileId, "siteSpaceProfileId", issues, false) ?? undefined,
    defaultUserProfileId: readId(body.defaultUserProfileId, "defaultUserProfileId", issues, true),
    defaultGroupProfileId: readId(body.defaultGroupProfileId, "defaultGroupProfileId", issues, true),
    allowedProfileIds: readIds(body.allowedProfileIds, "allowedProfileIds", issues),
    disabledProfileIds: readIds(body.disabledProfileIds, "disabledProfileIds", issues),
  };
  const current = await readSiteMediaStorageSettings(site.id);
  issues.push(...checkSiteMediaStorageSettingsUpdate(current, update));
  if (issues.length > 0) {
    return NextResponse.json({ error: "Invalid Media storage settings payload.", details: issues }, { status: 400 });
  }

  /*
   * Every Provider this update puts on the write path is checked against the serving Instances first, as
   * `phis storage use` does: a Profile pointed at, or enabled again, that one Instance cannot open would
   * refuse every upload landing there. What only stays where it was is not asked again.
   */
  const byId = new Map(current.profiles.map((profile) => [profile.id, profile]));
  const newlyWritten = new Set<number>();
  for (const [next, before] of [
    [update.siteSpaceProfileId, current.siteSpaceProfileId],
    [update.defaultUserProfileId, current.defaultUserProfileId],
    [update.defaultGroupProfileId, current.defaultGroupProfileId],
  ] as const) {
    if (next != null && next !== before) newlyWritten.add(next);
  }
  if (update.disabledProfileIds) {
    for (const profile of current.profiles) {
      if (profile.disabled && !update.disabledProfileIds.includes(profile.id)) newlyWritten.add(profile.id);
    }
  }
  const providers = new Set([...newlyWritten].map((id) => byId.get(id)!.providerId));
  for (const providerId of providers) {
    try {
      await checkPhisStorageProviderReadiness(getPool(), providerId);
    } catch (readinessError) {
      return NextResponse.json(
        {
          error: "storage_provider_not_ready",
          message: readinessError instanceof Error ? readinessError.message : "The Storage Provider is not ready.",
        },
        { status: 409 },
      );
    }
  }

  const storage = await updateSiteMediaStorageSettings(site.id, update);
  logRuntimeEvent("info", "admin.media.storage.updated", {
    siteKey: site.key,
    userId: context!.session!.userId,
    method: request.method,
    path: request.nextUrl.pathname,
    meta: {
      siteSpaceProfileId: storage.siteSpaceProfileId,
      defaultUserProfileId: storage.defaultUserProfileId,
      defaultGroupProfileId: storage.defaultGroupProfileId,
      allowedProfileIds: storage.allowedProfileIds,
      disabledProfileIds: storage.profiles.filter((profile) => profile.disabled).map((profile) => profile.id),
    },
  });
  return NextResponse.json({ storage });
}
