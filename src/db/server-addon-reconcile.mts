import type { Pool, PoolClient } from "pg";

import type {
  PhiServerAddonDesiredStateEntry,
  PhiServerAddonManifestV1,
} from "../lib/addons/contract.ts";
import { PHI_SERVER_CORE_CAPABILITIES } from "../lib/addons/core-capabilities.ts";
import { PHI_SERVER_ADDON_FLAG_GLOBALLY_ENABLED } from "../lib/constants/server-addons.ts";

export type PhiServerAddonReconcileEntry = {
  desired: PhiServerAddonDesiredStateEntry;
  manifest: PhiServerAddonManifestV1;
  digest: string;
};

async function reconcileCoreCapabilities(client: PoolClient, releaseBuildId: string) {
  await client.query(
    `DELETE FROM phis.server_capabilities
      WHERE provider_id = '@phis/server/core'`,
  );
  for (const capability of PHI_SERVER_CORE_CAPABILITIES) {
    await client.query(
      `INSERT INTO phis.server_capabilities (
         provider_id,
         capability_id,
         interface_digest,
         release_build_id
       )
       VALUES ('@phis/server/core', $1, $2, $3)`,
      [capability.id, capability.interfaceDigest, releaseBuildId],
    );
  }
}

export async function reconcilePhiServerAddons(
  pool: Pool,
  releaseBuildId: string,
  loaded: PhiServerAddonReconcileEntry[],
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await reconcileCoreCapabilities(client, releaseBuildId);

    const desiredIds = loaded.map(({ desired }) => desired.addonId);
    if (desiredIds.length === 0) {
      await client.query(
        `UPDATE phis.server_addons
            SET flags = flags & ~($1::int),
                disabled_at = COALESCE(disabled_at, NOW()),
                updated_at = NOW()`,
        [PHI_SERVER_ADDON_FLAG_GLOBALLY_ENABLED],
      );
      await client.query(
        `DELETE FROM phis.server_capabilities
          WHERE provider_id <> '@phis/server/core'`,
      );
    } else {
      await client.query(
        `UPDATE phis.server_addons
            SET flags = flags & ~($1::int),
                disabled_at = COALESCE(disabled_at, NOW()),
                updated_at = NOW()
          WHERE NOT (addon_id = ANY($2::text[]))`,
        [PHI_SERVER_ADDON_FLAG_GLOBALLY_ENABLED, desiredIds],
      );
      await client.query(
        `DELETE FROM phis.server_capabilities
          WHERE provider_id <> '@phis/server/core'
            AND NOT (provider_id = ANY($1::text[]))`,
        [desiredIds],
      );
    }

    for (const { desired, manifest, digest } of loaded) {
      await client.query(
        `INSERT INTO phis.server_addons (
           addon_id,
           package_name,
           package_version,
           server_abi,
           migration_version,
           manifest_digest,
           release_build_id,
           flags,
           installed_at,
           activated_at,
           disabled_at
         )
         VALUES ($1, $2, $3, $4, 0, $5, $6, $7::int, NOW(),
                 CASE WHEN ($7::int & $8::int) <> 0 THEN NOW() ELSE NULL END,
                 CASE WHEN ($7::int & $8::int) <> 0 THEN NULL ELSE NOW() END)
         ON CONFLICT (addon_id) DO UPDATE
         SET package_name = EXCLUDED.package_name,
             package_version = EXCLUDED.package_version,
             server_abi = EXCLUDED.server_abi,
             manifest_digest = EXCLUDED.manifest_digest,
             release_build_id = EXCLUDED.release_build_id,
             flags = CASE
               WHEN (EXCLUDED.flags & $8::int) <> 0
                 THEN phis.server_addons.flags | $8::int
               ELSE phis.server_addons.flags & ~($8::int)
             END,
             activated_at = CASE
               WHEN (EXCLUDED.flags & $8::int) <> 0
                 THEN COALESCE(phis.server_addons.activated_at, NOW())
               ELSE phis.server_addons.activated_at
             END,
             disabled_at = CASE
               WHEN (EXCLUDED.flags & $8::int) <> 0 THEN NULL
               ELSE COALESCE(phis.server_addons.disabled_at, NOW())
             END,
             updated_at = NOW()`,
        [
          desired.addonId,
          desired.packageName,
          desired.packageVersion,
          manifest.serverAbi,
          digest,
          releaseBuildId,
          desired.enabled ? PHI_SERVER_ADDON_FLAG_GLOBALLY_ENABLED : 0,
          PHI_SERVER_ADDON_FLAG_GLOBALLY_ENABLED,
        ],
      );
      await client.query(
        `DELETE FROM phis.server_capabilities WHERE provider_id = $1`,
        [desired.addonId],
      );
      for (const capability of manifest.capabilities) {
        await client.query(
          `INSERT INTO phis.server_capabilities (
             provider_id,
             capability_id,
             interface_digest,
             release_build_id
           )
           VALUES ($1, $2, $3, $4)`,
          [
            desired.addonId,
            capability.id,
            capability.interfaceDigest,
            releaseBuildId,
          ],
        );
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
