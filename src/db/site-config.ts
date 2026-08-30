import "server-only";

import { getPool } from "@/lib/db";

export type SiteConfigRecord = {
  siteId: number;
  hostname: string;
  publicBaseUrl: string;
  mailFrom: string;
  mailFromName: string;
  supportEmail: string;
  contactRecipient: string;
  medusaBaseUrl: string | null;
  medusaPublishableKey: string | null;
  customerNumberPrefix: string | null;
  formGuardSecret: string;
};

const siteConfigCache = new Map<number, SiteConfigRecord | null>();

export function clearSiteConfigCache(siteId?: number) {
  if (typeof siteId === "number" && Number.isInteger(siteId) && siteId > 0) {
    siteConfigCache.delete(siteId);
    return;
  }

  siteConfigCache.clear();
}

function mapSiteConfigRow(
  row: {
    id: number;
    hostname: string;
    public_base_url: string;
    mail_from: string;
    mail_from_name: string;
    support_email: string;
    contact_recipient: string;
    medusa_base_url: string | null;
    medusa_publishable_key: string | null;
    customer_number_prefix: string | null;
    form_guard_secret: string;
  },
): SiteConfigRecord {
  return {
    siteId: row.id,
    hostname: row.hostname,
    publicBaseUrl: row.public_base_url,
    mailFrom: row.mail_from,
    mailFromName: row.mail_from_name,
    supportEmail: row.support_email,
    contactRecipient: row.contact_recipient,
    medusaBaseUrl: row.medusa_base_url,
    medusaPublishableKey: row.medusa_publishable_key,
    customerNumberPrefix: row.customer_number_prefix,
    formGuardSecret: row.form_guard_secret,
  };
}

export async function getSiteConfigBySiteId(siteId: number) {
  if (siteConfigCache.has(siteId)) {
    return siteConfigCache.get(siteId) ?? null;
  }

  const pool = getPool();
  const { rows } = await pool.query<{
    id: number;
    hostname: string;
    public_base_url: string;
    mail_from: string;
    mail_from_name: string;
    support_email: string;
    contact_recipient: string;
    medusa_base_url: string | null;
    medusa_publishable_key: string | null;
    customer_number_prefix: string | null;
    form_guard_secret: string;
  }>(
    `SELECT id,
            hostname,
            public_base_url,
            mail_from,
            mail_from_name,
            support_email,
            contact_recipient,
            medusa_base_url,
            medusa_publishable_key,
            customer_number_prefix,
            form_guard_secret
     FROM phis.sites
     WHERE id = $1
     LIMIT 1`,
    [siteId],
  );

  const config = rows[0] ? mapSiteConfigRow(rows[0]) : null;
  siteConfigCache.set(siteId, config);
  return config;
}
