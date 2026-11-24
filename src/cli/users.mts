import type { Pool } from "pg";

import { PHIS_CORE_CAPABILITIES, type PhisAddonManifestV1 } from "@phis/contracts/addon";
import type { PhisUserField } from "@phis/contracts/users";

import {
  grantPhisAddonUsersBackground,
  listPhisAddonUsersGrants,
  revokePhisAddonUsersBackground,
} from "../db/users-grants.mts";
import { isPhisUserField, phisUserFieldBitsOf, phisUserFieldsOf } from "../lib/constants/users.ts";

type Flags = Map<string, string | boolean>;

/**
 * `phis addon users`: the Site's background grants of `users:v1` (SERVER_ADDONS.md, users:v1), the
 * operator standing in for the Site's admin until the Site Admin has a page for them.
 *
 * Without a switch it lists, per Add-on requiring `users:v1`, what the manifest reads at all, what it asks
 * to read with nobody acting, what is granted on the Site, and what of that counts -- the intersection with
 * what the manifest still asks, so a manifest asking for more keeps the old grant until it is granted
 * again. `--grant` grants what the manifest asks in the background, or the part of it `--fields` names;
 * `--revoke` withdraws the grant.
 */
export async function runPhisAddonUsersCommand(pool: Pool, input: {
  site: { id: number; key: string };
  addons: readonly { addonId: string; manifest: PhisAddonManifestV1 }[];
  flags: Flags;
}): Promise<{ data: unknown; lines: string[] }> {
  const { site, flags } = input;
  const addonFlag = typeof flags.get("addon") === "string" ? String(flags.get("addon")).trim() : "";
  const grant = flags.get("grant") === true;
  const revoke = flags.get("revoke") === true;
  if (grant && revoke) {
    throw new Error("Use either --grant or --revoke.");
  }
  const readers = input.addons.filter((entry) => entry.manifest.requiredCoreCapabilities.includes(PHIS_CORE_CAPABILITIES.users));

  if (grant || revoke) {
    if (!addonFlag) throw new Error("Missing --addon.");
    if (revoke) {
      const changed = await revokePhisAddonUsersBackground(pool, { siteId: site.id, addonId: addonFlag });
      return {
        data: { site: site.key, addonId: addonFlag, revoked: changed },
        lines: [changed
          ? `Withdrew the background access of ${addonFlag} to users:v1 at ${site.key}.`
          : `No change: ${addonFlag} had no background access at ${site.key}.`],
      };
    }
    const entry = readers.find((candidate) => candidate.addonId === addonFlag);
    if (!entry) {
      throw new Error(`${addonFlag} is not installed on this server or does not require users:v1.`);
    }
    const asked: PhisUserField[] = (entry.manifest.users?.background ?? []).filter(isPhisUserField);
    if (asked.length === 0) {
      throw new Error(`${addonFlag} asks for no background access (manifest users.background); there is nothing to grant.`);
    }
    const fieldsFlag = flags.get("fields");
    let fields = asked;
    if (typeof fieldsFlag === "string") {
      const named = fieldsFlag.split(",").map((field) => field.trim()).filter(Boolean);
      const unasked = named.filter((field) => !isPhisUserField(field) || !asked.includes(field));
      if (named.length === 0 || unasked.length > 0) {
        throw new Error(`--fields names what ${addonFlag} asks for in the background: ${asked.join(", ")}.`);
      }
      fields = named as PhisUserField[];
    }
    const { rows } = await pool.query(`SELECT 1 FROM phis.server_addons WHERE addon_id = $1`, [addonFlag]);
    if (rows.length === 0) {
      throw new Error(`${addonFlag} is not in the Add-on registry yet; run phis addon reconcile first.`);
    }
    const changed = await grantPhisAddonUsersBackground(pool, {
      siteId: site.id,
      addonId: addonFlag,
      fields: phisUserFieldBitsOf(fields),
      grantedByUserId: null,
    });
    const granted = phisUserFieldsOf(phisUserFieldBitsOf(fields));
    return {
      data: { site: site.key, addonId: addonFlag, granted, changed },
      lines: [changed
        ? `Granted ${addonFlag} background access to ${granted.join(", ")} at ${site.key}.`
        : `No change: ${addonFlag} already held background access to ${granted.join(", ")} at ${site.key}.`],
    };
  }

  const grants = new Map((await listPhisAddonUsersGrants(pool, site.id)).map((row) => [row.addonId, row]));
  const listed = addonFlag ? readers.filter((entry) => entry.addonId === addonFlag) : readers;
  if (addonFlag && listed.length === 0) {
    throw new Error(`${addonFlag} is not installed on this server or does not require users:v1.`);
  }
  const rows = listed.map((entry) => {
    const asked = (entry.manifest.users?.background ?? []).filter(isPhisUserField);
    const held = grants.get(entry.addonId);
    const grantedBits = held?.fields ?? 0;
    return {
      addonId: entry.addonId,
      fields: (entry.manifest.users?.fields ?? []).filter(isPhisUserField),
      background: asked,
      granted: phisUserFieldsOf(grantedBits),
      effective: phisUserFieldsOf(grantedBits & phisUserFieldBitsOf(asked)),
      awaiting: asked.filter((field) => (grantedBits & phisUserFieldBitsOf([field])) === 0),
      grantedAt: held?.grantedAt ?? null,
      grantedByUserId: held?.grantedByUserId ?? null,
    };
  });
  const lines = rows.length === 0
    ? [`No installed Add-on requires users:v1.`]
    : rows.map((row) => `${row.addonId}  fields=${row.fields.join(",") || "-"}  background=${row.background.join(",") || "-"}`
      + `  granted=${row.granted.join(",") || "-"}  effective=${row.effective.join(",") || "-"}`
      + (row.awaiting.length > 0 ? `  awaiting=${row.awaiting.join(",")}` : "")
      + (row.grantedAt ? `  since ${row.grantedAt} by ${row.grantedByUserId == null ? "the operator" : `user ${row.grantedByUserId}`}` : ""));
  return { data: { site: site.key, addons: rows }, lines };
}
