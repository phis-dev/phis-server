import { randomBytes } from "node:crypto";

import type { Pool } from "pg";

import { withPoolTransaction } from "../lib/db-transaction.ts";
import { SITE_FLAG_ACTIVE } from "../lib/site-flags.ts";

export type PhiCliSiteRecord = {
  id: number;
  key: string;
  name: string;
  hostname: string;
  enabled: boolean;
  publicBaseUrl: string;
  supportEmail: string;
  defaultLocale: string;
  availableLocales: string[];
  mailFrom?: string;
  contactRecipient?: string;
};

type SiteRow = {
  id: number;
  key: string;
  name: string;
  hostname: string;
  flags: number;
  public_base_url: string;
  support_email: string;
  default_locale: string;
  available_locales: string[] | null;
  mail_from: string | null;
  contact_recipient: string | null;
};

function mapSiteRow(row: SiteRow): PhiCliSiteRecord {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    hostname: row.hostname,
    enabled: (row.flags & SITE_FLAG_ACTIVE) !== 0,
    publicBaseUrl: row.public_base_url,
    supportEmail: row.support_email,
    defaultLocale: row.default_locale,
    availableLocales: row.available_locales ?? [row.default_locale],
    mailFrom: row.mail_from ?? undefined,
    contactRecipient: row.contact_recipient ?? undefined,
  };
}

function buildCustomerNumberPrefix(siteKey: string) {
  const prefix = siteKey.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
  return prefix || "PHS";
}

export async function createPhiCliSite(pool: Pool, input: {
  key: string;
  name: string;
  hostname: string;
  publicBaseUrl: string;
  defaultLocale: string;
  availableLocales: string[];
  supportEmail: string;
  mailHost: string;
}) {
  return withPoolTransaction(pool, async (client) => {
    const { rows } = await client.query<SiteRow>(
      `INSERT INTO phis.sites (
         key,
         name,
         hostname,
         default_locale,
         available_locales,
         flags,
         theme,
         public_base_url,
         mail_from,
         mail_from_name,
         support_email,
         contact_recipient,
         customer_number_prefix,
         form_guard_secret
       )
       VALUES ($1, $2, $3, $4, $5::varchar(8)[], $6, '{}'::jsonb, $7, $8, $9, $10, $10, $11, $12)
       RETURNING id, key, name, hostname, flags, public_base_url, support_email, default_locale,
                 available_locales, mail_from, contact_recipient`,
      [
        input.key,
        input.name,
        input.hostname,
        input.defaultLocale,
        input.availableLocales,
        SITE_FLAG_ACTIVE,
        input.publicBaseUrl,
        `no-reply@${input.mailHost}`,
        input.name,
        input.supportEmail,
        buildCustomerNumberPrefix(input.key),
        randomBytes(32).toString("hex"),
      ],
    );
    const created = rows[0];
    if (!created) throw new Error(`Site ${input.key} could not be created.`);
    await client.query(
      `INSERT INTO phis.site_auth_config (site_id)
       VALUES ($1)
       ON CONFLICT (site_id) DO NOTHING`,
      [created.id],
    );
    return mapSiteRow(created);
  });
}

export async function deletePhiCliSiteByKey(pool: Pool, siteKey: string) {
  const { rows } = await pool.query<{ key: string; hostname: string }>(
    `DELETE FROM phis.sites
     WHERE key = $1
     RETURNING key, hostname`,
    [siteKey],
  );
  return rows[0] ?? null;
}

export async function listPhiCliSites(pool: Pool) {
  const { rows } = await pool.query<SiteRow>(
    `SELECT id, key, name, hostname, flags, public_base_url, support_email, default_locale,
            available_locales, mail_from, contact_recipient
     FROM phis.sites
     ORDER BY id`,
  );
  return rows.map(mapSiteRow);
}

export async function getPhiCliSiteByKey(pool: Pool, siteKey: string) {
  const { rows } = await pool.query<SiteRow>(
    `SELECT id, key, name, hostname, flags, public_base_url, support_email, default_locale,
            available_locales, mail_from, contact_recipient
     FROM phis.sites
     WHERE key = $1
     LIMIT 1`,
    [siteKey],
  );
  return rows[0] ? mapSiteRow(rows[0]) : null;
}

export async function updatePhiCliSite(pool: Pool, input: {
  siteKey: string;
  name?: string;
  hostname?: string;
  publicBaseUrl?: string;
  supportEmail?: string;
  mailFrom: string;
  mailFromName: string;
  contactRecipient: string;
}) {
  const { rows } = await pool.query<SiteRow>(
    `UPDATE phis.sites
     SET name = COALESCE($2, name),
         hostname = COALESCE($3, hostname),
         public_base_url = COALESCE($4, public_base_url),
         support_email = COALESCE($5, support_email),
         mail_from = $6,
         mail_from_name = $7,
         contact_recipient = $8,
         updated_at = NOW()
     WHERE key = $1
     RETURNING id, key, name, hostname, flags, public_base_url, support_email, default_locale,
               available_locales, mail_from, contact_recipient`,
    [
      input.siteKey,
      input.name ?? null,
      input.hostname ?? null,
      input.publicBaseUrl ?? null,
      input.supportEmail ?? null,
      input.mailFrom,
      input.mailFromName,
      input.contactRecipient,
    ],
  );
  return rows[0] ? mapSiteRow(rows[0]) : null;
}

export async function setPhiCliSiteEnabled(pool: Pool, siteKey: string, enabled: boolean) {
  const { rows } = await pool.query<{ key: string; flags: number }>(
    `UPDATE phis.sites
     SET flags = CASE
           WHEN $2 THEN flags | $3
           ELSE flags & ~$3
         END,
         updated_at = NOW()
     WHERE key = $1
     RETURNING key, flags`,
    [siteKey, enabled, SITE_FLAG_ACTIVE],
  );
  const site = rows[0];
  return site ? { key: site.key, enabled: (site.flags & SITE_FLAG_ACTIVE) !== 0 } : null;
}

export async function addPhiCliSiteLocale(pool: Pool, siteKey: string, locale: string) {
  return withPoolTransaction(pool, async (client) => {
    const { rows } = await client.query<{
      key: string;
      default_locale: string;
      available_locales: string[] | null;
    }>(
      `SELECT key, default_locale, available_locales
       FROM phis.sites
       WHERE key = $1
       LIMIT 1
       FOR UPDATE`,
      [siteKey],
    );
    const site = rows[0];
    if (!site) return null;
    const availableLocales = Array.from(
      new Set([site.default_locale, ...(site.available_locales ?? []), locale]),
    );
    const { rows: updatedRows } = await client.query<{
      key: string;
      available_locales: string[] | null;
    }>(
      `UPDATE phis.sites
       SET available_locales = $2::varchar(8)[],
           updated_at = NOW()
       WHERE key = $1
       RETURNING key, available_locales`,
      [siteKey, availableLocales],
    );
    const updated = updatedRows[0];
    return updated
      ? { key: updated.key, availableLocales: updated.available_locales ?? availableLocales }
      : null;
  });
}
