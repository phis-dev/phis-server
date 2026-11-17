import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { sha256Bytes, sha256Hex } from "@/lib/auth";
import { decryptAuthTransactionPayload, encryptAuthTransactionPayload } from "@/lib/site-auth/transaction-crypto";
import { createAuthTransaction, consumeAuthTransaction } from "./site-auth";

/**
 * A sign-in transaction is written with the SHA-256 of its state and nonce and an AES-256-GCM sealed
 * payload, all as bytes, and is found again by the hash of the state the provider sends back.
 */
describe("auth transactions against PostgreSQL", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("auth-transactions");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  function transaction(state: string, nonce: string | null) {
    const sealed = encryptAuthTransactionPayload({ state, nonce });
    return {
      id: randomUUID(),
      siteId: site.id,
      providerInstallationKey: null,
      userId: null,
      methodKey: "google",
      stage: "primary" as const,
      stateHash: sha256Bytes(state),
      nonceHash: nonce === null ? null : sha256Bytes(nonce),
      payloadCiphertext: sealed.ciphertext,
      payloadIv: sealed.iv,
      payloadAuthTag: sealed.authTag,
      nextPath: "/",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      consumedAt: null,
    };
  }

  it("writes, finds by the state hash, and returns the payload once", async () => {
    await createAuthTransaction(transaction("state-one", "nonce-one"));

    const found = await consumeAuthTransaction(site.id, sha256Bytes("state-one"));
    expect(found).not.toBeNull();
    expect(found!.stateHash).toEqual(sha256Bytes("state-one"));
    expect(found!.nonceHash!.equals(sha256Bytes("nonce-one"))).toBe(true);
    expect(found!.payloadIv).toHaveLength(12);
    expect(found!.payloadAuthTag).toHaveLength(16);
    expect(decryptAuthTransactionPayload({
      ciphertext: found!.payloadCiphertext, iv: found!.payloadIv, authTag: found!.payloadAuthTag,
    })).toEqual({ state: "state-one", nonce: "nonce-one" });

    expect(await consumeAuthTransaction(site.id, sha256Bytes("state-one"))).toBeNull();
    expect(await consumeAuthTransaction(site.id, sha256Bytes("state-unknown"))).toBeNull();
  });

  it("keeps a missing nonce hash missing", async () => {
    await createAuthTransaction(transaction("state-two", null));
    expect((await consumeAuthTransaction(site.id, sha256Bytes("state-two")))!.nonceHash).toBeNull();
  });

  it("finds a transaction that was stored as hex text before the conversion", async () => {
    const legacy = transaction("state-legacy", "nonce-legacy");
    const pool = await requirePhiTestDatabase();
    await pool.query(
      `INSERT INTO phis.auth_transactions (
         id, site_id, method_key, stage, state_hash, nonce_hash,
         payload_ciphertext, payload_iv, payload_auth_tag, next_path, expires_at
       ) VALUES (
         $1, $2, 'google', 'primary', decode($3, 'hex'), decode($4, 'hex'),
         decode($5, 'hex'), decode($6, 'hex'), decode($7, 'hex'), '/', NOW() + INTERVAL '1 minute'
       )`,
      [
        legacy.id, site.id, sha256Hex("state-legacy"), sha256Hex("nonce-legacy"),
        legacy.payloadCiphertext.toString("hex"), legacy.payloadIv.toString("hex"), legacy.payloadAuthTag.toString("hex"),
      ],
    );

    const found = await consumeAuthTransaction(site.id, sha256Bytes("state-legacy"));
    expect(found!.nonceHash!.equals(sha256Bytes("nonce-legacy"))).toBe(true);
    expect(decryptAuthTransactionPayload({
      ciphertext: found!.payloadCiphertext, iv: found!.payloadIv, authTag: found!.payloadAuthTag,
    })).toEqual({ state: "state-legacy", nonce: "nonce-legacy" });
  });
});
