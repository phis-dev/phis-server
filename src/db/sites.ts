import "server-only";

import { randomBytes } from "node:crypto";

import { getPool } from "@/lib/db";
import { getPhisConfigSync } from "@/lib/config";
import { resolvePhiSiteSourceLocale } from "@/lib/config-files";
import { PHI_CANONICAL_SOURCE_LOCALE, resolvePhiLocaleCapability } from "@/lib/locale";
import { SITE_FLAG_ACTIVE } from "@/lib/site-flags";
import { clearSiteConfigCache } from "@/db/site-config";
import { getMediaAssetById } from "@/db/media";
import { getConfiguredTranslationSupportedLocalesSync } from "@/lib/translation-locale-options";
import { ensureDefaultSiteAuthConfiguration } from "@/db/site-auth";

export type SiteRecord = {
  id: number;
  key: string;
  name: string;
  sourceLocale: string;
  defaultLocale: string;
  flags: number;
  /**
   * Where this Site answers from, as the outside world reaches it.
   *
   * Read with the rest of the row rather than looked up where it is needed: everything Core addresses
   * is Site-relative, so whoever has to leave the Site -- a listing another Core fetches, a link in a
   * mail, a picture in a feed -- would otherwise ask for the Site again to learn its name.
   */
  publicBaseUrl: string;
};

export type SiteLocaleOption = {
  code: string;
  label: string;
};

export type SiteListRecord = {
  id: number;
  key: string;
  name: string;
  hostname: string;
  publicBaseUrl: string;
  supportEmail: string;
  defaultLocale: string;
  availableLocales: SiteLocaleOption[];
  flags: number;
};

export type SiteRuntimeConfig = {
  publicUrl: string;
  key: string;
  name: string;
  hostname: string;
  defaultLocale: string;
  availableLocales: SiteLocaleOption[];
  store?: {
    enabled: boolean;
  };
  theme: Record<string, unknown>;
  themeRevision: {
    publishedRevisionId: number | null;
    workingDraftRevisionId: number | null;
  };
};


const siteByKeyCache = new Map<string, SiteRecord | null>();

function normalizeSiteKey(input: string) {
  return input.trim().toLowerCase();
}

function normalizeHostname(input: string) {
  return input.trim().toLowerCase();
}

function normalizeEmail(input: string) {
  return input.trim().toLowerCase();
}

function mapSiteRow(
  row: {
    id: number; key: string; name: string; default_locale: string; flags: number;
    public_base_url: string;
  },
): SiteRecord {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    sourceLocale: resolvePhiSiteSourceLocale(getPhisConfigSync(), row.key),
    defaultLocale: row.default_locale,
    flags: row.flags,
    publicBaseUrl: row.public_base_url,
  };
}

function mapSiteListRow(
  row: {
    id: number;
    key: string;
    name: string;
    hostname: string;
    public_base_url: string;
    support_email: string;
    default_locale: string;
    available_locales: string[] | null;
    flags: number;
  },
): SiteListRecord {
  const localeCodes = Array.isArray(row.available_locales)
    ? row.available_locales
    : [row.default_locale];

  return {
    id: row.id,
    key: row.key,
    name: row.name,
    hostname: row.hostname,
    publicBaseUrl: row.public_base_url,
    supportEmail: row.support_email,
    defaultLocale: row.default_locale,
    availableLocales: buildLocaleOptions(localeCodes),
    flags: row.flags,
  };
}

function capitalizeLocaleLabel(value: string) {
  if (!value) {
    return value;
  }

  return value.charAt(0).toLocaleUpperCase() + value.slice(1);
}


function buildLocaleLabel(code: string) {
  const normalized = code.trim();
  if (!normalized) {
    return code.toUpperCase();
  }

  try {
    const display = new Intl.DisplayNames([normalized], { type: "language" }).of(normalized);
    return display ? capitalizeLocaleLabel(display) : normalized.toUpperCase();
  } catch {
    return normalized.toUpperCase();
  }
}

function buildLocaleOptions(codes: string[]) {
  const normalizedCodes = codes
    .map((code) => resolvePhiLocaleCapability(code)?.locale)
    .filter((code): code is string => Boolean(code));
  const uniqueCodes = Array.from(new Set(normalizedCodes.length > 0 ? normalizedCodes : [PHI_CANONICAL_SOURCE_LOCALE]));

  return uniqueCodes.map((code) => ({
    code,
    label: buildLocaleLabel(code),
  }));
}

function normalizeConfiguredSiteLocaleCode(input: string) {
  const normalized = input.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) {
    return "";
  }

  const allowedLocales = new Set(getConfiguredTranslationSupportedLocalesSync());
  return allowedLocales.has(normalized) ? normalized : "";
}

function normalizeSiteLocaleCodes(defaultLocale: string, availableLocales: string[]) {
  const normalizedDefaultLocale = normalizeConfiguredSiteLocaleCode(defaultLocale);
  const normalizedAvailableLocales = availableLocales
    .map(normalizeConfiguredSiteLocaleCode)
    .filter(Boolean);

  return {
    defaultLocale: normalizedDefaultLocale,
    availableLocales: Array.from(new Set([normalizedDefaultLocale, ...normalizedAvailableLocales].filter(Boolean))),
  };
}

export async function getSiteByKey(input: string) {
  const key = normalizeSiteKey(input);
  if (!key) {
    return null;
  }

  if (siteByKeyCache.has(key)) {
    return siteByKeyCache.get(key) ?? null;
  }

  const pool = getPool();
  const { rows } = await pool.query<
    {
      id: number; key: string; name: string; default_locale: string; flags: number;
      public_base_url: string;
    }
  >(
    `SELECT id, key, name, default_locale, flags, public_base_url
     FROM phis.sites
     WHERE key = $1
       AND (flags & $2) <> 0
     LIMIT 1`,
    [key, SITE_FLAG_ACTIVE],
  );

  const site = rows[0] ? mapSiteRow(rows[0]) : null;
  siteByKeyCache.set(key, site);
  return site;
}

/**
 * A Site's id and key, with no judgement attached.
 *
 * Deliberately without the active filter `getSiteByKey` applies: the caller is Add-on event delivery,
 * which is working through rows that were written when the Site was whatever it was, and dropping the
 * Site here would turn a delivery into a silent no-op rather than the failure it is. Naming the Site is
 * not the place to decide whether it may be served.
 */
export async function getSiteIdentityById(siteId: number) {
  const { rows } = await getPool().query<{ id: number; key: string }>(
    `SELECT id, key FROM phis.sites WHERE id = $1 LIMIT 1`,
    [siteId],
  );
  return rows[0] ?? null;
}

export async function listSites() {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: number;
    key: string;
    name: string;
    hostname: string;
    public_base_url: string;
    support_email: string;
    default_locale: string;
    available_locales: string[] | null;
    flags: number;
  }>(
    `SELECT id,
            key,
            name,
            hostname,
            public_base_url,
            support_email,
            default_locale,
            available_locales,
            flags
     FROM phis.sites
     ORDER BY id`,
  );

  return rows.map(mapSiteListRow);
}

function buildCustomerNumberPrefix(siteKey: string) {
  const prefix = siteKey.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
  return prefix || "PHS";
}

function buildMailHost(hostname: string, publicBaseUrl: string) {
  const normalizedHostname = normalizeHostname(hostname);
  if (normalizedHostname) {
    return normalizedHostname;
  }

  try {
    return new URL(publicBaseUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export async function createSite(input: {
  key: string;
  name: string;
  hostname: string;
  publicBaseUrl: string;
  defaultLocale: string;
  availableLocales: string[];
  supportEmail: string;
}) {
  const key = normalizeSiteKey(input.key);
  const name = input.name.trim();
  const hostname = normalizeHostname(input.hostname);
  const publicBaseUrl = input.publicBaseUrl.trim();
  const { defaultLocale, availableLocales } = normalizeSiteLocaleCodes(
    input.defaultLocale,
    input.availableLocales,
  );
  const supportEmail = normalizeEmail(input.supportEmail);

  if (!key || !name || !hostname || !publicBaseUrl || !defaultLocale || !supportEmail) {
    throw new Error("Please complete all site fields.");
  }

  try {
    new URL(publicBaseUrl);
  } catch {
    throw new Error("Please provide a valid public base URL.");
  }

  const mailHost = buildMailHost(hostname, publicBaseUrl);
  if (!mailHost) {
    throw new Error("A valid hostname or public base URL is required.");
  }

  const pool = getPool();
  const { rows } = await pool.query<{ id: number }>(
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
     RETURNING id`,
    [
      key,
      name,
      hostname,
      defaultLocale,
      availableLocales,
      SITE_FLAG_ACTIVE,
      publicBaseUrl,
      `no-reply@${mailHost}`,
      name,
      supportEmail,
      buildCustomerNumberPrefix(key),
      randomBytes(32).toString("hex"),
    ],
  );
  await ensureDefaultSiteAuthConfiguration(rows[0].id);

  siteByKeyCache.delete(key);
  clearSiteConfigCache();
}

export async function updateSiteSettings(input: {
  id: number;
  name: string;
  hostname: string;
  publicBaseUrl: string;
  defaultLocale: string;
  availableLocales: string[];
  supportEmail: string;
}) {
  const siteId = input.id;
  const name = input.name.trim();
  const hostname = normalizeHostname(input.hostname);
  const publicBaseUrl = input.publicBaseUrl.trim();
  const { defaultLocale, availableLocales } = normalizeSiteLocaleCodes(
    input.defaultLocale,
    input.availableLocales,
  );
  const supportEmail = normalizeEmail(input.supportEmail);

  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error("A valid site id is required.");
  }

  if (!name || !hostname || !publicBaseUrl || !defaultLocale || !supportEmail) {
    throw new Error("Please complete all site fields.");
  }

  try {
    new URL(publicBaseUrl);
  } catch {
    throw new Error("Please provide a valid public base URL.");
  }

  const mailHost = buildMailHost(hostname, publicBaseUrl);
  if (!mailHost) {
    throw new Error("A valid hostname or public base URL is required.");
  }

  const pool = getPool();
  const existing = await pool.query<{
    key: string;
    hostname: string;
    default_locale: string;
  }>(
    `SELECT key, hostname, default_locale
     FROM phis.sites
     WHERE id = $1
     LIMIT 1`,
    [siteId],
  );

  const previous = existing.rows[0];
  if (!previous) {
    throw new Error("Site not found.");
  }

  if (previous.default_locale !== defaultLocale) {
    throw new Error("The default locale cannot be changed after a site has been created.");
  }

  await pool.query(
    `UPDATE phis.sites
        SET name = $2,
            hostname = $3,
            default_locale = $4,
            available_locales = $5::varchar(8)[],
            public_base_url = $6,
            mail_from = $7,
            mail_from_name = $2,
            support_email = $8,
            contact_recipient = $8,
            updated_at = NOW()
      WHERE id = $1
      RETURNING key, hostname`,
    [
      siteId,
      name,
      hostname,
      defaultLocale,
      availableLocales,
      publicBaseUrl,
      `no-reply@${mailHost}`,
      supportEmail,
    ],
  );

  siteByKeyCache.delete(previous.key);
  clearSiteConfigCache(siteId);
}

export async function updateSiteLocales(input: {
  siteId: number;
  defaultLocale: string;
  availableLocales: string[];
}) {
  const siteId = input.siteId;
  const { defaultLocale, availableLocales } = normalizeSiteLocaleCodes(
    input.defaultLocale,
    input.availableLocales,
  );

  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error("A valid site id is required.");
  }

  if (!defaultLocale || availableLocales.length === 0 || !availableLocales.includes(defaultLocale)) {
    throw new Error("A valid default locale and available locale selection are required.");
  }

  const pool = getPool();
  const { rows } = await pool.query<{ key: string; hostname: string }>(
    `UPDATE phis.sites
     SET default_locale = $2,
         available_locales = $3::varchar(8)[],
         updated_at = NOW()
     WHERE id = $1
     RETURNING key, hostname`,
    [siteId, defaultLocale, availableLocales],
  );

  const updated = rows[0];
  if (!updated) {
    throw new Error("Site not found.");
  }

  siteByKeyCache.delete(updated.key);
  clearSiteConfigCache(siteId);

  return {
    defaultLocale,
    availableLocales: buildLocaleOptions(availableLocales),
  };
}

export async function deleteSite(siteIdInput: number) {
  const siteId = siteIdInput;
  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error("A valid site id is required.");
  }

  const pool = getPool();
  const existing = await pool.query<{
    key: string;
    hostname: string;
  }>(
    `SELECT key, hostname
     FROM phis.sites
     WHERE id = $1
     LIMIT 1`,
    [siteId],
  );

  const site = existing.rows[0];
  if (!site) {
    throw new Error("Site not found.");
  }

  await pool.query(`DELETE FROM phis.sites WHERE id = $1`, [siteId]);

  siteByKeyCache.delete(site.key);
  clearSiteConfigCache(siteId);
}

function mapSiteRuntimeConfigRow(
  row: {
    public_base_url: string;
    key: string;
    name: string;
    hostname: string;
    default_locale: string;
    available_locales: string[] | null;
    medusa_base_url: string | null;
    medusa_publishable_key: string | null;
    theme: Record<string, unknown> | null;
    theme_published_revision_id: number | null;
    theme_working_draft_revision_id: number | null;
  },
): SiteRuntimeConfig {
  const availableLocaleCodes = Array.isArray(row.available_locales)
    ? row.available_locales
    : [row.default_locale];
  const storeEnabled = Boolean(
    row.medusa_base_url?.trim() && row.medusa_publishable_key?.trim(),
  );

  return {
    publicUrl: row.public_base_url,
    key: row.key,
    name: row.name,
    hostname: row.hostname,
    defaultLocale: row.default_locale,
    availableLocales: buildLocaleOptions(availableLocaleCodes),
    store: {
      enabled: storeEnabled,
    },
    theme: row.theme && typeof row.theme === "object" ? row.theme : {},
    themeRevision: {
      publishedRevisionId: row.theme_published_revision_id,
      workingDraftRevisionId: row.theme_working_draft_revision_id,
    },
  };
}

export async function getSiteRuntimeConfig(siteId: number) {
  if (!Number.isInteger(siteId) || siteId <= 0) {
    return null;
  }

  const pool = getPool();
  const { rows } = await pool.query<{
    public_base_url: string;
    key: string;
    name: string;
    hostname: string;
    default_locale: string;
    available_locales: string[] | null;
    medusa_base_url: string | null;
    medusa_publishable_key: string | null;
    theme: Record<string, unknown> | null;
    theme_published_revision_id: number | null;
    theme_working_draft_revision_id: number | null;
  }>(
    `SELECT sites.key,
            sites.name,
            sites.hostname,
            sites.public_base_url,
            sites.default_locale,
            sites.available_locales,
            sites.medusa_base_url,
            sites.medusa_publishable_key,
            sites.theme,
            theme_scope.published_revision_id AS theme_published_revision_id,
            theme_scope.working_draft_revision_id AS theme_working_draft_revision_id
     FROM phis.sites AS sites
     LEFT JOIN phis.site_theme_scopes AS theme_scope
       ON theme_scope.site_id = sites.id
      AND theme_scope.key = 'default'
     WHERE sites.id = $1
       AND (sites.flags & $2) <> 0
     LIMIT 1`,
    [siteId, SITE_FLAG_ACTIVE],
  );

  const config = rows[0] ? mapSiteRuntimeConfigRow(rows[0]) : null;
  if (!config) {
    return null;
  }

  const theme = config.theme && typeof config.theme === "object" ? { ...config.theme } : {};
  const brand =
    theme && typeof theme.brand === "object" && theme.brand !== null
      ? { ...(theme.brand as Record<string, unknown>) }
      : null;

  /*
   * The Logo is one picture per mode. Each Asset-bound mode gets its delivered address with the
   * revision, and the first alt text an Asset carries stands in where the Brand states none.
   */
  const logos = brand && typeof brand.logo === "object" && brand.logo !== null
    ? { ...(brand.logo as Record<string, unknown>) }
    : null;
  if (brand && logos) {
    for (const mode of ["light", "dark"] as const) {
      const logo = logos[mode];
      if (!logo || typeof logo !== "object") continue;
      const { sourceKind, assetId } = logo as { sourceKind?: unknown; assetId?: unknown };
      if (sourceKind !== "asset" || typeof assetId !== "number" || !Number.isInteger(assetId)) continue;
      const asset = await getMediaAssetById(assetId);
      if (!asset) continue;
      logos[mode] = {
        ...(logo as Record<string, unknown>),
        url: `/api/site/media/${asset.id}/content?r=${asset.deliveryRevision}`,
      };
      if (!brand.logoAlt && asset.altText) {
        brand.logoAlt = asset.altText;
      }
    }
    brand.logo = logos;
  }

  return {
    ...config,
    theme: brand ? { ...theme, brand } : theme,
  };
}
