import "server-only";

import {
  PHI_SERVER_CORE_CAPABILITIES,
  PHI_SERVER_SITE_ACCESS,
  type PhiServerAddonCapabilities,
  type PhiServerAuthorizationCapabilityV1,
  type PhiServerGroupLevel,
  type PhiServerRowIntent,
  type PhiServerSiteAccess,
} from "./contract.ts";
import {
  PHI_SERVER_ADDON_GROUP_COLUMN,
  PHI_SERVER_ADDON_OWNER_COLUMN,
  PHI_SERVER_ADDON_SITE_COLUMN,
} from "./schema-descriptor.ts";
import { derivePhiServerAddonSchemaName } from "./schema-name.ts";
import { quotePhiIdentifier } from "./schema-ddl.ts";
import { readEffectiveGroupMembershipFlags } from "@/db/site-groups";
import { PhiGroupMembershipFlags } from "@/lib/constants/site-groups";
import {
  canPhiViewerAccess,
  PHI_ACCESS_ACCOUNTING,
  PHI_ACCESS_CONTENT_EDITING,
  PHI_ACCESS_DEVELOPER_TOOLS,
  PHI_ACCESS_PUBLISHING,
  PHI_ACCESS_SITE_ADMIN,
  PHI_ACCESS_SITE_MEDIA,
  PHI_ACCESS_STRUCTURE_AUTHORING,
  PHI_ACCESS_SUPPORT,
  type PhiViewerAccessPolicy,
} from "@/lib/authorization";
import { getPool } from "@/lib/db";
import { getEffectiveUserSiteAuthorization } from "@/db/user-site-memberships";
import type { PhiServerAddonManifestV1 } from "./contract.ts";

/**
 * Building the capabilities one request gets.
 *
 * The binding is the whole design. Site and actor are closed over here, so an Add-on has no argument
 * through which it could name another Site or ask about somebody else -- the same reason
 * `buildPhisMediaStorageServiceContext` binds a Provider to its own secret rather than taking a
 * reference. A check that can be reached with the wrong arguments is one that eventually is.
 *
 * Only what the manifest declared is built. The dispatcher has already refused an Add-on requiring a
 * capability this release does not offer, so what is missing here is missing because it was never
 * asked for.
 */

const SITE_ACCESS_POLICIES: Readonly<Record<PhiServerSiteAccess, PhiViewerAccessPolicy>> = {
  [PHI_SERVER_SITE_ACCESS.siteAdmin]: PHI_ACCESS_SITE_ADMIN,
  [PHI_SERVER_SITE_ACCESS.developerTools]: PHI_ACCESS_DEVELOPER_TOOLS,
  [PHI_SERVER_SITE_ACCESS.structureAuthoring]: PHI_ACCESS_STRUCTURE_AUTHORING,
  [PHI_SERVER_SITE_ACCESS.contentEditing]: PHI_ACCESS_CONTENT_EDITING,
  [PHI_SERVER_SITE_ACCESS.publishing]: PHI_ACCESS_PUBLISHING,
  [PHI_SERVER_SITE_ACCESS.siteMedia]: PHI_ACCESS_SITE_MEDIA,
  [PHI_SERVER_SITE_ACCESS.support]: PHI_ACCESS_SUPPORT,
  [PHI_SERVER_SITE_ACCESS.accounting]: PHI_ACCESS_ACCOUNTING,
};

/** Highest first, so the first match is the level. */
const GROUP_LEVELS: ReadonlyArray<readonly [PhiServerGroupLevel, number]> = [
  ["manager", PhiGroupMembershipFlags.Manager],
  ["editor", PhiGroupMembershipFlags.Editor],
  ["author", PhiGroupMembershipFlags.Author],
  ["member", PhiGroupMembershipFlags.Member],
];

function resolveGroupLevel(flags: number): PhiServerGroupLevel | null {
  return GROUP_LEVELS.find(([, value]) => (flags & value) === value)?.[0] ?? null;
}

type RowScope = {
  ownerUserId: number | null;
  groupId: number | null;
  ownerScoped: boolean;
  groupScoped: boolean;
};

/**
 * The scope columns of one row, read by Core because Core is what wrote them.
 *
 * The schema name is derived from the Add-on making the call, never from the argument, so `table` can
 * only ever address a table of that Add-on's own schema. The table is then looked up in the manifest
 * rather than trusted: an unknown name never reaches a query, and neither does an identifier that only
 * looks like one of its tables.
 */
async function readRowScope(
  manifest: PhiServerAddonManifestV1,
  siteId: number,
  table: string,
  id: number | string,
): Promise<RowScope | null> {
  const descriptor = manifest.schema?.tables.find((entry) => entry.name === table);
  if (!descriptor) {
    return null;
  }
  const ownerScoped = descriptor.ownerScoped === true;
  const groupScoped = descriptor.groupScoped === true;
  if (!ownerScoped && !groupScoped) {
    // Nothing to decide, and no query worth running to find that out.
    return { ownerUserId: null, groupId: null, ownerScoped, groupScoped };
  }
  // A composite primary key is not a row address; `mayActOnRow` takes one id and says so.
  if (descriptor.primaryKey.length !== 1) {
    return null;
  }

  const schemaName = derivePhiServerAddonSchemaName(manifest.addonId);
  const columns = [
    ownerScoped ? quotePhiIdentifier(PHI_SERVER_ADDON_OWNER_COLUMN) : `NULL AS ${quotePhiIdentifier(PHI_SERVER_ADDON_OWNER_COLUMN)}`,
    groupScoped ? quotePhiIdentifier(PHI_SERVER_ADDON_GROUP_COLUMN) : `NULL AS ${quotePhiIdentifier(PHI_SERVER_ADDON_GROUP_COLUMN)}`,
  ].join(", ");
  const siteFilter = descriptor.siteScoped
    ? ` AND ${quotePhiIdentifier(PHI_SERVER_ADDON_SITE_COLUMN)} = $2`
    : "";
  const { rows } = await getPool().query<{ owner_user_id: number | null; group_id: number | null }>(
    `SELECT ${columns}
       FROM ${quotePhiIdentifier(schemaName)}.${quotePhiIdentifier(table)}
      WHERE ${quotePhiIdentifier(descriptor.primaryKey[0]!)} = $1${siteFilter}
      LIMIT 1`,
    descriptor.siteScoped ? [id, siteId] : [id],
  );
  const row = rows[0];
  return row
    ? { ownerUserId: row.owner_user_id, groupId: row.group_id, ownerScoped, groupScoped }
    : null;
}

/**
 * The ladder, applied to one row -- and the only place it is applied to an Add-on's data.
 *
 * The shape mirrors what Core does to its own Media Assets, because it is the same rule: an Author
 * reaches what is theirs, an Editor reaches what anyone wrote, and removing someone else's stays a
 * Manager act. A row nobody owns is nobody's, not everybody's.
 */
async function mayActOnScopedRow(input: {
  siteId: number;
  actorUserId: number;
  scope: RowScope;
  intent: PhiServerRowIntent;
}) {
  const { scope } = input;
  if (!scope.ownerScoped && !scope.groupScoped) {
    // Absence of a scope is not absence of a restriction: Core was never told who this row belongs to.
    return false;
  }
  const owns = scope.ownerScoped
    && scope.ownerUserId != null
    && scope.ownerUserId === input.actorUserId;

  if (!scope.groupScoped) {
    // Ownership alone, with no ladder to climb: reading and writing are the owner's and nobody else's.
    return owns;
  }
  if (scope.groupId == null) {
    return false;
  }
  const flags = await readEffectiveGroupMembershipFlags(
    input.siteId,
    scope.groupId,
    input.actorUserId,
  );
  const holds = (level: number) => (flags & level) === level;
  if (!holds(PhiGroupMembershipFlags.Member)) {
    return false;
  }
  if (input.intent === "read") {
    return true;
  }
  if (owns) {
    return holds(PhiGroupMembershipFlags.Author);
  }
  return input.intent === "update"
    ? holds(PhiGroupMembershipFlags.Editor)
    : holds(PhiGroupMembershipFlags.Manager);
}

function buildAuthorizationCapability(input: {
  manifest: PhiServerAddonManifestV1;
  siteId: number;
  actorUserId: number | null;
}): PhiServerAuthorizationCapabilityV1 {
  const { manifest, siteId, actorUserId } = input;
  return Object.freeze({
    async mayActOnRow({ table, id, intent }) {
      if (actorUserId == null) {
        return false;
      }
      const scope = await readRowScope(manifest, siteId, table, id);
      return scope ? mayActOnScopedRow({ siteId, actorUserId, scope, intent }) : false;
    },
    async groupLevel(groupId) {
      if (actorUserId == null || !Number.isSafeInteger(groupId) || groupId <= 0) {
        return null;
      }
      return resolveGroupLevel(await readEffectiveGroupMembershipFlags(siteId, groupId, actorUserId));
    },
    async hasSiteAccess(access) {
      const policy = SITE_ACCESS_POLICIES[access];
      if (actorUserId == null || !policy) {
        return false;
      }
      const role = await getEffectiveUserSiteAuthorization(actorUserId, siteId);
      // A disabled Site membership answers no to everything, exactly as the Site guards treat it.
      if (!role.enabled) {
        return false;
      }
      return canPhiViewerAccess({
        authenticated: true,
        roleClaims: role.roleClaims,
        groupClaims: role.groupClaims,
      }, policy);
    },
  } satisfies PhiServerAuthorizationCapabilityV1);
}

/**
 * The capabilities for one request, bound to it.
 *
 * An operator or an internal caller has no Site user behind them, so the actor is null and every
 * question about a user answers negatively rather than being absent -- an Add-on then handles one
 * shape instead of two, and "no" is the safe answer in the case where nobody is acting.
 */
export function buildPhiServerAddonCapabilities(input: {
  manifest: PhiServerAddonManifestV1;
  siteId: number | null;
  actorUserId: number | null;
}): PhiServerAddonCapabilities {
  const capabilities: PhiServerAddonCapabilities = {};
  if (input.siteId == null) {
    // Every capability here is Site-scoped. Without a Site there is nothing to bind them to.
    return Object.freeze(capabilities);
  }
  if (input.manifest.requiredCoreCapabilities.includes(PHI_SERVER_CORE_CAPABILITIES.authorization)) {
    capabilities.authorization = buildAuthorizationCapability({
      manifest: input.manifest,
      siteId: input.siteId,
      actorUserId: input.actorUserId,
    });
  }
  return Object.freeze(capabilities);
}
