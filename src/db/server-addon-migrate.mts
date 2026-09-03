import { createHash } from "node:crypto";

import type { Pool } from "pg";

import type {
  PhisAddonManifestV1,
  PhisAddonSchemaDescriptor,
} from "../lib/addons/contract.ts";
import { stablePhiJson } from "../lib/addons/manifest.ts";
import { derivePhisAddonSchemaName } from "../lib/addons/schema-name.ts";
import {
  applyPhisAddonSchema,
  dropPhisAddonSchema,
  verifyPhisAddonSchema,
} from "./server-addon-schema.mts";

/**
 * Bringing an Add-on's schema to the shape its descriptor declares.
 *
 * Before v1 this executes exactly one comparison: the one against nothing. Anything else -- a descriptor
 * whose shape changed, or one that moved to a later version over an installation that already holds
 * rows -- ends with an instruction to purge and recreate. That is the licence Core takes for its own
 * schema before v1, and it expires the same way: once installations hold rows nobody may discard, this
 * executes the differences that lose nothing and keeps refusing the ones that do.
 *
 * The checksum covers the canonical serialization of the descriptor rather than any text, so
 * reformatting is not drift and a changed shape is.
 */

export type PhisAddonMigrationInput = {
  manifest: PhisAddonManifestV1;
  releaseBuildId: string;
  /** The role a running instance serves with, which needs to read what this creates but never write DDL. */
  servingRole: string;
};

export type PhisAddonMigrationOutcome = {
  addonId: string;
  schemaName: string | null;
  appliedVersion: number;
  action: "applied" | "unchanged" | "no-schema";
  statements: string[];
};

export function digestPhisAddonSchemaDescriptor(descriptor: PhisAddonSchemaDescriptor) {
  return createHash("sha256").update(stablePhiJson(descriptor)).digest("hex");
}

function purgeAdvice(addonId: string) {
  return `Run \`phis addon purge --addon ${addonId}\` and migrate again.`;
}

/**
 * Records the Add-on before its schema is applied.
 *
 * The applied-version row references the catalog row, so the catalog row has to exist first. Doing it
 * here rather than demanding a prior reconciliation keeps the operator's sequence to one command;
 * activation state is untouched, because that is reconciliation's to decide and not this operation's.
 */
async function ensureCatalogRow(
  client: import("pg").PoolClient,
  manifest: PhisAddonManifestV1,
  releaseBuildId: string,
  manifestDigest: string,
) {
  await client.query(
    `INSERT INTO phis.server_addons (
       addon_id, package_name, package_version, server_abi,
       migration_version, manifest_digest, release_build_id
     )
     VALUES ($1, $2, $3, $4, 0, $5, $6)
     ON CONFLICT (addon_id) DO UPDATE
     SET package_name = EXCLUDED.package_name,
         package_version = EXCLUDED.package_version,
         server_abi = EXCLUDED.server_abi,
         manifest_digest = EXCLUDED.manifest_digest,
         release_build_id = EXCLUDED.release_build_id,
         updated_at = NOW()`,
    [
      manifest.addonId,
      manifest.packageName,
      manifest.packageVersion,
      manifest.serverAbi,
      manifestDigest,
      releaseBuildId,
    ],
  );
}

export async function migratePhisAddon(
  pool: Pool,
  input: PhisAddonMigrationInput,
  manifestDigest: string,
): Promise<PhisAddonMigrationOutcome> {
  const { manifest, releaseBuildId, servingRole } = input;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureCatalogRow(client, manifest, releaseBuildId, manifestDigest);

    const { rows: catalogRows } = await client.query<{ schema_name: string | null }>(
      `SELECT schema_name FROM phis.server_addons WHERE addon_id = $1 FOR UPDATE`,
      [manifest.addonId],
    );
    const recordedSchemaName = catalogRows[0]?.schema_name ?? null;

    if (!manifest.schema) {
      if (recordedSchemaName) {
        throw new Error(
          `${manifest.addonId} declares no tables but owns schema "${recordedSchemaName}". ` +
          purgeAdvice(manifest.addonId),
        );
      }
      await client.query(
        `UPDATE phis.server_addons SET migration_version = 0, updated_at = NOW() WHERE addon_id = $1`,
        [manifest.addonId],
      );
      await client.query("COMMIT");
      return {
        addonId: manifest.addonId,
        schemaName: null,
        appliedVersion: 0,
        action: "no-schema",
        statements: [],
      };
    }

    // A recorded name wins over a computed one, so a later change to the derivation leaves an installed
    // Add-on on the schema it already has instead of orphaning its tables.
    const schemaName = recordedSchemaName ?? derivePhisAddonSchemaName(manifest.addonId);
    const checksum = digestPhisAddonSchemaDescriptor(manifest.schema);

    const { rows: appliedRows } = await client.query<{
      migration_version: number;
      checksum: string;
    }>(
      `SELECT migration_version, checksum
         FROM phis.server_addon_migrations
        WHERE addon_id = $1
        ORDER BY migration_version`,
      [manifest.addonId],
    );

    if (appliedRows.length > 0) {
      const current = appliedRows.at(-1)!;
      if (current.migration_version === manifest.schema.version && current.checksum === checksum) {
        await client.query("COMMIT");
        return {
          addonId: manifest.addonId,
          schemaName,
          appliedVersion: current.migration_version,
          action: "unchanged",
          statements: [],
        };
      }
      if (current.migration_version === manifest.schema.version) {
        throw new Error(
          `The schema descriptor of ${manifest.addonId} changed without changing its version. ` +
          `Version ${current.migration_version} was applied from a different shape. ` +
          purgeAdvice(manifest.addonId),
        );
      }
      throw new Error(
        `${manifest.addonId} moved from schema version ${current.migration_version} to ` +
        `${manifest.schema.version}. Additive migration is not implemented before v1. ` +
        purgeAdvice(manifest.addonId),
      );
    }

    await client.query(
      `UPDATE phis.server_addons
          SET schema_name = $2, updated_at = NOW()
        WHERE addon_id = $1 AND schema_name IS NULL`,
      [manifest.addonId, schemaName],
    );

    const target = { schemaName, descriptor: manifest.schema };
    const statements = await applyPhisAddonSchema(client, target, servingRole);
    const issues = await verifyPhisAddonSchema(client, target);
    if (issues.length > 0) {
      throw new Error(
        `The schema generated for ${manifest.addonId} does not satisfy the Add-on contract:\n- ` +
        issues.join("\n- "),
      );
    }

    await client.query(
      `INSERT INTO phis.server_addon_migrations (
         addon_id, migration_version, migration_id, checksum, release_build_id
       )
       VALUES ($1, $2::int, $3, $4, $5)`,
      [
        manifest.addonId,
        manifest.schema.version,
        `schema-v${manifest.schema.version}`,
        checksum,
        releaseBuildId,
      ],
    );
    await client.query(
      `UPDATE phis.server_addons
          SET migration_version = $2::int, updated_at = NOW()
        WHERE addon_id = $1`,
      [manifest.addonId, manifest.schema.version],
    );

    await client.query("COMMIT");
    return {
      addonId: manifest.addonId,
      schemaName,
      appliedVersion: manifest.schema.version,
      action: "applied",
      statements: statements.map((statement) => statement.summary),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The destructive half of removal, and the only operation here that touches rows.
 *
 * The order is fixed by the catalog's own foreign keys: Site assignments and applied-version rows point
 * at the Add-on with `ON DELETE RESTRICT`, so they go first, and the catalog row last -- which takes the
 * Add-on's stored secrets with it, because credentials for something no longer installed have no reason
 * to stay readable.
 */
export async function purgePhisAddon(pool: Pool, addonId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ schema_name: string | null }>(
      `SELECT schema_name FROM phis.server_addons WHERE addon_id = $1 FOR UPDATE`,
      [addonId],
    );
    if (rows.length === 0) {
      throw new Error(`Add-on ${addonId} is not registered.`);
    }
    const schemaName = rows[0].schema_name;
    if (schemaName) {
      await dropPhisAddonSchema(client, schemaName);
    }
    /*
     * The Add-on's groups are retired, not deleted, and this is the one place in a purge that keeps
     * something. A membership is a statement about a person made by whoever administers the Site; it is
     * not the Add-on's data, and removing a package must not quietly undo fifty of them. A retired
     * group grants nothing either way -- Core filters claims against the available providers -- so
     * keeping them costs no authority and saves re-entering everybody if the Add-on comes back.
     */
    const { rows: retiredGroups } = await client.query<{ id: number }>(
      `UPDATE phis.site_groups SET retired_at = NOW(), updated_at = NOW()
        WHERE provider_id = $1 AND retired_at IS NULL
       RETURNING id`,
      [addonId],
    );
    await client.query(`DELETE FROM phis.site_server_addons WHERE addon_id = $1`, [addonId]);
    await client.query(`DELETE FROM phis.server_addon_migrations WHERE addon_id = $1`, [addonId]);
    await client.query(`DELETE FROM phis.server_capabilities WHERE provider_id = $1`, [addonId]);
    const { rowCount: secretCount } = await client.query(
      `DELETE FROM phis.server_secrets WHERE addon_id = $1`,
      [addonId],
    );
    await client.query(`DELETE FROM phis.server_addons WHERE addon_id = $1`, [addonId]);
    await client.query("COMMIT");
    return {
      addonId,
      schemaName,
      droppedSecrets: secretCount ?? 0,
      retiredGroups: retiredGroups.length,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
