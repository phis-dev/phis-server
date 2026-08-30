import type { Pool } from "pg";

import { writePhiServerSecretWithDb } from "./server-secrets-store.mts";
import type { PhiSecretEncryptionKey } from "../lib/secrets/crypto.ts";

/**
 * Moves the authentication provider secrets that were kept in the runtime configuration file.
 *
 * They were written there by an admin request, which made every provider an operator configured live on
 * exactly one host: a second instance cannot be handed that file without copying it, and a rotation had
 * to reach every copy. This runs once per installation and is the only code left that knows the old
 * shape existed.
 *
 * The reference changes too. `site:acme:auth:google` is not parseable under the reference grammar --
 * `auth` is neither `core` nor `addon` -- so the stored reference is rewritten to
 * `site:acme:core:auth.google` wherever it appears.
 */

const LEGACY_REFERENCE_PATTERN = /^site:([a-z0-9][a-z0-9._-]{0,63}):auth:([a-z0-9][a-z0-9-]{0,63})$/;

export type PhiAuthSecretImportEntry = {
  legacyReference: string;
  reference: string;
  siteKey: string;
  installationKey: string;
  status: "imported" | "site-missing" | "unparseable";
};

export function parseLegacyAuthSecretReference(reference: string) {
  const match = LEGACY_REFERENCE_PATTERN.exec(reference);
  if (!match) {
    return null;
  }
  return { siteKey: match[1], installationKey: match[2] };
}

/**
 * Rewrites the reference wherever a Site's Auth configuration mentions it.
 *
 * The provider list is a JSON document rather than a table, so this is a read, a map, and a write --
 * done per Site, so one Site's unrelated shape cannot make another's rewrite fail.
 */
async function rewriteStoredReferences(
  pool: Pool,
  siteId: number,
  replacements: Map<string, string>,
) {
  const { rows } = await pool.query<{ config: { providers?: { secretReference?: string }[] } }>(
    `SELECT config FROM phis.site_auth_config WHERE site_id = $1 FOR UPDATE`,
    [siteId],
  );
  if (rows.length === 0) {
    return 0;
  }
  const config = rows[0].config;
  let changed = 0;
  for (const provider of config.providers ?? []) {
    const replacement = provider.secretReference
      ? replacements.get(provider.secretReference)
      : undefined;
    if (replacement) {
      provider.secretReference = replacement;
      changed += 1;
    }
  }
  if (changed > 0) {
    await pool.query(
      `UPDATE phis.site_auth_config SET config = $2::jsonb, updated_at = NOW() WHERE site_id = $1`,
      [siteId, JSON.stringify(config)],
    );
  }
  return changed;
}

export async function importPhiAuthSecrets(
  pool: Pool,
  secrets: Record<string, string>,
  key: PhiSecretEncryptionKey,
  buildReference: (siteKey: string, installationKey: string) => string,
) {
  const { rows: siteRows } = await pool.query<{ id: number; key: string }>(
    `SELECT id, key FROM phis.sites`,
  );
  const siteIdByKey = new Map(siteRows.map((row) => [row.key, row.id]));

  const entries: PhiAuthSecretImportEntry[] = [];
  const replacementsBySite = new Map<number, Map<string, string>>();

  for (const [legacyReference, value] of Object.entries(secrets)) {
    const parsed = parseLegacyAuthSecretReference(legacyReference);
    if (!parsed) {
      entries.push({
        legacyReference,
        reference: legacyReference,
        siteKey: "",
        installationKey: "",
        status: "unparseable",
      });
      continue;
    }
    const siteId = siteIdByKey.get(parsed.siteKey);
    const reference = buildReference(parsed.siteKey, parsed.installationKey);
    if (siteId === undefined) {
      entries.push({ legacyReference, reference, ...parsed, status: "site-missing" });
      continue;
    }
    await writePhiServerSecretWithDb(pool, { reference, value, key, siteId });
    const replacements = replacementsBySite.get(siteId) ?? new Map<string, string>();
    replacements.set(legacyReference, reference);
    replacementsBySite.set(siteId, replacements);
    entries.push({ legacyReference, reference, ...parsed, status: "imported" });
  }

  let rewritten = 0;
  for (const [siteId, replacements] of replacementsBySite) {
    rewritten += await rewriteStoredReferences(pool, siteId, replacements);
  }

  return { entries, rewritten };
}
