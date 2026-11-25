import { describe, expect, it } from "vitest";

import { renderPhisCdnNginxConfig } from "../cli/cdn.mts";
import { PHIS_CDN_FILE_ARCH_MASK, PHIS_CDN_FILE_OS_MASK, PhisCdnFileArch, PhisCdnFileOs } from "@phis/contracts/addon";

import {
  buildPhisCdnKey,
  encodePhisCdnPlatformFlags,
  guessPhisCdnPlatform,
  namePhisCdnPlatform,
  PHIS_CDN_FILE_STATE_MASK,
  PhisCdnFileFlags,
  phisCdnPublicUrl,
  presentPhisCdnAdminFile,
  presentPhisCdnFile,
  readPhisCdnArchNames,
  readPhisCdnFileArch,
  readPhisCdnFileOs,
  readPhisCdnFileState,
  readPhisCdnKey,
  readPhisCdnOsNames,
  readPhisCdnPublicBaseUrl,
  resolvePhisCdnContentType,
  type PhisCdnFileRow,
} from "./cdn-core";

describe("CDN keys", () => {
  it("reads <name>/<version>/<file> and nothing else", () => {
    expect(readPhisCdnKey("qwen-asr/1.0.0/model.safetensors")).toEqual({
      key: "qwen-asr/1.0.0/model.safetensors", name: "qwen-asr", version: "1.0.0", fileName: "model.safetensors",
    });
    expect(readPhisCdnKey("a/b")).toBeNull();
    expect(readPhisCdnKey("a/b/c/d")).toBeNull();
    expect(readPhisCdnKey(".hidden/1/x")).toBeNull();
    expect(readPhisCdnKey("a/1/with space")).toBeNull();
  });

  it("refuses the reserved name and bad segments with the flag that carried them", () => {
    expect(() => buildPhisCdnKey("api", "v1", "tr")).toThrow(/reserved/u);
    expect(() => buildPhisCdnKey("ok", "../1", "x.bin")).toThrow(/--version/u);
    expect(buildPhisCdnKey("whisper", "3.1+cpu", "model.bin").key).toBe("whisper/3.1+cpu/model.bin");
  });

  it("takes a tilde after the first character, and a colon in the version alone", () => {
    expect(readPhisCdnKey("phis/0.8.1~beta.1-1/phis_0.8.1~beta.1-1+noble_amd64.deb")?.version).toBe("0.8.1~beta.1-1");
    expect(readPhisCdnKey("phis/1:2.0-1/phis_2.0-1_amd64.deb")?.version).toBe("1:2.0-1");
    expect(readPhisCdnKey("a:b/1/x.bin")).toBeNull();
    expect(readPhisCdnKey("a/1/x:y.bin")).toBeNull();
    expect(readPhisCdnKey("~a/1/x.bin")).toBeNull();
    expect(readPhisCdnKey("a/:1/x.bin")).toBeNull();
    expect(readPhisCdnKey("a/~1/x.bin")).toBeNull();
    expect(() => buildPhisCdnKey("phis", "1:2.0", "x:y.deb")).toThrow(/the file name/u);
    expect(() => buildPhisCdnKey("a:b", "1", "x")).toThrow(/--name/u);
    expect(buildPhisCdnKey("phis", "1:2.0~rc1", "p~1.deb").key).toBe("phis/1:2.0~rc1/p~1.deb");
  });

  it("encodes each segment of the public address", () => {
    expect(phisCdnPublicUrl("https://cdn.phis.dev", "m/1+x/a+b.bin")).toBe("https://cdn.phis.dev/m/1%2Bx/a%2Bb.bin");
  });

  it("stores the public base as https without a trailing slash, a path allowed", () => {
    expect(readPhisCdnPublicBaseUrl("https://cdn.phis.dev/")).toBe("https://cdn.phis.dev");
    expect(readPhisCdnPublicBaseUrl("https://files.example.com/phis/")).toBe("https://files.example.com/phis");
    expect(() => readPhisCdnPublicBaseUrl("http://cdn.phis.dev")).toThrow(/https/u);
    expect(() => readPhisCdnPublicBaseUrl("https://cdn.phis.dev/?x=1")).toThrow(/query/u);
  });
});

describe("CDN content types", () => {
  it("takes the stated type, else the extension's, else octet-stream", () => {
    expect(resolvePhisCdnContentType("model.gguf")).toBe("application/octet-stream");
    expect(resolvePhisCdnContentType("phis.deb")).toBe("application/vnd.debian.binary-package");
    expect(resolvePhisCdnContentType("clip.mp4")).toBe("video/mp4");
    expect(resolvePhisCdnContentType("noextension")).toBe("application/octet-stream");
    expect(resolvePhisCdnContentType("data.bin", "application/x-custom")).toBe("application/x-custom");
  });

  it("refuses pages and scripts by extension and by type", () => {
    expect(() => resolvePhisCdnContentType("index.html")).toThrow(/\.html/u);
    expect(() => resolvePhisCdnContentType("logo.svg")).toThrow(/\.svg/u);
    expect(() => resolvePhisCdnContentType("app.mjs")).toThrow(/\.mjs/u);
    expect(() => resolvePhisCdnContentType("page.bin", "text/html; charset=utf-8")).toThrow(/text\/html/u);
    expect(() => resolvePhisCdnContentType("feed.bin", "application/atom+xml")).toThrow(/xml/u);
    expect(() => resolvePhisCdnContentType("x.bin", "not a type")).toThrow(/not a content type/u);
  });
});

describe("the CDN host's nginx file", () => {
  it("serves GET only, files cached for good and misses never, as a download, and redirects to https once TLS is on", () => {
    const plain = renderPhisCdnNginxConfig({ host: "cdn.example.com", upstream: "http://127.0.0.1:3912", tls: false });
    expect(plain).toContain("limit_except GET { deny all; }");
    expect(plain).toContain("proxy_pass http://127.0.0.1:3912;");
    expect(plain).toContain("map $status $phis_cdn_cache_cdn_example_com {");
    expect(plain).toContain("    200 \"public, max-age=31536000, immutable\";");
    expect(plain).toContain("    default \"no-store\";");
    expect(plain).toContain("add_header Cache-Control $phis_cdn_cache_cdn_example_com always;");
    expect(plain).toContain("Content-Disposition \"attachment\"");
    expect(plain).toContain("nosniff");
    expect(plain).toContain("/.well-known/acme-challenge/");
    expect(plain).not.toContain("443");

    const tls = renderPhisCdnNginxConfig({ host: "cdn.example.com", upstream: "http://127.0.0.1:3912", tls: true });
    expect(tls).toContain("return 301 https://$host$request_uri;");
    expect(tls).toContain("/etc/letsencrypt/live/cdn.example.com/fullchain.pem");
    expect(tls).toContain("Strict-Transport-Security");
  });
});

describe("the flags of a catalogue row", () => {
  it("keeps the state in bits 0-7, the systems in 8-15 and the architectures in 16-23", () => {
    expect([PhisCdnFileFlags.Withdrawn, PhisCdnFileFlags.Deleted, PhisCdnFileFlags.Linked]).toEqual([1, 2, 4]);
    const flags = PhisCdnFileFlags.Linked | encodePhisCdnPlatformFlags(PhisCdnFileOs.Linux | PhisCdnFileOs.Other, PhisCdnFileArch.RiscV64);
    expect(flags).toBe(4 | (1 << 8) | (1 << 15) | (1 << 20));
    expect(flags & PHIS_CDN_FILE_STATE_MASK).toBe(PhisCdnFileFlags.Linked);
    expect(readPhisCdnFileOs(flags)).toBe(PhisCdnFileOs.Linux | PhisCdnFileOs.Other);
    expect(readPhisCdnFileArch(flags)).toBe(PhisCdnFileArch.RiscV64);
    expect(encodePhisCdnPlatformFlags(0, 0)).toBe(0);
    expect(() => encodePhisCdnPlatformFlags(1 << 6, 0)).toThrow(/PhisCdnFileOs/u);
    expect(() => encodePhisCdnPlatformFlags(0, 1 << 5)).toThrow(/PhisCdnFileArch/u);
    // The highest bit in use is 23: the column never reads negative.
    expect(encodePhisCdnPlatformFlags(PHIS_CDN_FILE_OS_MASK, PHIS_CDN_FILE_ARCH_MASK)).toBe(0x1fbf00);
  });

  it("names the state: deleted over withdrawn over offered", () => {
    expect(readPhisCdnFileState(0)).toBe("offered");
    expect(readPhisCdnFileState(PhisCdnFileFlags.Withdrawn)).toBe("withdrawn");
    expect(readPhisCdnFileState(PhisCdnFileFlags.Withdrawn | PhisCdnFileFlags.Deleted)).toBe("deleted");
  });

  it("reads --os and --arch names, and guesses the obvious from a file name", () => {
    expect(readPhisCdnOsNames("linux, macOS")).toBe(PhisCdnFileOs.Linux | PhisCdnFileOs.MacOS);
    expect(readPhisCdnArchNames("x64,arm64")).toBe(PhisCdnFileArch.X64 | PhisCdnFileArch.Arm64);
    expect(() => readPhisCdnOsNames("beos")).toThrow(/not one of/u);
    expect(namePhisCdnPlatform(PhisCdnFileOs.IOS, 0)).toEqual({ os: ["ios"], arch: [] });
    expect(guessPhisCdnPlatform("phis_0.8.1-1+trixie_amd64.deb")).toEqual({ os: PhisCdnFileOs.Linux, arch: PhisCdnFileArch.X64 });
    expect(guessPhisCdnPlatform("phis-0.8.1-1.aarch64.rpm")).toEqual({ os: PhisCdnFileOs.Linux, arch: PhisCdnFileArch.Arm64 });
    expect(guessPhisCdnPlatform("tool-x86_64.exe")).toEqual({ os: PhisCdnFileOs.Windows, arch: PhisCdnFileArch.X64 });
    expect(guessPhisCdnPlatform("App.dmg")).toEqual({ os: PhisCdnFileOs.MacOS, arch: 0 });
    expect(guessPhisCdnPlatform("app.apk")).toEqual({ os: PhisCdnFileOs.Android, arch: 0 });
    expect(guessPhisCdnPlatform("model.gguf")).toEqual({ os: 0, arch: 0 });
    // Two architectures named is none stated.
    expect(guessPhisCdnPlatform("fat-amd64-arm64.zip")).toEqual({ os: 0, arch: 0 });
  });
});

describe("presenting a catalogue row", () => {
  const row = (rest: Partial<PhisCdnFileRow> = {}): PhisCdnFileRow => ({
    id: 1, object_key: "phis/1/p.deb", name: "phis", version: "1", file_name: "p.deb", size_bytes: "3",
    sha256: "a".repeat(64), content_type: "application/vnd.debian.binary-package", flags: 0,
    published_at: "2026-11-25T10:00:00.000Z", origin: 1, origin_addon_id: null, origin_actor_user_id: null, source_url: null,
    ...rest,
  });

  it("answers a copy at the CDN's address and a link at its source's, with storage, os and arch", () => {
    expect(presentPhisCdnFile(row({ flags: encodePhisCdnPlatformFlags(PhisCdnFileOs.Linux, PhisCdnFileArch.X64) }), "https://cdn.example.com"))
      .toMatchObject({ url: "https://cdn.example.com/phis/1/p.deb", storage: "cdn", os: 1, arch: 1 });
    const link = row({ flags: PhisCdnFileFlags.Linked, origin: 3, origin_addon_id: "@phis/releases", source_url: "https://github.com/x/y/p.deb" });
    expect(presentPhisCdnFile(link, "https://cdn.example.com")).toMatchObject({ url: "https://github.com/x/y/p.deb", storage: "link" });
    expect(presentPhisCdnAdminFile(link, "https://cdn.example.com")).toMatchObject({
      state: "offered", origin: { kind: "addon", addonId: "@phis/releases", actorUserId: null, sourceUrl: "https://github.com/x/y/p.deb" },
    });
  });

  it("never reads a row without an origin as the CLI's", () => {
    expect(() => presentPhisCdnAdminFile(row({ origin: null }), "https://cdn.example.com")).toThrow(/origin sweep/u);
    expect(() => presentPhisCdnFile(row({ flags: PhisCdnFileFlags.Linked }), "https://cdn.example.com")).toThrow(/source address/u);
  });
});
