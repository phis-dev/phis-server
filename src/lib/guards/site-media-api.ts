import "server-only";

import { NextResponse, type NextRequest } from "next/server";

import { canPhiViewerAccess, PHI_ACCESS_DEVELOPER_TOOLS } from "@/lib/authorization";
import {
  requireSiteAuthenticatedApiContext,
  requireSiteMediaApiContext,
  type SiteAdminApiContext,
} from "@/lib/guards/site-admin-api";
import {
  getMediaSpaceById,
  PhiMediaSpaceKind,
  resolveAuthorizedMediaSpace,
} from "@/db/media-spaces";
import { getMediaAssetBySiteAndId } from "@/db/media";
import { readEffectiveGroupMembershipFlags } from "@/db/site-groups";
import { PhiGroupMembershipFlags } from "@/lib/constants/site-groups";

type ResolvedSite = NonNullable<SiteAdminApiContext["site"]>;
type ResolvedSession = SiteAdminApiContext["session"];

export type MediaManagementSiteContext =
  | { site: ResolvedSite; session: ResolvedSession; siteWide: boolean; error: null }
  | { site: null; session: null; siteWide: false; error: NextResponse };

/**
 * Site-shaped adapter over the canonical Media policy guard.
 *
 * The Media routes previously each declared their own token-only context, which resolved a Site from
 * the explicit key header and stopped there: no Site session and no role. This keeps their
 * `{ site, error }` call shape while the authority itself lives in exactly one policy.
 */
export async function requireMediaManagementSiteContext(
  request: NextRequest,
): Promise<MediaManagementSiteContext> {
  const { context, error } = await requireSiteMediaApiContext(request);
  if (error) {
    return { site: null, session: null, siteWide: false, error };
  }
  if (!context?.site) {
    // Unreachable through the canonical guard, which always pairs a missing context with an error.
    return {
      site: null,
      session: null,
      siteWide: false,
      error: NextResponse.json({ error: "Media site context unavailable." }, { status: 500 }),
    };
  }
  /*
   * Whether this actor administers the Site rather than merely its Media. Only that authority sees a
   * Group Space whose group is gone, so the contents stay reachable after an external revocation.
   */
  const siteWide = canPhiViewerAccess({
    authenticated: true,
    roleClaims: context.siteRole?.roleClaims ?? [],
    groupClaims: context.siteRole?.groupClaims ?? [],
  }, PHI_ACCESS_DEVELOPER_TOOLS);
  return { site: context.site, session: context.session, siteWide, error: null };
}

/**
 * A Media write, authorized by the Space it writes into.
 *
 * `PHI_ACCESS_SITE_MEDIA` is Site Media administration, and demanding it for every write made a User
 * Space unusable by the only person it exists for: someone who administers nothing. A User Space is
 * delegated capacity, so the question a write has to answer is not "may this actor administer Media"
 * but "may this actor write *here*".
 *
 * Two answers pass. Site Media authority writes anywhere, as before. Anyone else writes into a Space
 * that is theirs to write into -- their own User Space, or a group's where they hold Author --
 * which is the same question `resolveAuthorizedMediaSpace` already answers for reads, including that a
 * Module must have declared the kind and that a group's Space is refused to someone outside it. It is
 * also what section 6 of GROUPS_AND_STORAGE.md means by a Group Space being materialized by the first
 * Author write: an Author who administers no Media at all still writes.
 *
 * The Site Space is deliberately not among them. It is not delegated capacity, it holds what the Site
 * publishes, and writing there is Media administration whatever else is true of the actor.
 *
 * Quota is untouched by any of this: the reservation is a separate gate the write still has to pass.
 *
 * The Space is resolved by the caller rather than read here: an upload names it in the query, while a
 * staged session already knows it. Passing a resolver rather than returning a context to check later
 * is deliberate -- a check that has to be remembered is one that eventually is not.
 */
export async function requireMediaSpaceWriteContext(
  request: NextRequest,
  resolveTargetSpaceId: (context: {
    site: ResolvedSite;
    session: NonNullable<ResolvedSession>;
  }) => Promise<number | null> | number | null,
): Promise<MediaManagementSiteContext> {
  const media = await requireMediaManagementSiteContext(request);
  if (!media.error) {
    return media;
  }

  // No Media authority. The write may still be the actor's own Space, so ask who they are.
  const { context, error } = await requireSiteAuthenticatedApiContext(request);
  if (error || !context?.site || !context.session) {
    // The Media refusal is the more specific of the two and stays the one reported.
    return media;
  }

  const targetSpaceId = await resolveTargetSpaceId({ site: context.site, session: context.session });
  if (targetSpaceId == null) {
    return media;
  }

  const target = await getMediaSpaceById(context.site.id, targetSpaceId);
  if (!target || target.kind === PhiMediaSpaceKind.Site) {
    return media;
  }

  /*
   * Addressed semantically rather than by the id the caller resolved, so the answer comes from the
   * actor's own standing: `user` is theirs by definition, and `group:<id>` is checked against effective
   * membership. Comparing the result back to the target id is what closes the gap between "a Space this
   * actor may use" and "the Space these bytes are going to".
   */
  const authorized = await resolveAuthorizedMediaSpace({
    siteId: context.site.id,
    userId: context.session.userId,
    requestedSpaceId: target.kind === PhiMediaSpaceKind.User
      ? "user"
      : { kind: "group", groupId: target.groupId ?? 0 },
    intent: "write",
  });
  if (!authorized.ok || authorized.space.id !== targetSpaceId) {
    return media;
  }

  // Never site-wide: this actor reached the write through one Space, not through authority.
  return { site: context.site, session: context.session, siteWide: false, error: null };
}

/**
 * Reads the optional destination Space from one place on every Media route.
 *
 * The Space always travels in the query string, including on writes, so there is a single parsing rule
 * rather than a query variant and a body variant that can disagree. An absent or malformed value means
 * "no explicit Space", which resolves to the Site Space.
 */
export type RequestedMediaSpace =
  | number
  | "user"
  | { kind: "group"; groupId: number }
  | { kind: "user"; userId: number };

export function readRequestedMediaSpaceId(request: NextRequest): RequestedMediaSpace | null {
  return parseRequestedMediaSpace(request.nextUrl.searchParams.get("spaceId"));
}

/**
 * The address forms a Space can be named by.
 *
 * A number can only ever address a Space that already exists. The semantic forms exist for the cases
 * where the row legitimately may not: "user" is the actor's own Space, `group:<id>` is a group's, and
 * `user:<id>` is one named by administration on someone else's behalf. Everything else is "no explicit
 * Space", which resolves to the Site Space.
 */
/**
 * What someone wants to do to one existing Asset.
 *
 * `read` is separate because an Author has to see what they may edit, and `transfer` is separate
 * because handing an Asset over is the one operation that ends someone else's access.
 */
export type MediaAssetIntent = "read" | "update" | "delete";

/**
 * One existing Asset, authorized by who owns it rather than by the Space it sits in.
 *
 * The Space answers "may this actor put something here". It cannot answer "may this actor remove
 * *that*", and answering the second with the first is what would let anyone who may upload into a
 * group also delete what everyone else put there. So the levels are read against the row: an Author
 * reaches what is theirs, an Editor reaches what anyone wrote, and only a Manager removes someone
 * else's.
 *
 * Ownership, not authorship, decides it. An Asset handed over stops being the uploader's problem and
 * starts being the new owner's -- which is the whole reason the two columns are separate.
 *
 * A null owner belongs to nobody: it is what a deleted account leaves behind, and no level reaches it
 * through ownership. Site Media authority still does, as it does everywhere here.
 */
export async function requireMediaAssetContext(
  request: NextRequest,
  assetId: number,
  intent: MediaAssetIntent,
): Promise<MediaManagementSiteContext> {
  const media = await requireMediaManagementSiteContext(request);
  if (!media.error) {
    return media;
  }

  const { context, error } = await requireSiteAuthenticatedApiContext(request);
  if (error || !context?.site || !context.session) {
    return media;
  }

  const asset = await getMediaAssetBySiteAndId(context.site.id, assetId);
  if (!asset) {
    return media;
  }
  const space = await getMediaSpaceById(context.site.id, asset.spaceId);
  // The Site Space is not delegated capacity; acting on what it holds is Media administration.
  if (!space || space.kind === PhiMediaSpaceKind.Site) {
    return media;
  }

  const actorId = context.session.userId;
  const granted = space.kind === PhiMediaSpaceKind.User
    // A User Space is one person's by definition, so the Space is the ownership answer.
    ? space.userId === actorId
    : await isGroupAssetActionAllowed({
      siteId: context.site.id,
      groupId: space.groupId,
      actorId,
      ownerUserId: asset.ownerUserId,
      intent,
    });

  return granted
    ? { site: context.site, session: context.session, siteWide: false, error: null }
    : media;
}

async function isGroupAssetActionAllowed(input: {
  siteId: number;
  groupId: number | null;
  actorId: number;
  ownerUserId: number | null;
  intent: MediaAssetIntent;
}) {
  if (input.groupId == null) {
    return false;
  }
  const flags = await readEffectiveGroupMembershipFlags(input.siteId, input.groupId, input.actorId);
  const holds = (level: number) => (flags & level) === level;
  if (!holds(PhiGroupMembershipFlags.Member)) {
    return false;
  }
  if (input.intent === "read") {
    return true;
  }
  const owns = input.ownerUserId != null && input.ownerUserId === input.actorId;
  if (owns) {
    return holds(PhiGroupMembershipFlags.Author);
  }
  return input.intent === "update"
    ? holds(PhiGroupMembershipFlags.Editor)
    : holds(PhiGroupMembershipFlags.Manager);
}

/**
 * Who may hand an Asset over.
 *
 * Giving away what is yours needs nothing beyond being its owner: that is the receipt handed to the
 * accounting group, and routing it through a Manager would put a queue in front of the ordinary case.
 * Reaching into someone else's ownership is a different act and needs an Editor, whether that means
 * taking it, passing it on, or releasing it to nobody.
 *
 * The recipient must already be in the group. Ownership carries rights, so handing it to an outsider
 * would grant across the group boundary rather than inside it.
 */
export async function canTransferMediaAssetOwnership(input: {
  siteId: number;
  groupId: number | null;
  actorId: number;
  ownerUserId: number | null;
  nextOwnerUserId: number | null;
}) {
  if (input.groupId == null) {
    return false;
  }
  const flags = await readEffectiveGroupMembershipFlags(input.siteId, input.groupId, input.actorId);
  const holds = (level: number) => (flags & level) === level;
  if (input.nextOwnerUserId != null) {
    const recipient = await readEffectiveGroupMembershipFlags(
      input.siteId,
      input.groupId,
      input.nextOwnerUserId,
    );
    if ((recipient & PhiGroupMembershipFlags.Member) !== PhiGroupMembershipFlags.Member) {
      return false;
    }
  }
  const owns = input.ownerUserId != null && input.ownerUserId === input.actorId;
  return owns ? holds(PhiGroupMembershipFlags.Author) : holds(PhiGroupMembershipFlags.Editor);
}

export function parseRequestedMediaSpace(raw: string | null | undefined): RequestedMediaSpace | null {
  if (raw == null) return null;
  const value = raw.trim().toLowerCase();
  if (value === "user") return "user";
  const owned = /^(group|user):(\d+)$/u.exec(value);
  if (owned) {
    const id = Number.parseInt(owned[2]!, 10);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    return owned[1] === "group" ? { kind: "group", groupId: id } : { kind: "user", userId: id };
  }
  // Exact, like the semantic forms above: `parseInt` would have read "12x" as Space 12.
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
