import { NextRequest, NextResponse } from "next/server";

import { getMediaAssetBySiteAndId, updateMediaAsset } from "@/db/media";
import { PhiMediaDeliveryPolicy, resolveAuthorizedMediaSpace } from "@/db/media-spaces";
import {
  clearUserSiteAvatar,
  getUserSiteAvatar,
  setUserSiteAvatar,
} from "@/db/user-site-avatars";
import { requireSiteAuthenticatedApiContext } from "@/lib/guards/site-admin-api";
import { logRuntimeEvent } from "@/lib/log";
import { serializeMediaAssetForDetail } from "@/lib/media-response";
import { requireJsonObjectBody } from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

/**
 * The actor's own avatar on this Site.
 *
 * Deliberately not guarded by `PHI_ACCESS_SITE_MEDIA`: that policy is Site Media administration, and
 * choosing one's own picture is not administration. Every signed-in person may set theirs, and nobody
 * may set anyone else's -- the routes never read a user id from the request, only from the session.
 *
 * The Asset must already live in the actor's own User Space. That is one lookup rather than a rule:
 * `resolveAuthorizedMediaSpace` answers with the Space the actor owns, gated on the availability flag
 * an active Module declares, and the Asset read is scoped to it. An Asset from the Site Space, another
 * person's Space, or a group's is simply not found.
 */
async function resolveOwnUserSpace(siteId: number, userId: number) {
  return resolveAuthorizedMediaSpace({ siteId, userId, requestedSpaceId: "user", intent: "read" });
}

function readAssetId(body: Record<string, unknown>) {
  const value = body.assetId;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    return { assetId: null, issue: "assetId must be a positive integer." };
  }
  return { assetId: value as number, issue: null };
}

export async function GET(request: NextRequest) {
  try {
    const { context, error } = await requireSiteAuthenticatedApiContext(request);
    if (error || !context?.site || !context.session) {
      return error ?? NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    const { site, session } = context;

    const binding = await getUserSiteAvatar(session.userId, site.id);
    if (!binding) {
      return NextResponse.json({ avatar: null });
    }

    // The binding can outlive nothing -- the composite key removes it with the Asset -- but the Asset
    // may have left the Space, so the read stays scoped rather than trusting the stored id.
    const resolution = await resolveOwnUserSpace(site.id, session.userId);
    if (!resolution.ok) {
      return NextResponse.json({ avatar: null });
    }
    const asset = await getMediaAssetBySiteAndId(site.id, binding.assetId, resolution.space.id);
    return NextResponse.json({ avatar: asset ? serializeMediaAssetForDetail(asset) : null });
  } catch (error) {
    logRuntimeEvent("error", "site.account.avatar.read_failed", {
      message: error instanceof Error ? error.message : "Avatar read failed.",
      method: request.method,
      path: request.nextUrl.pathname,
      error,
    });
    return NextResponse.json({ error: "Failed to read the avatar." }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { context, error } = await requireSiteAuthenticatedApiContext(request);
    if (error || !context?.site || !context.session) {
      return error ?? NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    const { site, session } = context;

    const parsed = await requireJsonObjectBody(request, "A JSON object with an assetId is required.");
    if (!parsed.ok) {
      return parsed.response;
    }
    const { assetId, issue } = readAssetId(parsed.body);
    if (issue || assetId == null) {
      return NextResponse.json({ error: issue }, { status: 400 });
    }

    const resolution = await resolveOwnUserSpace(site.id, session.userId);
    if (!resolution.ok) {
      // `space_kind_unavailable` means no active Module declares User Spaces, so there is nowhere for
      // an avatar to live. That is a configuration answer rather than a rejection of this request.
      const status = resolution.reason === "space_kind_unavailable" ? 409 : 403;
      return NextResponse.json({ error: resolution.reason }, { status });
    }

    const asset = await getMediaAssetBySiteAndId(site.id, assetId, resolution.space.id);
    if (!asset) {
      return NextResponse.json({ error: "asset_not_found" }, { status: 404 });
    }

    const binding = await setUserSiteAvatar({
      userId: session.userId,
      siteId: site.id,
      assetId: asset.id,
    });
    if (!binding) {
      return NextResponse.json({ error: "Failed to set the avatar." }, { status: 500 });
    }

    /*
     * An avatar is public, and binding one is what says so.
     *
     * A file arriving in a User Space defaults to the `User` policy, which is the right default for a
     * Space whose purpose nobody has named yet -- but an avatar's purpose is precisely to be seen
     * beside its owner's name, by whoever sees that name. Visibility follows the purpose an Asset was
     * accepted for and is set here rather than chosen by whoever uploaded it, which is the rule
     * section 6 of GROUPS_AND_STORAGE.md states.
     *
     * Widening rotates `delivery_revision`, so a copy cached while the picture was private stops being
     * served under the old address.
     */
    const published = asset.deliveryPolicy === PhiMediaDeliveryPolicy.Public
      ? asset
      : await updateMediaAsset({
        siteId: site.id,
        spaceId: resolution.space.id,
        assetId: asset.id,
        updatedByUserId: session.userId,
        deliveryPolicy: PhiMediaDeliveryPolicy.Public,
      }) ?? asset;

    logRuntimeEvent("info", "site.account.avatar.set", {
      siteKey: site.key,
      userId: session.userId,
      meta: { assetId: asset.id },
    });
    return NextResponse.json({ avatar: serializeMediaAssetForDetail(published) });
  } catch (error) {
    logRuntimeEvent("error", "site.account.avatar.set_failed", {
      message: error instanceof Error ? error.message : "Avatar update failed.",
      method: request.method,
      path: request.nextUrl.pathname,
      error,
    });
    return NextResponse.json({ error: "Failed to set the avatar." }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { context, error } = await requireSiteAuthenticatedApiContext(request);
    if (error || !context?.site || !context.session) {
      return error ?? NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    const { site, session } = context;

    // Clearing the binding leaves the Asset where it is: the picture is still the person's, they just
    // stopped showing it. Deleting it is a Media operation with its own route.
    const cleared = await clearUserSiteAvatar(session.userId, site.id);
    if (cleared) {
      logRuntimeEvent("info", "site.account.avatar.cleared", {
        siteKey: site.key,
        userId: session.userId,
      });
    }
    return NextResponse.json({ avatar: null });
  } catch (error) {
    logRuntimeEvent("error", "site.account.avatar.clear_failed", {
      message: error instanceof Error ? error.message : "Avatar clear failed.",
      method: request.method,
      path: request.nextUrl.pathname,
      error,
    });
    return NextResponse.json({ error: "Failed to clear the avatar." }, { status: 500 });
  }
}
