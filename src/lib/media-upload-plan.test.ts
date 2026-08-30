import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  PhisLocalMediaStorageAdapter,
  resolvePhisMediaStorageConfig,
} from "@/lib/media-storage";
import {
  isPhiMediaUploadBodyProxied,
  PhiMediaUploadPlanKind,
  resolvePhiMediaUploadPlanKind,
} from "@/lib/media-upload-sessions";

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

const roots: string[] = [];
async function localAdapter() {
  const rootDir = await mkdtemp(join(tmpdir(), "phi-upload-plan-"));
  roots.push(rootDir);
  return new PhisLocalMediaStorageAdapter(resolvePhisMediaStorageConfig({ rootDir }));
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/*
 * The upload plan is the Provider-neutral half of the upload contract. Before it existed, "one PUT, to
 * our own route, with the file's content type" lived in the Client as knowledge rather than as an
 * answer -- true for Local storage and false for any Provider that takes a body directly, which is why
 * a second upload lifecycle would otherwise have been the only way to add one.
 */
describe("The plan Local storage issues", () => {
  it("asks for the body through Core, at the address Core named", async () => {
    const adapter = await localAdapter();
    const plan = await adapter.createUploadPlan({
      token: "t0ken",
      storageKey: "staging/t0ken",
      contentType: "image/png",
      sizeBytes: 70,
      expiresAt: "2026-08-26T00:00:00.000Z",
      proxyUploadUrl: "/api/site/media/uploads/t0ken",
    });
    expect(plan).toEqual({ kind: "proxy-stream", url: "/api/site/media/uploads/t0ken", method: "PUT" });
  });

  it("does not assemble a Core route of its own", async () => {
    const source = await read("src/lib/media-storage.ts");
    const local = source.slice(source.indexOf("class PhisLocalMediaStorageAdapter"));
    const fn = /async createUploadPlan[\s\S]*?\n  \}/u.exec(local);
    expect(fn).not.toBeNull();
    // Core owns its route table: the address is handed in, never built here.
    expect(fn![0]).toMatch(/input\.proxyUploadUrl/u);
    expect(fn![0]).not.toMatch(/\/api\//u);
  });
});

describe("Settling a staged upload", () => {
  it("answers with what actually landed", async () => {
    const adapter = await localAdapter();
    await adapter.putObject({
      storageKey: "staging/settled",
      body: Buffer.from("hello"),
      contentType: "text/plain",
    });
    const head = await adapter.completeUpload({ storageKey: "staging/settled" });
    expect(head).toMatchObject({ storageKey: "staging/settled", byteSize: 5, contentType: "text/plain" });
    expect(head!.etag).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("answers with nothing when no body ever arrived", async () => {
    const adapter = await localAdapter();
    await expect(adapter.completeUpload({ storageKey: "staging/never" })).resolves.toBeNull();
  });

  it("ignores a completion report, because it received the whole body itself", async () => {
    const adapter = await localAdapter();
    await adapter.putObject({
      storageKey: "staging/settled",
      body: Buffer.from("hello"),
      contentType: "text/plain",
    });
    const head = await adapter.completeUpload({
      storageKey: "staging/settled",
      completion: { parts: [{ number: 1, etag: "nonsense" }] },
    });
    expect(head).toMatchObject({ byteSize: 5 });
  });
});

describe("The plan a session was issued", () => {
  it("is persisted as the kind, not as the plan", async () => {
    expect(resolvePhiMediaUploadPlanKind("proxy-stream")).toBe(PhiMediaUploadPlanKind.ProxyStream);
    expect(resolvePhiMediaUploadPlanKind("presigned-put")).toBe(PhiMediaUploadPlanKind.PresignedPut);
    const ddl = await read("scripts/sql/001_create_phis.pgsql");
    expect(ddl).toMatch(/upload_plan_kind SMALLINT NOT NULL DEFAULT 1/u);
    expect(ddl).toMatch(/media_upload_sessions_plan_kind_check CHECK \(upload_plan_kind IN \(1, 2\)\)/u);
  });

  it("decides who may deliver the body", () => {
    expect(isPhiMediaUploadBodyProxied(PhiMediaUploadPlanKind.ProxyStream)).toBe(true);
    expect(isPhiMediaUploadBodyProxied(PhiMediaUploadPlanKind.PresignedPut)).toBe(false);
    // An unknown kind is not a proxy plan: a body arriving at Core under one would be unaccounted.
    expect(isPhiMediaUploadBodyProxied(99)).toBe(false);
  });
});

describe("The routes carry the plan rather than assuming one", () => {
  it("init answers with the plan and no bare upload URL", async () => {
    const route = await read("src/app/api/site/media/uploads/init/route.ts");
    expect(route).toMatch(/storageService\.createUploadPlan\(\{/u);
    expect(route).toMatch(/proxyUploadUrl: `\/api\/site\/media\/uploads\/\$\{token\}`/u);
    expect(route).toMatch(/\n\s+plan,\n/u);
    // `uploadUrl` was the implicit contract; it is gone rather than kept beside the plan.
    expect(route).not.toMatch(/uploadUrl:/u);
    // The plan is issued before the session exists, so the session can record which one it is.
    expect(route.indexOf("createUploadPlan")).toBeLessThan(route.indexOf("createMediaUploadSession({"));
  });

  it("the body route refuses a session that was told to deliver elsewhere", async () => {
    const route = await read("src/app/api/site/media/uploads/[token]/route.ts");
    expect(route).toMatch(/if \(!isPhiMediaUploadBodyProxied\(session\.uploadPlanKind\)\)/u);
    expect(route).toMatch(/upload_plan_mismatch/u);
    // The refusal comes before anything is stored.
    expect(route.indexOf("upload_plan_mismatch")).toBeLessThan(route.indexOf("putObjectStream"));
  });

  it("finalize settles with the Provider before it judges what landed", async () => {
    const route = await read("src/app/api/site/media/uploads/[token]/finalize/route.ts");
    const complete = route.indexOf("storageService.completeUpload({");
    expect(complete).toBeGreaterThan(-1);
    expect(complete).toBeLessThan(route.indexOf("upload_size_mismatch"));
    expect(complete).toBeLessThan(route.indexOf("media_asset_exists"));
    // The report travels through unread: Core validating it would be Core knowing that Provider.
    expect(route).toMatch(/completion: readUploadCompletion\(body\)/u);
    // Only the plan that streams through Core lets Core's own status stand as evidence.
    expect(route).toMatch(/isPhiMediaUploadBodyProxied\(session\.uploadPlanKind\) &&\s*\n\s*session\.status !== PhiMediaUploadSessionStatus\.Uploaded/u);
  });

  it("judges duplicates once, where every plan passes", async () => {
    const body = await read("src/app/api/site/media/uploads/[token]/route.ts");
    const finalize = await read("src/app/api/site/media/uploads/[token]/finalize/route.ts");
    expect(body).not.toMatch(/media_asset_exists/u);
    expect(finalize).toMatch(/media_asset_exists/u);
  });
});
