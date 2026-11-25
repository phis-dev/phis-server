import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type { Pool } from "pg";

import {
  PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES,
  PhisCdnAdminFlags,
  PhisCdnAdminWithdrawResultFlags,
  PhisCdnCheckObjectFlags,
  PhisCdnCheckReportFlags,
  PhisCdnFileOs,
} from "@phis/contracts/addon";

import { PhiTestCdnStorage } from "../../../../../../test/pg/cdn-fake-storage";
import {
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  readPhiTestSpaceBytes,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../../../../../test/pg/harness";

const configured = process.env.PHIS_PG_TEST === "1";

const state = vi.hoisted(() => ({
  site: null as null | { id: number; key: string },
  userId: 0,
  pending: [] as Promise<unknown>[],
  storage: null as null | { adapter(): unknown },
}));

vi.mock("@/lib/guards/site-admin-api", () => ({
  requireSiteMaintainerApiContext: async () => ({
    context: { site: state.site, session: { userId: state.userId }, siteRole: {}, tokenMode: null },
    error: null,
  }),
}));
vi.mock("@/lib/log", () => ({ logRuntimeEvent: () => {} }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (work: () => Promise<unknown>) => { state.pending.push(work()); },
}));
// The CDN of the test Site, read as the Server reads it, with the fake storage in place of the registry.
vi.mock("@/lib/cdn-server", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/cdn-server")>();
  const { readSiteCdn, readSiteCdnProfile } = await import("@/db/site-cdn.mts");
  const { getPool } = await import("@/lib/db");
  return {
    ...original,
    openPhisCdnTarget: async (siteId: number, siteKey?: string | null) => {
      const cdn = await readSiteCdn(getPool(), siteId);
      if (!cdn) return null;
      const profile = await readSiteCdnProfile(getPool(), siteId, { id: cdn.storageProfileId });
      return { siteId, siteKey: siteKey ?? state.site!.key, cdn, profile, storage: state.storage!.adapter() };
    },
  };
});

import { GET as LIST } from "./route";
import { POST as INIT } from "./uploads/route";
import { DELETE as ABORT, GET as STATE } from "./uploads/[token]/route";
import { PUT as PART } from "./uploads/[token]/parts/[partNumber]/route";
import { POST as HEARTBEAT } from "./uploads/[token]/heartbeat/route";
import { POST as COMPLETE } from "./uploads/[token]/complete/route";
import { DELETE as DELETE_FILE } from "./files/[name]/[version]/[file]/route";
import { POST as WITHDRAW } from "./files/[name]/[version]/[file]/withdraw/route";
import { POST as CHECK } from "./check/route";
import { POST as ADOPT } from "./check/adopt/route";

const BASE = "https://site.invalid/api/site/admin/cdn";
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const params = <T,>(value: T) => ({ params: Promise.resolve(value) });

function partDigests(bytes: Buffer) {
  const digests: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES) {
    digests.push(sha(bytes.subarray(offset, offset + PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES)));
  }
  return digests;
}

async function init(body: Record<string, unknown>) {
  const response = await INIT(new NextRequest(`${BASE}/uploads`, json(body)));
  return { status: response.status, body: await response.json() };
}

async function put(token: string, partNumber: number, bytes: Buffer) {
  const response = await PART(
    new NextRequest(`${BASE}/uploads/${token}/parts/${partNumber}`, { method: "PUT", body: bytes, duplex: "half" } as never),
    params({ token, partNumber: String(partNumber) }),
  );
  return { status: response.status, body: await response.json() };
}

async function complete(token: string) {
  const response = await COMPLETE(new NextRequest(`${BASE}/uploads/${token}/complete`, { method: "POST" }), params({ token }));
  const body = await response.json();
  await Promise.all(state.pending.splice(0));
  return { status: response.status, body };
}

async function readState(token: string) {
  const response = await STATE(new NextRequest(`${BASE}/uploads/${token}`), params({ token }));
  return { status: response.status, body: await response.json() };
}

describe.skipIf(!configured)("the CDN page's routes", () => {
  let pool: Pool;
  let site: PhiTestSite;
  const storage = new PhiTestCdnStorage();

  beforeAll(async () => {
    pool = await requirePhiTestDatabase();
    await storage.start();
    state.storage = storage;
  });

  beforeEach(async () => {
    site = await createPhiTestSite("cdnadmin");
    state.site = { id: site.id, key: site.key };
    state.userId = await createPhiTestUser(site);
    storage.reset();
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await storage.stop();
    await closePhiTestPool();
  });

  async function attach(checksumAlgorithm: string | null = "sha256") {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO phis.media_storage_profiles (site_id, key, provider_id, flags, checksum_algorithm)
       VALUES ($1, 'cdn', '@pgtest/storage/s3', 2, $2) RETURNING id`,
      [site.id, checksumAlgorithm],
    );
    await pool.query(
      `INSERT INTO phis.site_cdns (site_id, storage_profile_id, public_base_url) VALUES ($1, $2, 'https://cdn.example.invalid')`,
      [site.id, rows[0]!.id],
    );
  }

  it("lists nothing without a CDN, and 404 no_cdn for what needs one", async () => {
    const listed = await LIST(new NextRequest(BASE));
    expect(await listed.json()).toEqual({ cdn: null, files: [], total: 0, page: 1, pageSize: 50 });
    const refused = await init({ name: "a", version: "1", fileName: "a.zip", sizeBytes: 1, partSha256: [sha("a")] });
    expect(refused).toMatchObject({ status: 404, body: { error: "no_cdn" } });
    expect((await LIST(new NextRequest(`${BASE}?pageSize=201`))).status).toBe(400);
    expect((await LIST(new NextRequest(`${BASE}?state=gone`))).status).toBe(400);
  });

  it("uploads a file of one part, hashes it from the bucket and records it with origin upload", async () => {
    await attach();
    const bytes = Buffer.from("a small installer");
    const started = await init({
      name: "tool", version: "1.0", fileName: "tool.dmg", sizeBytes: bytes.length, partSha256: [sha(bytes)], os: PhisCdnFileOs.MacOS,
    });
    expect(started).toMatchObject({ status: 201, body: { state: "pending", key: "tool/1.0/tool.dmg", partCount: 1, uploaded: [] } });
    expect(await readPhiTestSpaceBytes(site.siteSpaceId)).toEqual({ used: 0, reserved: bytes.length });
    const token = started.body.token as string;

    expect(await put(token, 1, Buffer.from("wrong bytes, right length".slice(0, bytes.length))))
      .toMatchObject({ status: 422, body: { error: "part_rejected" } });
    expect(await put(token, 1, Buffer.from("short"))).toMatchObject({ status: 400, body: { error: "part_length" } });
    expect(await put(token, 1, bytes)).toMatchObject({ status: 200, body: { partNumber: 1, uploaded: 1 } });
    expect((await HEARTBEAT(new NextRequest(`${BASE}/uploads/${token}/heartbeat`, { method: "POST" }), params({ token }))).status).toBe(204);

    const completed = await complete(token);
    expect(completed).toMatchObject({ status: 202, body: { state: "hashing" } });
    const published = await readState(token);
    expect(published.body).toMatchObject({
      state: "published",
      file: { key: "tool/1.0/tool.dmg", sha256: sha(bytes), storage: "cdn", os: PhisCdnFileOs.MacOS, state: "offered",
        origin: { kind: "upload", actorUserId: state.userId, addonId: null, sourceUrl: null } },
    });
    expect(await readPhiTestSpaceBytes(site.siteSpaceId)).toEqual({ used: bytes.length, reserved: 0 });

    const listed = await (await LIST(new NextRequest(`${BASE}?q=too`))).json();
    expect(listed).toMatchObject({ cdn: { flags: PhisCdnAdminFlags.VerifiesSha256, profileKey: "cdn" }, total: 1 });
    expect((await init({ name: "tool", version: "1.0", fileName: "tool.dmg", sizeBytes: bytes.length, partSha256: [sha(bytes)] })))
      .toMatchObject({ status: 409, body: { error: "key_taken" } });
  });

  it("uploads in parts, carries an interrupted upload on, and refuses what does not fit", async () => {
    await attach();
    const size = PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES + 777;
    const bytes = Buffer.alloc(size);
    for (let index = 0; index < size; index += 1013) bytes[index] = index % 241;
    const digests = partDigests(bytes);
    const body = { name: "model", version: "2", fileName: "model.gguf", sizeBytes: size, partSha256: digests };

    expect(await init({ ...body, partSha256: [digests[0]] })).toMatchObject({ status: 400, body: { error: "part_digests" } });
    expect(await init({ ...body, fileName: "page.html" })).toMatchObject({ status: 415, body: { error: "content_type_refused" } });
    expect(await init({ ...body, version: "~2" })).toMatchObject({ status: 422, body: { error: "invalid_key" } });
    await pool.query(`UPDATE phis.site_media_config SET max_object_bytes = 1000 WHERE site_id = $1`, [site.id]);
    expect(await init(body)).toMatchObject({ status: 413, body: { error: "too_large" } });
    await pool.query(`UPDATE phis.site_media_config SET max_object_bytes = $2 WHERE site_id = $1`, [site.id, size * 4]);
    await pool.query(`UPDATE phis.media_spaces SET quota_bytes = 10 WHERE id = $1`, [site.siteSpaceId]);
    expect(await init(body)).toMatchObject({ status: 413, body: { error: "quota_exceeded" } });
    await pool.query(`UPDATE phis.media_spaces SET quota_bytes = NULL WHERE id = $1`, [site.siteSpaceId]);

    const started = await init(body);
    expect(started).toMatchObject({ status: 201, body: { partCount: 2, partSizeBytes: PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES } });
    const token = started.body.token as string;
    expect(await put(token, 2, bytes.subarray(PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES))).toMatchObject({ status: 200 });
    expect(await complete(token)).toMatchObject({ status: 409, body: { error: "parts_missing", uploaded: [2] } });

    // The page is reloaded and the same file chosen: the open upload carries on with what is there.
    const resumed = await init(body);
    expect(resumed).toMatchObject({ status: 200, body: { token, uploaded: [2] } });
    // Somebody else's upload of the key is busy, and not theirs to send parts to.
    const ownUser = state.userId;
    state.userId = await createPhiTestUser(site);
    expect(await init(body)).toMatchObject({ status: 409, body: { error: "busy" } });
    expect(await put(token, 1, bytes.subarray(0, PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES))).toMatchObject({ status: 403, body: { error: "not_your_upload" } });
    state.userId = ownUser;

    expect(await put(token, 1, bytes.subarray(0, PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES))).toMatchObject({ status: 200, body: { uploaded: 2 } });
    expect(await complete(token)).toMatchObject({ status: 202 });
    expect((await readState(token)).body).toMatchObject({ state: "published", file: { sizeBytes: size, sha256: sha(bytes) } });
    expect(storage.objects.get("model/2/model.gguf")?.body.equals(bytes)).toBe(true);
    expect(await readPhiTestSpaceBytes(site.siteSpaceId)).toEqual({ used: size, reserved: 0 });
  });

  it("finds bytes that are not the ones the page hashed where the storage does not check, and fails the upload", async () => {
    await attach(null);
    const bytes = Buffer.from("expected bytes");
    const started = await init({ name: "x", version: "1", fileName: "x.bin", sizeBytes: bytes.length, partSha256: [sha(bytes)] });
    const token = started.body.token as string;
    expect(await put(token, 1, Buffer.from("tampered bytes"))).toMatchObject({ status: 200 });
    await complete(token);
    expect((await readState(token)).body).toMatchObject({ state: "failed", error: { code: "checksum_mismatch" } });
    expect(storage.objects.size).toBe(0);
    expect(await readPhiTestSpaceBytes(site.siteSpaceId)).toEqual({ used: 0, reserved: 0 });
  });

  it("aborts an upload, giving its parts up and its reservation back", async () => {
    await attach();
    const size = PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES + 1;
    const bytes = Buffer.alloc(size, 5);
    const started = await init({ name: "y", version: "1", fileName: "y.bin", sizeBytes: size, partSha256: partDigests(bytes) });
    const token = started.body.token as string;
    const aborted = await ABORT(new NextRequest(`${BASE}/uploads/${token}`, { method: "DELETE" }), params({ token }));
    expect(aborted.status).toBe(204);
    expect(storage.uploads.size).toBe(0);
    expect(await readPhiTestSpaceBytes(site.siteSpaceId)).toEqual({ used: 0, reserved: 0 });
    expect((await readState(token)).body).toMatchObject({ state: "aborted" });
    expect((await ABORT(new NextRequest(`${BASE}/uploads/${token}`, { method: "DELETE" }), params({ token }))).status).toBe(409);
  });

  it("withdraws and deletes copies and links, checks the bucket and adopts what lies there", async () => {
    await attach();
    const bytes = Buffer.from("zip");
    const started = await init({ name: "a", version: "1", fileName: "a.zip", sizeBytes: bytes.length, partSha256: [sha(bytes)] });
    await put(started.body.token, 1, bytes);
    await complete(started.body.token);
    await pool.query(
      `WITH f AS (INSERT INTO phis.site_cdn_files (site_id, object_key, name, version, file_name, size_bytes, sha256, content_type, flags)
                  VALUES ($1, 'l/1/l.deb', 'l', '1', 'l.deb', 99, $2, 'application/vnd.debian.binary-package', 4) RETURNING id)
       INSERT INTO phis.site_cdn_file_origins (file_id, origin, addon_id, source_url)
       SELECT id, 3, '@pgtest/releases', 'https://github.com/x/l.deb' FROM f`,
      [site.id, sha("l")],
    );
    const key = (name: string, version: string, file: string) => params({ name, version, file });

    const withdrawn = await WITHDRAW(new NextRequest(`${BASE}/files/a/1/a.zip/withdraw`, { method: "POST" }), key("a", "1", "a.zip"));
    expect(await withdrawn.json()).toMatchObject({ file: { state: "withdrawn" }, flags: 0 });
    const again = await WITHDRAW(new NextRequest(`${BASE}/files/a/1/a.zip/withdraw`, { method: "POST" }), key("a", "1", "a.zip"));
    expect(await again.json()).toMatchObject({ flags: PhisCdnAdminWithdrawResultFlags.AlreadyWithdrawn });
    expect(storage.objects.has("a/1/a.zip")).toBe(true);

    const deleted = await DELETE_FILE(new NextRequest(`${BASE}/files/a/1/a.zip`, { method: "DELETE" }), key("a", "1", "a.zip"));
    expect(await deleted.json()).toMatchObject({ file: { state: "deleted", storage: "cdn" } });
    expect(storage.objects.has("a/1/a.zip")).toBe(false);
    const unlinked = await DELETE_FILE(new NextRequest(`${BASE}/files/l/1/l.deb`, { method: "DELETE" }), key("l", "1", "l.deb"));
    expect(await unlinked.json()).toMatchObject({ file: { state: "deleted", storage: "link", url: "https://github.com/x/l.deb" } });
    expect(await readPhiTestSpaceBytes(site.siteSpaceId)).toEqual({ used: 0, reserved: 0 });
    expect((await DELETE_FILE(new NextRequest(`${BASE}/files/x/1/x`, { method: "DELETE" }), key("x", "1", "x"))).status).toBe(404);
    expect((await WITHDRAW(new NextRequest(`${BASE}/files/a:b/1/x/withdraw`, { method: "POST" }), key("a:b", "1", "x"))).status).toBe(404);

    const all = await (await LIST(new NextRequest(`${BASE}?state=all&sort=name&dir=asc`))).json();
    expect(all.files.map((file: { key: string; state: string }) => [file.key, file.state])).toEqual([["a/1/a.zip", "deleted"], ["l/1/l.deb", "deleted"]]);

    storage.objects.set("c/2/c.tar", { body: Buffer.from("cc"), contentType: "application/x-tar" });
    const report = await (await CHECK(new NextRequest(`${BASE}/check`, { method: "POST" }))).json();
    expect(report).toEqual({
      flags: 0, objects: 1, recorded: 1, missing: [], sizeMismatch: [],
      unrecorded: [{ key: "c/2/c.tar", sizeBytes: 2, flags: PhisCdnCheckObjectFlags.Adoptable, reason: null }],
    });
    const adopted = await (await ADOPT(new NextRequest(`${BASE}/check/adopt`, json({ keys: ["c/2/c.tar", "a/1/a.zip", "n/1/none"] })))).json();
    expect(adopted).toEqual({
      adopted: ["c/2/c.tar"],
      refused: [{ key: "a/1/a.zip", reason: "the key is in the catalogue already" }, { key: "n/1/none", reason: "no object lies at the key" }],
    });
    const consistent = await (await CHECK(new NextRequest(`${BASE}/check`, { method: "POST" }))).json();
    expect(consistent.flags).toBe(PhisCdnCheckReportFlags.Consistent);
    expect(await readPhiTestSpaceBytes(site.siteSpaceId)).toEqual({ used: 2, reserved: 0 });
  });
});
