import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listModuleMedia, readModuleMediaPackages, syncModuleMedia } from "./module-media.mts";

const PKG = "@acme/pictures";
const PNG = Buffer.from("not-really-a-png");
const sha = (body: Buffer) => createHash("sha256").update(body).digest("hex");

let root: string;
let outside: string;

function writePackage(media: unknown, files: Record<string, Buffer> = { "dist/icon.png": PNG }) {
  const dir = path.join(root, "node_modules", "@acme", "pictures");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: PKG, phis: { media } }));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "phis-media-site-"));
  outside = mkdtempSync(path.join(tmpdir(), "phis-media-outside-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("reading the media a package declares from the Site's node_modules", () => {
  const files = [{ key: "icon", file: "dist/icon.png", alt: "Icon" }];

  it("resolves a declared file and hashes it", () => {
    writePackage({ files });
    const [entry] = readModuleMediaPackages(root, [PKG]);
    expect(entry!.issues).toEqual([]);
    expect(entry!.files[0]!.sha256).toBe(sha(PNG));
  });

  it("treats a package that is not installed as no fault", () => {
    expect(readModuleMediaPackages(root, [PKG])).toEqual([
      { packageName: PKG, installed: false, manifest: null, files: [], issues: [] },
    ]);
  });

  it("refuses a file that is missing, a directory, and a symlink that leaves the package root", () => {
    const dir = writePackage({
      files: [
        { key: "gone", file: "dist/gone.png", alt: "x" },
        { key: "dir", file: "dist", alt: "x" },
        { key: "link", file: "dist/link.png", alt: "x" },
        { key: "dirlink", file: "dist/linkdir/secret.png", alt: "x" },
      ],
    });
    writeFileSync(path.join(outside, "secret.png"), "secret");
    symlinkSync(path.join(outside, "secret.png"), path.join(dir, "dist", "link.png"));
    symlinkSync(outside, path.join(dir, "dist", "linkdir"));
    const [entry] = readModuleMediaPackages(root, [PKG]);
    const text = entry!.issues.join("\n");
    expect(text).toMatch(/file "gone".*does not exist/);
    expect(text).toMatch(/file "dir".*not a regular file/);
    expect(text).toMatch(/file "link".*outside the package root/);
    expect(text).toMatch(/file "dirlink".*outside the package root/);
    expect(entry!.files).toEqual([]);
  });

  it("accepts a symlink that stays inside the package", () => {
    const dir = writePackage({ files });
    symlinkSync(path.join(dir, "dist", "icon.png"), path.join(dir, "alias.png"));
    writePackageMediaOverride(dir, [{ key: "alias", file: "alias.png", alt: "x" }]);
    expect(readModuleMediaPackages(root, [PKG])[0]!.issues).toEqual([]);
  });

  function writePackageMediaOverride(dir: string, list: unknown) {
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: PKG, phis: { media: { files: list } } }));
  }
});

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };

describe("sync talks to Core over HTTP only", () => {
  let server: Server;
  let seen: Seen[];
  let mapping: unknown;
  let base: string;
  let answers: (url: string) => unknown;

  beforeEach(async () => {
    seen = [];
    mapping = { files: [], folders: [] };
    answers = (url) => {
      const key = /name="key"\r\n\r\n([^\r]+)/.exec(url)?.[1] ?? "?";
      return { result: { kind: "file", packageName: PKG, key, status: "created", assetId: 7 } };
    };
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("latin1");
        seen.push({ method: request.method!, url: request.url!, headers: request.headers, body });
        response.setHeader("content-type", "application/json");
        if (request.url === "/api/v1/module-media") return response.end(JSON.stringify(mapping));
        if (request.url === "/api/v1/module-media/folder") {
          return response.end(JSON.stringify({ result: { kind: "folder", packageName: PKG, key: "root", status: "created", folderId: 3 } }));
        }
        response.end(JSON.stringify(answers(body)));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;
    mkdirSync(path.join(root, "config"), { recursive: true });
    writeFileSync(path.join(root, "config", "site-runtime.json"), JSON.stringify({ phis: { apiBaseUrl: base, internalToken: "tok-test" } }));
    writePackage({
      folders: [{ key: "root", name: "Acme" }],
      files: [{ key: "icon", file: "dist/icon.png", folder: "root", alt: "Icon" }],
    });
  });
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("posts the folder and the file, with the token and the Site key, never a path", async () => {
    const report = await syncModuleMedia({ siteKey: "acme", siteRoot: root, packageNames: [PKG] });
    expect(report.items.map((item) => item.status)).toEqual(["created", "created"]);
    expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      "GET /api/v1/module-media",
      "POST /api/v1/module-media/folder",
      "POST /api/v1/module-media/file",
    ]);
    for (const entry of seen) {
      expect(entry.headers["x-phis-token"]).toBe("tok-test");
      expect(entry.headers["x-phis-site-key"]).toBe("acme");
    }
    const upload = seen[2]!.body;
    expect(upload).toContain("not-really-a-png");
    expect(upload).not.toContain(root);
    expect(upload).toMatch(/name="package"\r\n\r\n@acme\/pictures/);
    expect(upload).toMatch(/name="folder"\r\n\r\nroot/);
  });

  it("uploads nothing that Core already holds from the same bytes, nor a name bound by hand", async () => {
    mapping = {
      folders: [{ packageName: PKG, key: "root", folderId: 3, bound: false }],
      files: [{ packageName: PKG, key: "icon", assetId: 9, sourceChecksum: sha(PNG), bound: false }],
    };
    const report = await syncModuleMedia({ siteKey: "acme", siteRoot: root, packageNames: [PKG] });
    expect(report.items.map((item) => item.status)).toEqual(["unchanged", "unchanged"]);
    expect(seen).toHaveLength(1);

    seen.length = 0;
    mapping = {
      folders: [{ packageName: PKG, key: "root", folderId: 3, bound: true }],
      files: [{ packageName: PKG, key: "icon", assetId: 9, sourceChecksum: null, bound: true }],
    };
    const bound = await syncModuleMedia({ siteKey: "acme", siteRoot: root, packageNames: [PKG] });
    expect(bound.items.map((item) => item.status)).toEqual(["bound-left", "bound-left"]);
    expect(seen).toHaveLength(1);
  });

  it("posts a file whose row has no Asset or whose digest differs", async () => {
    mapping = {
      folders: [{ packageName: PKG, key: "root", folderId: 3, bound: false }],
      files: [{ packageName: PKG, key: "icon", assetId: 9, sourceChecksum: "0".repeat(64), bound: false }],
    };
    await syncModuleMedia({ siteKey: "acme", siteRoot: root, packageNames: [PKG] });
    expect(seen.map((entry) => entry.url)).toEqual(["/api/v1/module-media", "/api/v1/module-media/file"]);
  });

  it("returns a refusal in the report for the caller to fail on", async () => {
    answers = () => ({ result: { kind: "file", packageName: PKG, key: "icon", status: "refused", reason: "unsafe_svg_upload", detail: "no" } });
    const report = await syncModuleMedia({ siteKey: "acme", siteRoot: root, packageNames: [PKG] });
    expect(report.refused).toHaveLength(1);
  });

  it("stops on a manifest violation before any request, and without Core when nothing is declared", async () => {
    writePackage({ files: [{ key: "BAD", file: "dist/icon.png", alt: "x" }] });
    await expect(syncModuleMedia({ siteKey: "acme", siteRoot: root, packageNames: [PKG] })).rejects.toThrow(/invalid[\s\S]*BAD/);
    expect(seen).toHaveLength(0);

    writePackage(undefined);
    const none = await syncModuleMedia({ siteKey: "acme", siteRoot: root, packageNames: [PKG] });
    expect(none).toMatchObject({ declared: 0, items: [] });
    expect(seen).toHaveLength(0);
  });

  it("fails with a clear message when Core is not reachable", async () => {
    writeFileSync(path.join(root, "config", "site-runtime.json"), JSON.stringify({ phis: { apiBaseUrl: "http://127.0.0.1:1", internalToken: "t" } }));
    await expect(syncModuleMedia({ siteKey: "acme", siteRoot: root, packageNames: [PKG] })).rejects.toThrow(/not reachable/);
  });

  it("lists declared names and stored rows with their state", async () => {
    mapping = {
      folders: [{ packageName: PKG, key: "old-folder", folderId: 5, bound: false }],
      files: [
        { packageName: PKG, key: "icon", assetId: 9, sourceChecksum: null, bound: true },
        { packageName: PKG, key: "retired", assetId: 11, sourceChecksum: sha(PNG), bound: false },
      ],
    };
    const { rows } = await listModuleMedia({ siteKey: "acme", siteRoot: root, packageNames: [PKG] });
    expect(rows.map((row) => `${row.kind} ${row.key} ${row.state}`)).toEqual([
      "folder root missing",
      "file icon hand binding",
      "folder old-folder no longer declared",
      "file retired no longer declared",
    ]);
  });
});
