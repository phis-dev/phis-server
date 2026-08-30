import { readFile } from "node:fs/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPool: vi.fn() }));

vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));

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
    const db = pool(() => [{ released: 3 }]);
    await expect(releaseExpiredMediaUploadSessions(5)).resolves.toBe(3);
    expect(db.statements).toHaveLength(1);
    const [statement] = db.statements;
    expect(statement.text).toMatch(/DELETE FROM phis\.media_upload_sessions/u);
    expect(statement.text).toMatch(/UPDATE phis\.media_spaces/u);
    expect(statement.text).toMatch(/reserved_bytes = GREATEST\(0, s\.reserved_bytes - f\.bytes\)/u);
    expect(statement.values).toEqual([5]);
  });

  it("touches only sessions of the Space that was asked, and only expired ones", async () => {
    const db = pool(() => []);
    await releaseExpiredMediaUploadSessions(5);
    expect(db.statements[0].text).toMatch(/WHERE space_id = \$1 AND expires_at < NOW\(\)/u);
  });

  it("reports nothing released when nothing had expired", async () => {
    pool(() => []);
    await expect(releaseExpiredMediaUploadSessions(5)).resolves.toBe(0);
  });

  it("does not go to the database for something that cannot be a Space", async () => {
    const db = pool();
    for (const spaceId of [0, -1, 1.5, Number.NaN]) {
      await expect(releaseExpiredMediaUploadSessions(spaceId)).resolves.toBe(0);
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
