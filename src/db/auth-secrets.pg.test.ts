import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { importPhiAuthSecrets, parseLegacyAuthSecretReference } from "./auth-secret-import.mts";
import { upsertAuthProviderInstallation, upsertSiteAuthMethod } from "@/db/site-auth";
import { buildPublicAuthManifest } from "@/lib/site-auth/manifest";
import {
  buildSiteAuthSecretReference,
  deleteSiteAuthSecret,
  hasSiteAuthSecrets,
  readSiteAuthSecret,
  writeSiteAuthSecret,
} from "@/lib/site-auth/secret-store";
import { isPhiSecretReference } from "@/lib/secrets/reference";
import { readPhiSecretEncryptionKey } from "@/lib/secrets/resolver";
import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";

/**
 * The authentication provider secret, now that it is a row rather than a line in a configuration file.
 *
 * The interesting cases are the two the move introduced: the public manifest, which now asks whether a
 * secret exists instead of reading one, and the import, which has to rewrite a reference the current
 * grammar cannot even parse.
 */

describe("authentication provider secrets", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    site = await createPhiTestSite("auth-secret");
  });

  afterAll(async () => {
    const pool = await requirePhiTestDatabase();
    await pool.query(`DELETE FROM phis.server_secrets WHERE reference LIKE 'site:pgtest-%'`);
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("builds a reference the grammar can read, unlike the one it replaces", () => {
    const reference = buildSiteAuthSecretReference(site.key, "google");
    expect(reference).toBe(`site:${site.key}:core:auth.google`);
    expect(isPhiSecretReference(reference)).toBe(true);
    expect(isPhiSecretReference(`site:${site.key}:auth:google`)).toBe(false);
  });

  it("refuses an installation key longer than the reference segment holds", () => {
    expect(() => buildSiteAuthSecretReference(site.key, "a".repeat(60))).toThrow(/at most 59/);
  });

  it("round-trips a client secret through the encrypted store", async () => {
    const reference = buildSiteAuthSecretReference(site.key, "google");
    await writeSiteAuthSecret(reference, "  s3cr3t  ", site.id);
    expect(await readSiteAuthSecret(reference)).toBe("s3cr3t");

    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ ciphertext: string; site_id: number }>(
      `SELECT ciphertext, site_id FROM phis.server_secrets WHERE reference = $1`,
      [reference],
    );
    expect(rows[0].site_id).toBe(site.id);
    expect(rows[0].ciphertext).not.toContain("s3cr3t");
  });

  it("answers existence for many references in one question", async () => {
    const configured = buildSiteAuthSecretReference(site.key, "google");
    const absent = buildSiteAuthSecretReference(site.key, "apple");
    const present = await hasSiteAuthSecrets([configured, absent, null]);
    expect(present.has(configured)).toBe(true);
    expect(present.has(absent)).toBe(false);
  });

  it("offers a provider only while its secret is stored", async () => {
    await upsertAuthProviderInstallation({
      siteId: site.id,
      installationKey: "google",
      providerKey: "google",
      issuer: "https://accounts.google.com",
      clientId: "client-1",
      secretReference: buildSiteAuthSecretReference(site.key, "google"),
      config: {},
      enabled: true,
      callbackOrigin: null,
      validation: null,
    });
    await upsertSiteAuthMethod({
      siteId: site.id,
      methodKey: "google",
      stage: "primary",
      enabled: true,
      sortOrder: 20,
      presentation: { label: "Google" },
      providerInstallationKey: "google",
    });

    const offered = await buildPublicAuthManifest(site.id);
    expect(offered.methods.map((method) => method.methodKey)).toContain("google");

    await deleteSiteAuthSecret(buildSiteAuthSecretReference(site.key, "google"));
    const withoutSecret = await buildPublicAuthManifest(site.id);
    expect(withoutSecret.methods.map((method) => method.methodKey)).not.toContain("google");
  });

  it("moves a secret out of the old shape and rewrites what pointed at it", async () => {
    const pool = await requirePhiTestDatabase();
    const legacy = `site:${site.key}:auth:google`;
    expect(parseLegacyAuthSecretReference(legacy)).toEqual({
      siteKey: site.key,
      installationKey: "google",
    });

    await pool.query(
      `UPDATE phis.site_auth_config
          SET config = jsonb_set(config, '{providers,0,secretReference}', to_jsonb($2::text))
        WHERE site_id = $1`,
      [site.id, legacy],
    );

    const result = await importPhiAuthSecrets(
      pool,
      { [legacy]: "imported-secret" },
      readPhiSecretEncryptionKey(),
      buildSiteAuthSecretReference,
    );
    expect(result.entries).toEqual([
      {
        legacyReference: legacy,
        reference: `site:${site.key}:core:auth.google`,
        siteKey: site.key,
        installationKey: "google",
        status: "imported",
      },
    ]);
    expect(result.rewritten).toBe(1);

    expect(await readSiteAuthSecret(`site:${site.key}:core:auth.google`)).toBe("imported-secret");
    const { rows } = await pool.query<{ reference: string }>(
      `SELECT p->>'secretReference' AS reference
         FROM phis.site_auth_config c, LATERAL jsonb_array_elements(c.config->'providers') p
        WHERE c.site_id = $1`,
      [site.id],
    );
    expect(rows[0].reference).toBe(`site:${site.key}:core:auth.google`);
  });

  it("reports a Site the import cannot place instead of guessing", async () => {
    const pool = await requirePhiTestDatabase();
    const result = await importPhiAuthSecrets(
      pool,
      { "site:pgtest-absent:auth:google": "x", "not-a-reference": "y" },
      readPhiSecretEncryptionKey(),
      buildSiteAuthSecretReference,
    );
    expect(result.entries.map((entry) => entry.status).sort()).toEqual([
      "site-missing",
      "unparseable",
    ]);
  });
});
