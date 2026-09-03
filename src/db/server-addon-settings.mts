import type { Pool, PoolClient } from "pg";

import type { PhisAddonSettingDescriptor } from "../lib/addons/contract.ts";
import { resolvePhisAddonConfigurationStatus } from "./server-addon-sites.mts";

/**
 * What an operator configured for one Add-on on one Site.
 *
 * `site_server_addons.configuration_json` has been declared since the first migration and read by
 * nobody. It is the right home: one row per (Site, Add-on) already exists to say whether the Add-on
 * runs there, and what it runs with belongs beside that rather than in a table of its own.
 *
 * The queryable is passed in rather than reached for, because both `phis-cli` and the serving process
 * read these -- one before an instance is up, the other during a request.
 */

type Queryable = Pick<Pool | PoolClient, "query">;

export async function readPhisAddonSettings(
  db: Queryable,
  addonId: string,
  siteId: number,
): Promise<Record<string, unknown>> {
  const { rows } = await db.query<{ configuration_json: Record<string, unknown> | null }>(
    `SELECT configuration_json
       FROM phis.site_server_addons
      WHERE addon_id = $1 AND site_id = $2
      LIMIT 1`,
    [addonId, siteId],
  );
  return rows[0]?.configuration_json ?? {};
}

/**
 * Writes one setting, or removes it when the value is null.
 *
 * Removing rather than storing null is what makes "unset" mean the declared default: a stored null and
 * an absent key would otherwise be two ways to say nothing, and only one of them would fall back.
 */
export async function writePhisAddonSetting(
  db: Queryable,
  input: {
    addonId: string;
    siteId: number;
    name: string;
    value: string | number | boolean | null;
    /** Everything the Add-on declares, so the row's readiness can be re-derived after the write. */
    declared?: ReadonlyArray<PhisAddonSettingDescriptor>;
  },
) {
  const { rowCount } = await db.query(
    input.value === null
      ? `UPDATE phis.site_server_addons
            SET configuration_json = configuration_json - $3, updated_at = NOW()
          WHERE addon_id = $1 AND site_id = $2`
      : `UPDATE phis.site_server_addons
            SET configuration_json = configuration_json || jsonb_build_object($3::text, $4::jsonb),
                updated_at = NOW()
          WHERE addon_id = $1 AND site_id = $2`,
    input.value === null
      ? [input.addonId, input.siteId, input.name]
      : [input.addonId, input.siteId, input.name, JSON.stringify(input.value)],
  );
  if ((rowCount ?? 0) === 0) {
    return false;
  }
  if (input.declared) {
    // Re-derived from what is stored now rather than adjusted by hand: clearing a setting can take a
    // Site back out of readiness, and a status that only ever moves one way is one that lies.
    const stored = await readPhisAddonSettings(db, input.addonId, input.siteId);
    await db.query(
      `UPDATE phis.site_server_addons SET configuration_status = $3, updated_at = NOW()
        WHERE addon_id = $1 AND site_id = $2`,
      [
        input.addonId,
        input.siteId,
        resolvePhisAddonConfigurationStatus(input.declared, stored),
      ],
    );
  }
  return true;
}

/**
 * Whether a value an operator typed fits what the Add-on declared.
 *
 * Checked before anything is stored, so a mistyped commission rate is refused at the moment it is
 * entered rather than silently read back as a fallback three weeks later.
 */
export function parsePhisAddonSettingValue(
  descriptor: PhisAddonSettingDescriptor,
  raw: string,
): { value: string | number | boolean } | { error: string } {
  switch (descriptor.type) {
    case "text":
      return { value: raw };
    case "integer": {
      const trimmed = raw.trim();
      const value = Number.parseInt(trimmed, 10);
      return Number.isSafeInteger(value) && String(value) === trimmed
        ? { value }
        : { error: `"${raw}" is not an integer.` };
    }
    case "boolean": {
      const normalized = raw.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(normalized)) return { value: true };
      if (["false", "0", "no", "off"].includes(normalized)) return { value: false };
      return { error: `"${raw}" is not true or false.` };
    }
  }
}
