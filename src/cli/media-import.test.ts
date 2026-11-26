import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  formatMediaImportReport,
  importMediaFiles,
  readMediaImportFiles,
  readMediaImportText,
  toReportItem,
} from "./media-import.mts";
import { parsePhisMediaImportFolder, readPhisMediaImportFolderRequest } from "../lib/media-import.ts";

describe("phis media import: what is read before anything is sent", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "phis-media-import-"));
    writeFileSync(path.join(dir, "a.png"), "aaa");
    writeFileSync(path.join(dir, "b.png"), "bbbb");
    writeFileSync(path.join(dir, "empty.png"), "");
    mkdirSync(path.join(dir, "folder"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads every file with its size, relative to the working directory", () => {
    expect(readMediaImportFiles(["a.png", path.join(dir, "b.png")], dir)).toEqual([
      { file: "a.png", absolutePath: path.join(dir, "a.png"), bytes: 3 },
      { file: path.join(dir, "b.png"), absolutePath: path.join(dir, "b.png"), bytes: 4 },
    ]);
  });

  it("names every file it cannot send, and sends none of them", () => {
    let message = "";
    try {
      readMediaImportFiles(["a.png", "missing.png", "empty.png", "folder", "./a.png"], dir);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^Nothing was imported:/);
    expect(message).toContain("missing.png: no such file");
    expect(message).toContain("empty.png: empty");
    expect(message).toContain("folder: not a regular file");
    expect(message).toContain("./a.png: named twice");
    expect(() => readMediaImportFiles([], dir)).toThrow(/at least one file/);
  });

  it("reads --folder as an id when it is digits and as a path otherwise", () => {
    expect(parsePhisMediaImportFolder("42")).toEqual({ id: 42 });
    expect(parsePhisMediaImportFolder("Products/PhiVoice")).toEqual({ path: ["Products", "PhiVoice"] });
    expect(parsePhisMediaImportFolder("/2026/")).toEqual({ path: ["2026"] });
    expect(parsePhisMediaImportFolder("  Shop  pictures / Big ")).toEqual({ path: ["Shop pictures", "Big"] });
    expect(() => parsePhisMediaImportFolder("a//b")).toThrow(/not a Folder path/);
    expect(() => parsePhisMediaImportFolder("0")).toThrow(/not a Folder id/);
    expect(() => parsePhisMediaImportFolder("x".repeat(161))).toThrow(/longer than 160/);
  });

  it("is read by Core as exactly one of path or id", () => {
    expect(readPhisMediaImportFolderRequest({ path: ["A", "B"] })).toEqual({ path: ["A", "B"] });
    expect(readPhisMediaImportFolderRequest({ id: 7 })).toEqual({ id: 7 });
    for (const bad of [null, [], {}, { id: 0 }, { id: "7" }, { path: [] }, { path: ["A", ""] }, { path: ["A"], id: 1 }]) {
      expect(readPhisMediaImportFolderRequest(bad)).toBeNull();
    }
  });

  it("takes --alt and --title for every file, within the column", () => {
    expect(readMediaImportText(undefined, "alt")).toBeNull();
    expect(readMediaImportText("", "alt")).toBeNull();
    expect(readMediaImportText("A box", "alt")).toBe("A box");
    expect(() => readMediaImportText("x".repeat(256), "title")).toThrow(/--title is at most 255/);
  });
});

describe("phis media import: the report", () => {
  const folder = { id: 5, path: ["Products", "PhiVoice"] };

  it("is one item per file, refusals with their reason and no ids", () => {
    expect(toReportItem("a.png", { status: "created", assetId: 9, name: "a.png", contentType: "image/png", bytes: 3, folderId: 5 }, folder)).toEqual({
      file: "a.png", status: "created", assetId: 9, name: "a.png", contentType: "image/png", bytes: 3, folder,
    });
    expect(toReportItem("b.png", { status: "existing", assetId: 4, name: "old.png", contentType: "image/png", bytes: 4, folderId: 2, detail: "d" }, folder))
      .toMatchObject({ status: "existing", assetId: 4, folder: { id: 2, path: [] }, detail: "d" });
    expect(toReportItem("c.svg", { status: "refused", reason: "unsafe_svg_upload", detail: "no" }, folder)).toEqual({
      file: "c.svg", status: "refused", assetId: null, name: null, contentType: null, bytes: null, folder: null,
      reason: "unsafe_svg_upload", detail: "no",
    });
  });

  it("prints a short table, then what needs a sentence", () => {
    const text = formatMediaImportReport({
      site: "acme",
      folder: { ...folder, created: ["PhiVoice"] },
      refused: 1,
      items: [
        toReportItem("a.png", { status: "created", assetId: 9, name: "a.png", contentType: "image/png", bytes: 3, folderId: 5 }, folder),
        toReportItem("c.svg", { status: "refused", reason: "unsafe_svg_upload", detail: "SVG uploads must not contain script elements." }, folder),
      ],
    });
    expect(text.split("\n")).toEqual([
      'Made folder(s) "PhiVoice" in acme.',
      "STATUS   ASSET  FILE   TYPE       BYTES  FOLDER",
      "created  9      a.png  image/png  3      Products/PhiVoice",
      "refused  -      c.svg  -          -      -",
      "  c.svg: refused (unsafe_svg_upload): SVG uploads must not contain script elements.",
    ]);
  });
});

describe("phis media import: talking to Core", () => {
  let dir: string;
  let server: http.Server;
  let core: { apiBaseUrl: string; internalToken: string; siteKey: string };
  const seen: { url: string; headers: http.IncomingHttpHeaders; body: Buffer | null }[] = [];
  const big = Buffer.alloc(8 * 1024 * 1024, 7);

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "phis-media-import-http-"));
    writeFileSync(path.join(dir, "one.png"), "first");
    writeFileSync(path.join(dir, "two.svg"), "second");
    writeFileSync(path.join(dir, "big.bin"), big);
    server = http.createServer((request, response) => {
      const url = request.url ?? "";
      const answer = (value: unknown) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      // Core answers a refusal it can make from the length alone without reading the body.
      if (url.includes("name=big.bin")) {
        seen.push({ url, headers: request.headers, body: null });
        answer({ result: { status: "refused", reason: "media_asset_too_large", detail: "too large" } });
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks);
        seen.push({ url, headers: request.headers, body });
        if (url.startsWith("/api/v1/media/import/folder")) {
          answer({ result: { status: "ready", folderId: 11, path: ["Products"], created: ["Products"] } });
        } else if (url.includes("name=two.svg")) {
          answer({ result: { status: "refused", reason: "unsafe_svg_upload", detail: "script" } });
        } else {
          answer({ result: { status: "created", assetId: 21, name: "one.png", contentType: "image/png", bytes: body.byteLength, folderId: 11 } });
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    core = { apiBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, internalToken: "tok", siteKey: "acme" };
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves the Folder once, streams each file with its length, and reports every file in order", async () => {
    const report = await importMediaFiles(core, {
      files: readMediaImportFiles(["one.png", "two.svg", "big.bin"], dir),
      folder: { path: ["Products"] },
      alt: "Ä picture",
      title: null,
    });
    expect(report.items.map((item) => [item.file, item.status, item.assetId, item.reason ?? null])).toEqual([
      ["one.png", "created", 21, null],
      ["two.svg", "refused", null, "unsafe_svg_upload"],
      ["big.bin", "refused", null, "media_asset_too_large"],
    ]);
    expect(report.refused).toBe(2);
    expect(report.folder).toEqual({ id: 11, path: ["Products"], created: ["Products"] });

    const [folderCall, one] = seen;
    expect(folderCall!.url).toBe("/api/v1/media/import/folder");
    expect(JSON.parse(folderCall!.body!.toString())).toEqual({ path: ["Products"] });
    expect(folderCall!.headers["x-phis-token"]).toBe("tok");
    expect(folderCall!.headers["x-phis-site-key"]).toBe("acme");

    const query = new URL(one!.url, "http://x").searchParams;
    expect(Object.fromEntries(query)).toEqual({ name: "one.png", folder: "11", alt: "Ä picture" });
    expect(one!.headers["content-length"]).toBe("5");
    expect(one!.headers["content-type"]).toBe("application/octet-stream");
    expect(one!.body!.toString()).toBe("first");
    expect(seen[3]!.headers["content-length"]).toBe(String(big.byteLength));
  });

  it("stops before any file when Core refuses the Folder", async () => {
    const refusing = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ result: { status: "refused", reason: "media_folder_locked", detail: "locked" } }));
    });
    await new Promise<void>((resolve) => refusing.listen(0, "127.0.0.1", resolve));
    const at = { ...core, apiBaseUrl: `http://127.0.0.1:${(refusing.address() as AddressInfo).port}` };
    await expect(importMediaFiles(at, { files: readMediaImportFiles(["one.png"], dir), folder: { id: 3 }, alt: null, title: null }))
      .rejects.toThrow(/Nothing was imported: Core refused the folder \(media_folder_locked\)/);
    await new Promise((resolve) => refusing.close(resolve));
  });
});
