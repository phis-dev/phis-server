import "server-only";

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { Client } from "pg";

import { resolvePhiAppPath } from "@/lib/app-paths";

export type PhiBootstrapSiteInput = {
  key: string;
  name: string;
  hostname: string;
  publicBaseUrl: string;
  defaultLocale: string;
  availableLocales: string[];
  supportEmail: string;
  mailHost: string;
};

function buildCustomerNumberPrefix(siteKey: string) {
  const prefix = siteKey.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
  return prefix || "PHS";
}

export async function verifyPhiDatabaseWriteAccess(connectionString: string) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "CREATE TEMP TABLE phis_bootstrap_db_check (id integer) ON COMMIT DROP",
    );
    await client.query("INSERT INTO phis_bootstrap_db_check (id) VALUES (1)");
    await client.query("ROLLBACK");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    await client.end();
  }
}

export async function applyPhiBootstrapSchema(connectionString: string) {
  const sqlPath = resolvePhiAppPath("scripts", "sql", "001_create_phis.pgsql");
  const sql = readFileSync(sqlPath, "utf-8");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function insertBootstrapSite(client: Client, input: PhiBootstrapSiteInput) {
  const { rows } = await client.query<{ id: number }>(
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
     VALUES ($1, $2, $3, $4, $5::varchar(8)[], 1, '{}'::jsonb, $6, $7, $8, $9, $9, $10, $11)
     RETURNING id`,
    [
      input.key,
      input.name,
      input.hostname,
      input.defaultLocale,
      input.availableLocales,
      input.publicBaseUrl,
      `no-reply@${input.mailHost}`,
      input.name,
      input.supportEmail,
      buildCustomerNumberPrefix(input.key),
      randomBytes(32).toString("hex"),
    ],
  );
  const site = rows[0];
  if (!site) throw new Error(`Site ${input.key} could not be created.`);
  await client.query(
    `INSERT INTO phis.site_auth_config (site_id)
     VALUES ($1)
     ON CONFLICT (site_id) DO NOTHING`,
    [site.id],
  );
}

export async function createPhiBootstrapSites(
  connectionString: string,
  sites: PhiBootstrapSiteInput[],
) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    for (const site of sites) {
      await insertBootstrapSite(client, site);
    }
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    await client.end();
  }
}
