import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  deletePhisSecretWithDb,
  listPhisSecretsWithDb,
  readPhisSecretWithDb,
  writePhisSecretWithDb,
} from "./server-secrets-store.mts";
import { buildPhiSecretReference } from "@/lib/secrets/reference";
import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";

const key = { keyHex: "c".repeat(64), version: 1 };
const otherKey = { keyHex: "d".repeat(64), version: 1 };

describe("server secret store", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    site = await createPhiTestSite("secrets");
  });

  afterAll(async () => {
    const pool = await requirePhiTestDatabase();
    await pool.query(`DELETE FROM phis.server_secrets WHERE reference LIKE 'core:pgtest-%'`);
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("round-trips a Site-scoped secret through the database", async () => {
    const pool = await requirePhiTestDatabase();
    const reference = buildPhiSecretReference({
      owner: { kind: "core" },
      siteKey: site.key,
      name: "smtp-password",
    });

    await writePhisSecretWithDb(pool, { reference, value: "hunter2", key, siteId: site.id });

    expect(await readPhisSecretWithDb(pool, reference, key)).toBe("hunter2");
    expect(await readPhisSecretWithDb(pool, reference, key)).not.toBeNull();
  });

  it("never stores the value in a readable column", async () => {
    const pool = await requirePhiTestDatabase();
    const reference = buildPhiSecretReference({
      owner: { kind: "core" },
      siteKey: site.key,
      name: "readable-check",
    });
    await writePhisSecretWithDb(pool, {
      reference,
      value: "plaintext-canary",
      key,
      siteId: site.id,
    });

    const { rows } = await pool.query<{ row: string }>(
      `SELECT s::text AS row FROM phis.server_secrets s WHERE s.reference = $1`,
      [reference],
    );
    expect(rows[0]!.row).not.toContain("plaintext-canary");
  });

  it("replaces a rotated secret in place", async () => {
    const pool = await requirePhiTestDatabase();
    const reference = buildPhiSecretReference({
      owner: { kind: "core" },
      siteKey: site.key,
      name: "rotating",
    });
    await writePhisSecretWithDb(pool, { reference, value: "first", key, siteId: site.id });
    const before = await listPhisSecretsWithDb(pool, { siteId: site.id });
    await writePhisSecretWithDb(pool, { reference, value: "second", key, siteId: site.id });

    expect(await readPhisSecretWithDb(pool, reference, key)).toBe("second");
    expect((await listPhisSecretsWithDb(pool, { siteId: site.id })).length).toBe(before.length);
  });

  it("refuses to read a secret with the wrong key rather than answering null", async () => {
    const pool = await requirePhiTestDatabase();
    const reference = buildPhiSecretReference({
      owner: { kind: "core" },
      siteKey: site.key,
      name: "wrong-key",
    });
    await writePhisSecretWithDb(pool, { reference, value: "x", key, siteId: site.id });

    await expect(readPhisSecretWithDb(pool, reference, otherKey)).rejects.toThrow();
  });

  it("answers null for a secret nobody configured", async () => {
    const pool = await requirePhiTestDatabase();
    expect(await readPhisSecretWithDb(pool, "core:pgtest-never-written", key)).toBeNull();
    expect(await readPhisSecretWithDb(pool, "core:pgtest-never-written", key)).toBeNull();
  });

  it("derives the owner columns from the reference", async () => {
    const pool = await requirePhiTestDatabase();
    const reference = buildPhiSecretReference({
      owner: { kind: "core" },
      siteKey: site.key,
      name: "owner-columns",
    });
    await writePhisSecretWithDb(pool, { reference, value: "x", key, siteId: site.id });

    const stored = (await listPhisSecretsWithDb(pool, { siteId: site.id }))
      .find((entry) => entry.reference === reference)!;
    expect(stored.addonId).toBeNull();
    expect(stored.siteId).toBe(site.id);
    expect(stored.keyVersion).toBe(1);
  });

  it("refuses a Site-scoped reference without a Site, and the reverse", async () => {
    const pool = await requirePhiTestDatabase();
    const siteScoped = buildPhiSecretReference({
      owner: { kind: "core" },
      siteKey: site.key,
      name: "mismatch",
    });
    await expect(writePhisSecretWithDb(pool, { reference: siteScoped, value: "x", key }))
      .rejects.toThrow(/names a Site/u);
    await expect(writePhisSecretWithDb(pool, {
      reference: "core:pgtest-deployment-wide",
      value: "x",
      key,
      siteId: site.id,
    })).rejects.toThrow(/names no Site/u);
  });

  it("refuses an empty value", async () => {
    const pool = await requirePhiTestDatabase();
    await expect(writePhisSecretWithDb(pool, {
      reference: "core:pgtest-empty",
      value: "",
      key,
    })).rejects.toThrow(/empty secret/u);
  });

  it("takes a Site's secrets with the Site", async () => {
    const pool = await requirePhiTestDatabase();
    const doomed = await createPhiTestSite("secrets-doomed");
    const reference = buildPhiSecretReference({
      owner: { kind: "core" },
      siteKey: doomed.key,
      name: "goes-away",
    });
    await writePhisSecretWithDb(pool, { reference, value: "x", key, siteId: doomed.id });
    expect(await readPhisSecretWithDb(pool, reference, key)).not.toBeNull();

    await pool.query(`DELETE FROM phis.sites WHERE id = $1`, [doomed.id]);

    expect(await readPhisSecretWithDb(pool, reference, key)).toBeNull();
  });

  it("deletes on request and reports whether anything went", async () => {
    const pool = await requirePhiTestDatabase();
    const reference = buildPhiSecretReference({
      owner: { kind: "core" },
      siteKey: site.key,
      name: "removable",
    });
    await writePhisSecretWithDb(pool, { reference, value: "x", key, siteId: site.id });

    expect(await deletePhisSecretWithDb(pool, reference)).toBe(true);
    expect(await deletePhisSecretWithDb(pool, reference)).toBe(false);
  });
});
