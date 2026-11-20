import { describe, expect, it } from "vitest";

import { renderPhisCdnNginxConfig } from "../cli/cdn.mts";
import {
  buildPhisCdnKey,
  phisCdnPublicUrl,
  readPhisCdnKey,
  readPhisCdnPublicBaseUrl,
  resolvePhisCdnContentType,
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
