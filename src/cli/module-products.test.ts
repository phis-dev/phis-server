import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PhisSiteModuleProductFlag } from "../lib/module-products.ts";
import {
  describeModuleProductStates,
  readModuleProductPackages,
  syncModuleProducts,
} from "./module-products.mts";

const PKG = "@acme/site";

let root: string;

function writePackage(phis: unknown) {
  const dir = path.join(root, "node_modules", "@acme", "site");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: PKG, phis }));
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "phis-products-site-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("reading what a Site's packages propose", () => {
  it("reads phis.products, and a package that is not installed is no fault", () => {
    writePackage({ products: [{ key: "pro", title: "Pro" }] });
    expect(readModuleProductPackages(root, [PKG, "@acme/missing"])).toEqual([
      // A package that names no language is in en (PhisModulePackageDeclaration).
      { packageName: PKG, installed: true, proposals: [{ key: "pro", sourceLocale: "en", title: "Pro" }], issues: [] },
      { packageName: "@acme/missing", installed: false, proposals: [], issues: [] },
    ]);
    writePackage({ sourceLocale: "fr", modules: [], products: [{ key: "pro", title: "Édition Pro" }] });
    expect(readModuleProductPackages(root, [PKG])[0]!.proposals).toEqual([{ key: "pro", sourceLocale: "fr", title: "Édition Pro" }]);
  });

  it("says what each proposal came to from the recorded rows", () => {
    writePackage({ products: [{ key: "pro", title: "Pro" }, { key: "basic", title: "Basic" }, { key: "new", title: "New" }] });
    const rows = [
      { packageName: PKG, key: "pro", productKey: "acme.site.pro", flags: 0, createdAt: "x" },
      { packageName: PKG, key: "basic", productKey: "acme.site.basic", flags: PhisSiteModuleProductFlag.Found, createdAt: "x" },
      { packageName: PKG, key: "gone", productKey: "acme.site.gone", flags: 0, createdAt: "x" },
    ];
    expect(describeModuleProductStates(readModuleProductPackages(root, [PKG]), rows)).toEqual([
      { packageName: PKG, key: "pro", productKey: "acme.site.pro", state: "created" },
      { packageName: PKG, key: "basic", productKey: "acme.site.basic", state: "found" },
      { packageName: PKG, key: "new", productKey: "acme.site.new", state: "waiting" },
      { packageName: PKG, key: "gone", productKey: "acme.site.gone", state: "no longer proposed" },
    ]);
  });
});

describe("sync talks to Core over HTTP only", () => {
  let server: Server;
  let seen: { method: string; url: string; token: unknown; site: unknown; body: string }[];
  let rows: unknown[];
  let kept: unknown[];
  let base: string;

  beforeEach(async () => {
    seen = [];
    rows = [];
    kept = [];
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        seen.push({ method: request.method!, url: request.url!, token: request.headers["x-phis-token"], site: request.headers["x-phis-site-key"], body });
        response.setHeader("content-type", "application/json");
        if (request.method === "GET") return response.end(JSON.stringify({ rows, proposals: kept }));
        const posted = JSON.parse(body) as { package: string; proposal?: { key: string }; proposals?: { key: string }[] };
        if (posted.proposals) {
          return response.end(JSON.stringify({ results: posted.proposals.map((proposal) => ({
            packageName: posted.package, key: proposal.key, productKey: `acme.site.${proposal.key}`, status: "waiting", reason: "activation",
          })) }));
        }
        response.end(JSON.stringify({ result: { packageName: posted.package, key: posted.proposal!.key, productKey: `acme.site.${posted.proposal!.key}`, status: "created" } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    mkdirSync(path.join(root, "config"), { recursive: true });
    writeFileSync(path.join(root, "config", "site-runtime.json"), JSON.stringify({ phis: { apiBaseUrl: base, internalToken: "tok-test" } }));
  });
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("hands the package's proposals over, then posts each one not taken yet with the member it is taken as, and nothing for one that is", async () => {
    writePackage({ products: [{ key: "pro", title: "Pro" }, { key: "basic", title: "Basic" }] });
    rows = [{ packageName: PKG, key: "basic", productKey: "acme.site.basic", flags: 0, createdAt: "x" }];
    const report = await syncModuleProducts({ siteKey: "acme", siteRoot: root, packageNames: [PKG], as: "ops@acme.test" });
    expect(report.items.map((item) => `${item.key}:${item.status}`)).toEqual(["pro:created", "basic:taken"]);
    expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual(["GET /api/v1/module-products", "POST /api/v1/module-products", "POST /api/v1/module-products"]);
    // The hand-over carries the package's language on every proposal.
    expect(JSON.parse(seen[1]!.body)).toEqual({
      package: PKG, proposals: [{ key: "pro", sourceLocale: "en", title: "Pro" }, { key: "basic", sourceLocale: "en", title: "Basic" }],
    });
    expect(JSON.parse(seen[2]!.body)).toEqual({ package: PKG, proposal: { key: "pro", sourceLocale: "en", title: "Pro" }, as: "ops@acme.test" });
    for (const entry of seen) {
      expect(entry.token).toBe("tok-test");
      expect(entry.site).toBe("acme");
    }
  });

  it("without a member only hands the proposals over, each waiting for the Builder's activation", async () => {
    writePackage({ products: [{ key: "pro", title: "Pro" }] });
    const report = await syncModuleProducts({ siteKey: "acme", siteRoot: root, packageNames: [PKG] });
    expect(report.items).toEqual([{ packageName: PKG, key: "pro", productKey: "acme.site.pro", status: "waiting", reason: "activation" }]);
    expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual(["GET /api/v1/module-products", "POST /api/v1/module-products"]);
  });

  it("hands over nothing where no package proposes, clears what Core kept of a package that proposes none any more, and stops before any request on an invalid proposal", async () => {
    writePackage({ modules: [] });
    expect((await syncModuleProducts({ siteKey: "acme", siteRoot: root, packageNames: [PKG], as: "1" })).proposed).toBe(0);
    expect(seen.map((entry) => entry.method)).toEqual(["GET"]);
    kept = [{ packageName: PKG, key: "gone", waitingReason: null, waitingDetail: null }];
    await syncModuleProducts({ siteKey: "acme", siteRoot: root, packageNames: [PKG] });
    expect(seen.map((entry) => entry.method)).toEqual(["GET", "GET", "POST"]);
    expect(JSON.parse(seen[2]!.body)).toEqual({ package: PKG, proposals: [] });
    seen = [];
    writePackage({ products: [{ key: "pro" }] });
    await expect(syncModuleProducts({ siteKey: "acme", siteRoot: root, packageNames: [PKG], as: "1" })).rejects.toThrow(/proposals are invalid/);
    expect(seen).toEqual([]);
  });

  it("says why a proposal waits from what Core keeps of it", () => {
    writePackage({ products: [{ key: "a", title: "A" }, { key: "b", title: "B" }, { key: "c", title: "C" }] });
    const states = describeModuleProductStates(readModuleProductPackages(root, [PKG]), [], [
      { packageName: PKG, key: "b", waitingReason: null, waitingDetail: null },
      { packageName: PKG, key: "c", waitingReason: "supplier_refused", waitingDetail: "This needs the editor role." },
    ]);
    expect(states.map((row) => row.why)).toEqual([
      expect.stringContaining("not handed to Core yet"),
      expect.stringContaining(`activates ${PKG} in the Builder`),
      "supplier_refused: This needs the editor role.",
    ]);
  });
});
