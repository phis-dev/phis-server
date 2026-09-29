import "server-only";

import type { PoolClient } from "pg";

import {
  PHIS_CORE_CAPABILITIES,
  type PhisAddonCapabilities,
  type PhisAuthorizationCapabilityV1,
  type PhisRowIntent,
} from "./contract.ts";
import {
  PHIS_ADDON_GROUP_COLUMN,
  PHIS_ADDON_OWNER_COLUMN,
  PHIS_ADDON_SITE_COLUMN,
} from "./schema-descriptor.ts";
import { derivePhisAddonSchemaName } from "./schema-name.ts";
import { quotePhiIdentifier } from "./schema-ddl.ts";
import { readEffectiveGroupMembershipFlags } from "@/db/site-groups";
import { PhiGroupMembershipFlags, phiGroupLevelOf } from "@/lib/constants/site-groups";
import { holdsPhisSiteAccess } from "./site-access.ts";
import { getPool } from "@/lib/db";
import { buildPhisAddonDataCapability } from "./data-capability.ts";
import { buildPhisAddonRolesCapability } from "./roles-capability.ts";
import { buildPhisAddonGroupsCapability } from "./groups-capability.ts";
import { buildPhisAddonResourceLinksCapability } from "./resource-links-capability.ts";
import { buildPhisAddonSupportCapability } from "./support-capability.ts";
import { buildPhisAddonThreadsCapability } from "./threads-capability.ts";
import { buildPhisAddonSecretsCapability } from "./secrets-capability.ts";
import { buildPhisAddonSettingsCapability } from "./settings-capability.ts";
import { buildPhisAddonStorageCapability } from "./storage-capability.ts";
import { buildPhisAddonAssetsCapability } from "./assets-capability.ts";
import { buildPhisAddonRowAssets } from "./row-assets.ts";
import { ensureSiteMediaConfig } from "@/db/media-spaces";
import type { PhisAddonManifestV1 } from "./contract.ts";

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
  db: Pick<PoolClient, "query">,
  manifest: PhisAddonManifestV1,
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

  const schemaName = derivePhisAddonSchemaName(manifest.addonId);
  const columns = [
    ownerScoped ? quotePhiIdentifier(PHIS_ADDON_OWNER_COLUMN) : `NULL AS ${quotePhiIdentifier(PHIS_ADDON_OWNER_COLUMN)}`,
    groupScoped ? quotePhiIdentifier(PHIS_ADDON_GROUP_COLUMN) : `NULL AS ${quotePhiIdentifier(PHIS_ADDON_GROUP_COLUMN)}`,
  ].join(", ");
  const siteFilter = descriptor.siteScoped
    ? ` AND ${quotePhiIdentifier(PHIS_ADDON_SITE_COLUMN)} = $2`
    : "";
  // On the caller's connection: inside `data.transaction` the row may have been written a statement
  // ago, and a read from the pool would not see it -- the ladder then answered "no row for you" to the
  // very row the same body had just inserted.
  // db-boundary-exempt: the schema and table are an Add-on's own, named at runtime from its manifest.
  const { rows } = await db.query<{ owner_user_id: number | null; group_id: number | null }>(
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
 * The row question with the connection left to the caller.
 *
 * The public capability asks it on the pool. The data capability asks it on whatever it is writing
 * with, which inside a transaction is the transaction's own client -- the only connection that can see
 * a row the same body inserted a statement earlier.
 */
export function buildPhisAddonRowAuthority(input: {
  manifest: PhisAddonManifestV1;
  siteId: number;
  actorUserId: number | null;
}) {
  const { manifest, siteId, actorUserId } = input;
  return async (
    db: Pick<PoolClient, "query">,
    row: { table: string; id: number | string; intent: PhisRowIntent },
  ) => {
    if (actorUserId == null) {
      return false;
    }
    const scope = await readRowScope(db, manifest, siteId, row.table, row.id);
    return scope ? mayActOnScopedRow({ siteId, actorUserId, scope, intent: row.intent }) : false;
  };
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
  intent: PhisRowIntent;
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

/**
 * Whether the actor stands in one group at all.
 *
 * The floor of the ladder rather than a rung on it: an insert names a group, and what the contract
 * promises is that Core refuses one the actor is not in. How deep they may then go in what is already
 * there stays the ladder's question.
 */
async function actorStandsInGroup(siteId: number, groupId: unknown, actorUserId: number | null) {
  if (actorUserId == null || !Number.isSafeInteger(groupId) || (groupId as number) <= 0) {
    return false;
  }
  const flags = await readEffectiveGroupMembershipFlags(siteId, groupId as number, actorUserId);
  return (flags & PhiGroupMembershipFlags.Member) === PhiGroupMembershipFlags.Member;
}

function buildAuthorizationCapability(input: {
  manifest: PhisAddonManifestV1;
  siteId: number;
  actorUserId: number | null;
}): PhisAuthorizationCapabilityV1 {
  const { manifest, siteId, actorUserId } = input;
  const mayActOnRow = buildPhisAddonRowAuthority({ manifest, siteId, actorUserId });
  return Object.freeze({
    mayActOnRow: ({ table, id, intent }) => mayActOnRow(getPool(), { table, id, intent }),
    async groupLevel(groupId) {
      if (actorUserId == null || !Number.isSafeInteger(groupId) || groupId <= 0) {
        return null;
      }
      return phiGroupLevelOf(await readEffectiveGroupMembershipFlags(siteId, groupId, actorUserId));
    },
    async hasSiteAccess(access) {
      return actorUserId != null && holdsPhisSiteAccess(siteId, actorUserId, access);
    },
  } satisfies PhisAuthorizationCapabilityV1);
}

/**
 * The capabilities for one request, bound to it.
 *
 * An operator or an internal caller has no Site user behind them, so the actor is null and every
 * question about a user answers negatively rather than being absent -- an Add-on then handles one
 * shape instead of two, and "no" is the safe answer in the case where nobody is acting.
 */
export function buildPhisAddonCapabilities(input: {
  manifest: PhisAddonManifestV1;
  manifestDigest: string;
  siteId: number | null;
  siteKey?: string | null;
  actorUserId: number | null;
  /**
   * A job runs as the Add-on, not as a person, so the row-level ladder has nobody to apply. Set only by
   * the job runner, which is reachable from the CLI and never from a request.
   */
  systemAuthority?: boolean;
  /**
   * True when nobody authenticated, which today means a hook and nothing else.
   *
   * Kept apart from `actorUserId == null`, which an operator, an internal caller and a job all satisfy
   * while being anything but anonymous.
   */
  unauthenticated?: boolean;
}): PhisAddonCapabilities {
  const capabilities: PhisAddonCapabilities = {};
  if (input.siteId == null) {
    // Every capability here is Site-scoped. Without a Site there is nothing to bind them to.
    return Object.freeze(capabilities);
  }
  const siteId = input.siteId;
  const required = input.manifest.requiredCoreCapabilities;
  const authorization = buildAuthorizationCapability({
    manifest: input.manifest,
    siteId,
    actorUserId: input.actorUserId,
  });
  if (required.includes(PHIS_CORE_CAPABILITIES.authorization)) {
    capabilities.authorization = authorization;
  }
  /*
   * Built whether or not the Add-on asked for `roles:v1`, for the reason the evaluator above is: a query
   * that states `requiresRole` is guarded by Core, and an Add-on must not be able to drop the guard by
   * leaving a capability out of its manifest.
   */
  const roles = buildPhisAddonRolesCapability({
    addonId: input.manifest.addonId,
    siteId,
    actorUserId: input.actorUserId,
    declared: input.manifest.roles ?? [],
  });
  /*
   * What a delete does with the row's files, built from the schema rather than from the capability list.
   *
   * Not gated on `assets:v1`. A build that declared slots, filled them and then stopped asking for the
   * capability still has the files, and the delete that removes their row is the last chance anything
   * has to notice them. It needs the Site key because removing an object means addressing a store.
   */
  const rowAssets = input.siteKey
    && (input.manifest.schema?.tables ?? []).some((table) => (table.assets ?? []).length > 0)
    ? buildPhisAddonRowAssets({
      addonId: input.manifest.addonId,
      siteId,
      siteKey: input.siteKey,
      schema: input.manifest.schema ?? null,
    })
    : null;
  if (required.includes(PHIS_CORE_CAPABILITIES.data)) {
    /*
     * The data capability enforces row authority itself, so it gets the evaluator whether or not the
     * Add-on declared `authorization:v1`. Declaring `data:v1` is not a way to write past the ladder --
     * it is the way to write under it.
     */
    const rowAuthority = buildPhisAddonRowAuthority({
      manifest: input.manifest,
      siteId,
      actorUserId: input.actorUserId,
    });
    capabilities.data = buildPhisAddonDataCapability({
      manifest: input.manifest,
      manifestDigest: input.manifestDigest,
      siteId,
      actorUserId: input.actorUserId,
      mayActOnRow: input.systemAuthority
        ? () => Promise.resolve(true)
        : ({ table, id, intent, db }) => rowAuthority(db, { table, id: id as number | string, intent }),
      mayUseGroup: input.systemAuthority
        ? () => Promise.resolve(true)
        : (groupId) => actorStandsInGroup(siteId, groupId, input.actorUserId),
      hasRole: input.systemAuthority
        ? () => Promise.resolve(true)
        : (role) => roles.has(role),
      unauthenticated: input.unauthenticated === true && input.systemAuthority !== true,
      rowAssets,
    });
  }
  if (required.includes(PHIS_CORE_CAPABILITIES.settings)) {
    capabilities.settings = buildPhisAddonSettingsCapability({
      addonId: input.manifest.addonId,
      siteId,
      declared: input.manifest.settings ?? [],
    });
  }
  if (required.includes(PHIS_CORE_CAPABILITIES.roles)) {
    capabilities.roles = roles;
  }
  if (required.includes(PHIS_CORE_CAPABILITIES.threads)) {
    /*
     * Bound to the acting user, and to nobody where there is none: a job holds no membership, so it
     * gets a capability that can open a thread and refuses the calls that would have to answer "which
     * threads are yours". `systemAuthority` is deliberately not read here -- it lifts row authority for
     * an Add-on's own tables, and these are not its rows.
     */
    capabilities.threads = buildPhisAddonThreadsCapability({
      addonId: input.manifest.addonId,
      siteId,
      actorUserId: input.actorUserId,
      // A verified hook carries `systemAuthority`, which is what tells it apart from the unsigned
      // request that reached the same address.
      unauthenticated: input.unauthenticated === true && input.systemAuthority !== true,
    });
  }
  if (required.includes(PHIS_CORE_CAPABILITIES.resourceLinks)) {
    /*
     * The other half of the same rule. A link is what a person states, and what an Add-on may later
     * act on without one -- so the actor is bound here exactly as it is above, and the provider is
     * closed over so an Add-on can neither read nor overwrite another's references.
     */
    capabilities.resourceLinks = buildPhisAddonResourceLinksCapability({
      addonId: input.manifest.addonId,
      siteId,
      actorUserId: input.actorUserId,
      unauthenticated: input.unauthenticated === true && input.systemAuthority !== true,
    });
  }
  if (required.includes(PHIS_CORE_CAPABILITIES.support)) {
    /*
     * The third of the same rule. A ticket is reached through its thread, so the actor is bound here as
     * it is above and an unverified hook reaches none of it.
     */
    capabilities.support = buildPhisAddonSupportCapability({
      addonId: input.manifest.addonId,
      siteId,
      actorUserId: input.actorUserId,
      unauthenticated: input.unauthenticated === true && input.systemAuthority !== true,
    });
  }
  if (required.includes(PHIS_CORE_CAPABILITIES.groups)) {
    capabilities.groups = buildPhisAddonGroupsCapability({
      addonId: input.manifest.addonId,
      siteId,
      actorUserId: input.actorUserId,
      groupWriter: input.manifest.groupWriter ?? null,
    });
  }
  // The two below address the Site by key rather than by id, because a storage prefix and a secret
  // reference are both written with it. Without one they are not built at all: a capability that
  // cannot name its Site is not a narrower capability, it is a broken one.
  if (input.siteKey) {
    const siteKey = input.siteKey;
    if (required.includes(PHIS_CORE_CAPABILITIES.storage)) {
      capabilities.storage = buildPhisAddonStorageCapability({
        addonId: input.manifest.addonId,
        siteId,
        siteKey,
        readMaxObjectBytes: async () => (await ensureSiteMediaConfig(siteId)).maxObjectBytes,
      });
    }
    if (required.includes(PHIS_CORE_CAPABILITIES.assets)) {
      /*
       * The row authority is the same one the data capability writes under, for the same reason it is
       * given to that one whether or not `authorization:v1` was declared: putting a file on a row changes
       * it, and a second way to change a row must not be a quieter way past the ladder.
       */
      capabilities.assets = buildPhisAddonAssetsCapability({
        addonId: input.manifest.addonId,
        siteId,
        siteKey,
        actorUserId: input.actorUserId,
        schema: input.manifest.schema ?? null,
        mayActOnRow: input.systemAuthority
          ? () => Promise.resolve(true)
          : ({ table, id, intent }) =>
            authorization.mayActOnRow({ table, id: id as number | string, intent }),
        // Core's own upload route, because an Add-on asset is an upload like any other. There is one
        // lifecycle and therefore one address it can be delivered to.
        proxyUploadUrl: ({ token }) => `/api/site/media/uploads/${token}`,
      });
    }
    if (required.includes(PHIS_CORE_CAPABILITIES.secrets)) {
      capabilities.secrets = buildPhisAddonSecretsCapability({
        addonId: input.manifest.addonId,
        siteKey,
      });
    }
  }
  return Object.freeze(capabilities);
}
