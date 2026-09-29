import { readFile } from "node:fs/promises";

import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPool: vi.fn() }));

// The transaction frame runs against the mocked pool, the way the real one runs against the pool it
// builds, so the statements the tests read still show its BEGIN, COMMIT or ROLLBACK and the release.
vi.mock("@/lib/db", () => ({
  getPool: mocks.getPool,
  withTransaction: async <T>(body: (client: PoolClient) => Promise<T>): Promise<T> => {
    const client = await mocks.getPool().connect();
    try {
      await client.query("BEGIN");
      const result = await body(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  },
}));

import { commitMediaUploadSessionByToken, releaseExpiredMediaUploadSessions } from "./media";
import { getMediaSpaceById, reserveMediaSpaceQuota } from "./media-spaces";

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

type Statement = { text: string; values: readonly unknown[] };

function pool(answer: (text: string) => unknown[] = () => []) {
  const statements: Statement[] = [];
  const query = async (text: string, values?: readonly unknown[]) => {
    statements.push({ text, values: values ?? [] });
    return { rows: answer(text) };
  };
  const release = vi.fn();
  mocks.getPool.mockReturnValue({ query, connect: async () => ({ query, release }) });
  return {
    statements,
    release,
    texts: () => statements.map((entry) => entry.text.trim().split(/\s+/u).slice(0, 3).join(" ")),
    find: (fragment: string) => statements.find((entry) => entry.text.includes(fragment)),
  };
}

beforeEach(() => {
  mocks.getPool.mockReset();
});

/*
 * Expired upload reservations are released by the request that needs the capacity, not by a timer.
 * That only works if the release is one statement and the commit is one transaction: a window between
 * "the row is gone" and "its bytes are no longer reserved" is exactly what would let the same bytes be
 * subtracted twice, and the second subtraction takes them from whichever session reserved next.
 */
describe("Releasing what expired sessions still hold", () => {
  it("removes the expired rows of one Space and gives their bytes back in one statement", async () => {
    const db = pool(() => [
      { storage_profile_id: 7, staging_storage_key: "sites/uploads-temp/demo/a/x.bin", provider_upload_id: null },
      { storage_profile_id: 7, staging_storage_key: "sites/uploads-temp/demo/b/y.mp4", provider_upload_id: "2~abc" },
    ]);
    await expect(releaseExpiredMediaUploadSessions(5)).resolves.toEqual([
      { storageProfileId: 7, stagingStorageKey: "sites/uploads-temp/demo/a/x.bin", providerUploadId: null },
      { storageProfileId: 7, stagingStorageKey: "sites/uploads-temp/demo/b/y.mp4", providerUploadId: "2~abc" },
    ]);
    expect(db.statements).toHaveLength(1);
    const [statement] = db.statements;
    expect(statement.text).toMatch(/DELETE FROM phis\.media_upload_sessions/u);
    expect(statement.text).toMatch(/UPDATE phis\.media_spaces/u);
    expect(statement.text).toMatch(/reserved_bytes = GREATEST\(0, s\.reserved_bytes - f\.bytes\)/u);
    expect(statement.values).toEqual([5]);
  });

  /*
   * The row is the only record of where an expired session's remains are, and deleting it is what frees the
   * reservation. Returning them is therefore the difference between an object something can still find and
   * one only a storage lifecycle rule will ever reach.
   */
  it("hands back where the remains are, including the name of an unfinished assembly", async () => {
    const db = pool(() => []);
    await releaseExpiredMediaUploadSessions(5);
    expect(db.statements[0].text)
      .toMatch(/RETURNING size_bytes, storage_profile_id, staging_storage_key, provider_upload_id/u);
  });

  it("touches only sessions of the Space that was asked, and only expired ones", async () => {
    const db = pool(() => []);
    await releaseExpiredMediaUploadSessions(5);
    expect(db.statements[0].text).toMatch(/WHERE space_id = \$1 AND expires_at < NOW\(\)/u);
  });

  it("reports nothing released when nothing had expired", async () => {
    pool(() => []);
    await expect(releaseExpiredMediaUploadSessions(5)).resolves.toEqual([]);
  });

  it("does not go to the database for something that cannot be a Space", async () => {
    const db = pool();
    for (const spaceId of [0, -1, 1.5, Number.NaN]) {
      await expect(releaseExpiredMediaUploadSessions(spaceId)).resolves.toEqual([]);
    }
    expect(db.statements).toHaveLength(0);
  });

  it("is what the upload takes capacity through, before it reserves any", async () => {
    const route = await read("src/app/api/site/media/uploads/init/route.ts");
    const released = route.indexOf("releaseExpiredMediaUploadSessions(space.id)");
    const reserved = route.indexOf("reserveMediaSpaceQuota({ spaceId: space.id");
    expect(released).toBeGreaterThan(-1);
    expect(released).toBeLessThan(reserved);
  });

  /*
   * And the remains are removed after the response rather than in front of the plan. A storage call in the
   * request path would hang the upload a person is waiting for on objects that are no longer anybody's --
   * while dropping them entirely would leave objects nothing can find, since their rows are gone.
   *
   * What says "after the response" is `after`, and only that. It used to be read off the source order as
   * well -- the discard sitting below `createUploadPlan` -- and that reading stopped meaning anything once
   * the handler gained an earlier exit for an upload it carries on rather than opens. So the order that is
   * held to now is the one that can still go wrong: the cleanup has to be registered before the first way
   * out of the handler, or the path that reserves nothing is the path that sweeps and never cleans up.
   */
  it("removes what they left at the Provider after the response, whichever way the request ends", async () => {
    const route = await read("src/app/api/site/media/uploads/init/route.ts");
    const scheduled = route.indexOf("after(async () => {");
    const discard = route.indexOf("discardReleasedPhiMediaUploadStaging({");
    const firstExit = route.indexOf("return NextResponse.json({");
    expect(scheduled).toBeGreaterThan(-1);
    // Inside the deferred block, which is what keeps a storage out of the request a person is waiting on.
    expect(discard).toBeGreaterThan(scheduled);
    // And registered before any answer is sent, so no exit leaves the swept remains to nobody.
    expect(scheduled).toBeLessThan(firstExit);
  });
});

describe("Committing an upload session", () => {
  it("moves the bytes and closes the session in one transaction", async () => {
    const db = pool((text) => (text.includes("UPDATE phis.media_spaces") ? [{ id: 5 }] : []));
    await commitMediaUploadSessionByToken("t0ken");
    expect(db.texts()).toEqual([
      "BEGIN",
      "UPDATE phis.media_spaces s",
      "DELETE FROM phis.media_upload_sessions",
      "COMMIT",
    ]);
    const update = db.find("UPDATE phis.media_spaces")!;
    expect(update.text).toMatch(/used_bytes = s\.used_bytes \+ u\.size_bytes/u);
    expect(update.text).toMatch(/s\.reserved_bytes >= u\.size_bytes/u);
    expect(update.values).toEqual(["t0ken"]);
  });

  it("keeps the session when its reservation is no longer available", async () => {
    const db = pool(() => []);
    await expect(commitMediaUploadSessionByToken("t0ken")).rejects.toThrow(/no longer available/u);
    // Nothing was deleted, so the ordinary abort path still finds the row and releases it.
    expect(db.find("DELETE FROM phis.media_upload_sessions")).toBeUndefined();
    expect(db.texts()).toContain("ROLLBACK");
    expect(db.release).toHaveBeenCalled();
  });
});

/*
 * The other half of the same contract: the writer repairs, the reader discounts. If they disagreed, a
 * Space would report capacity that the next request refuses -- or the other way round.
 */
describe("What a reader is told is reserved", () => {
  it("discounts the sessions that expired without anyone coming back", async () => {
    const db = pool(() => []);
    await getMediaSpaceById(31, 5);
    const statement = db.statements[0].text;
    expect(statement).toMatch(/GREATEST\(0, reserved_bytes - COALESCE\(\(/u);
    expect(statement).toMatch(/FROM phis\.media_upload_sessions u/u);
    expect(statement).toMatch(/u\.expires_at < NOW\(\)/u);
  });

  it("is the same amount the next reservation is measured against", async () => {
    const db = pool(() => []);
    await reserveMediaSpaceQuota({ spaceId: 5, bytes: 1024 });
    const statement = db.statements[0].text;
    expect(statement).toMatch(/s\.used_bytes \+ GREATEST\(0, s\.reserved_bytes - COALESCE\(/u);
    expect(statement).toMatch(/u\.expires_at < NOW\(\)/u);
    // The counter is still raised by the raw amount: releasing dead bytes belongs to the statement
    // that also removes their rows, and doing it here would free them a second time.
    expect(statement).toMatch(/SET reserved_bytes = s\.reserved_bytes \+ \$2/u);
  });

  it("reaches every surface that reports a Space", async () => {
    const source = await read("src/db/media-spaces.ts");
    for (const reader of [
      "export async function ensureSiteMediaSpace",
      "export async function listAuthorizedMediaSpaces",
      "export async function getMediaSpaceById",
      "export async function getGroupMediaSpace",
      "export async function ensureUserMediaSpace",
      "export async function setMediaSpaceQuotaBytes",
    ]) {
      const start = source.indexOf(reader);
      expect(start, reader).toBeGreaterThan(-1);
      const body = source.slice(start, source.indexOf("\n}\n", start));
      expect(body, reader).toMatch(/liveReservedBytes\(/u);
    }
  });
});
