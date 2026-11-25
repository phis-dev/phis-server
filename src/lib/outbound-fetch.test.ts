import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type http from "node:http";

import { describe, expect, it } from "vitest";

import {
  buildPhisCdnImportPolicy,
  fetchPhisOutbound,
  isPhisOutboundAddressBlocked,
  isPhisOutboundHtml,
  isPhisOutboundUrlAllowed,
  PhisOutboundFetchError,
  type PhisOutboundTransport,
} from "./outbound-fetch";

type Answer = { status: number; headers?: Record<string, string>; body?: string };

/**
 * A transport that answers from a script and records, for every hop, where the request was made and
 * which address its pinned `lookup` hands the socket.
 */
function scripted(answers: Record<string, Answer>) {
  const hops: { url: string; pinned: string; servername?: string }[] = [];
  const transport: PhisOutboundTransport = (url, options) => {
    const request = new EventEmitter() as unknown as http.ClientRequest & EventEmitter;
    let pinned = "";
    options.lookup(url.hostname, { all: false } as never, ((_error: unknown, address: string) => { pinned = address; }) as never);
    hops.push({ url: url.toString(), pinned, ...(options.servername ? { servername: options.servername } : {}) });
    Object.assign(request, {
      end() {
        const answer = answers[url.toString()] ?? { status: 404 };
        const body = new PassThrough();
        Object.assign(body, { statusCode: answer.status, headers: answer.headers ?? {}, socket: { setTimeout() {} } });
        queueMicrotask(() => {
          request.emit("response", body);
          body.end(answer.body ?? "");
        });
        return request;
      },
      destroy() { return request; },
    });
    return request;
  };
  return { hops, transport };
}

const PUBLIC = "140.82.121.4";
const resolveTo = (map: Record<string, string[]>) => async (host: string) =>
  (map[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

describe("addresses an outbound request never reaches", () => {
  it("refuses private, loopback, link-local, ULA, multicast and the mapped forms", () => {
    for (const address of [
      "10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1",
      "255.255.255.255", "::1", "::", "fe80::1", "fd00::1", "fc00::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
      "64:ff9b::a00:1", "2001:db8::1", "not-an-address",
    ]) {
      expect(isPhisOutboundAddressBlocked(address), address).toBe(true);
    }
    for (const address of [PUBLIC, "185.199.108.133", "2606:50c0:8000::154", "2a01:4f8:c17::1"]) {
      expect(isPhisOutboundAddressBlocked(address), address).toBe(false);
    }
  });
});

describe("fetchPhisOutbound under the CDN import policy", () => {
  const policy = buildPhisCdnImportPolicy(["github.com", "release-assets.githubusercontent.com"]);

  it("takes https on 443 to a listed host only, and no credentials", () => {
    expect(isPhisOutboundUrlAllowed("https://github.com/a/b", policy)).toBe(true);
    expect(isPhisOutboundUrlAllowed("https://github.com:443/a/b", policy)).toBe(true);
    expect(isPhisOutboundUrlAllowed("http://github.com/a/b", policy)).toBe(false);
    expect(isPhisOutboundUrlAllowed("https://github.com:8443/a/b", policy)).toBe(false);
    expect(isPhisOutboundUrlAllowed("https://user:secret@github.com/a/b", policy)).toBe(false);
    expect(isPhisOutboundUrlAllowed("https://evil.example.com/a/b", policy)).toBe(false);
    expect(isPhisOutboundUrlAllowed("https://GITHUB.com/a/b", policy)).toBe(true);
    expect(isPhisOutboundUrlAllowed("https://github.com/a/b", buildPhisCdnImportPolicy([]))).toBe(false);
  });

  it("follows redirects by hand and checks the host list on every hop", async () => {
    const { hops, transport } = scripted({
      "https://github.com/a/b": { status: 302, headers: { location: "https://release-assets.githubusercontent.com/x?sig=1" } },
      "https://release-assets.githubusercontent.com/x?sig=1": { status: 200, headers: { "content-type": "application/octet-stream" }, body: "bytes" },
    });
    const resolve = resolveTo({ "github.com": [PUBLIC], "release-assets.githubusercontent.com": ["185.199.108.133"] });
    const response = await fetchPhisOutbound("https://github.com/a/b", policy, { transport, resolve });
    expect(response.status).toBe(200);
    expect(response.redirects).toBe(1);
    expect(response.url).toBe("https://release-assets.githubusercontent.com/x?sig=1");
    expect(hops.map((hop) => hop.pinned)).toEqual([PUBLIC, "185.199.108.133"]);
    expect(hops[0]!.servername).toBe("github.com");
    response.discard();

    const off = scripted({ "https://github.com/a/b": { status: 301, headers: { location: "https://evil.example.com/b" } } });
    await expect(fetchPhisOutbound("https://github.com/a/b", policy, { transport: off.transport, resolve }))
      .rejects.toMatchObject({ code: "host-not-allowed" });
    expect(off.hops).toHaveLength(1);

    const downgrade = scripted({ "https://github.com/a/b": { status: 307, headers: { location: "http://github.com/b" } } });
    await expect(fetchPhisOutbound("https://github.com/a/b", policy, { transport: downgrade.transport, resolve }))
      .rejects.toMatchObject({ code: "host-not-allowed" });
  });

  it("stops after five redirects", async () => {
    const answers: Record<string, Answer> = {};
    for (let index = 0; index < 7; index += 1) {
      answers[`https://github.com/${index}`] = { status: 302, headers: { location: `/${index + 1}` } };
    }
    const { hops, transport } = scripted(answers);
    await expect(fetchPhisOutbound("https://github.com/0", policy, { transport, resolve: resolveTo({ "github.com": [PUBLIC] }) }))
      .rejects.toMatchObject({ code: "redirect-limit" });
    expect(hops).toHaveLength(6);

    answers["https://github.com/5"] = { status: 200, body: "ok" };
    const five = scripted(answers);
    const response = await fetchPhisOutbound("https://github.com/0", policy, { transport: five.transport, resolve: resolveTo({ "github.com": [PUBLIC] }) });
    expect(response.redirects).toBe(5);
    response.discard();
  });

  it("refuses a host any of whose addresses is private, and pins the connection to the one it checked", async () => {
    const { transport, hops } = scripted({ "https://github.com/a": { status: 200, body: "ok" } });
    await expect(fetchPhisOutbound("https://github.com/a", policy, { transport, resolve: resolveTo({ "github.com": [PUBLIC, "10.0.0.5"] }) }))
      .rejects.toMatchObject({ code: "address-refused" });
    await expect(fetchPhisOutbound("https://github.com/a", policy, { transport, resolve: resolveTo({ "github.com": ["127.0.0.1"] }) }))
      .rejects.toMatchObject({ code: "address-refused" });
    expect(hops).toHaveLength(0);

    // Rebinding: the second answer of DNS would be private. It is never asked: one resolution per hop,
    // and the socket's own lookup answers the checked address whatever DNS would say now.
    let calls = 0;
    const rebinding = async () => {
      calls += 1;
      return [{ address: calls === 1 ? PUBLIC : "127.0.0.1", family: 4 }];
    };
    const response = await fetchPhisOutbound("https://github.com/a", policy, { transport, resolve: rebinding });
    expect(calls).toBe(1);
    expect(hops).toEqual([{ url: "https://github.com/a", pinned: PUBLIC, servername: "github.com" }]);
    response.discard();

    await expect(fetchPhisOutbound("https://github.com/a", policy, { transport, resolve: resolveTo({}) }))
      .rejects.toMatchObject({ code: "dns-failed" });
  });

  it("is told an HTML answer apart", () => {
    expect(isPhisOutboundHtml({ "content-type": "text/html; charset=utf-8" })).toBe(true);
    expect(isPhisOutboundHtml({ "content-type": "application/octet-stream" })).toBe(false);
    expect(isPhisOutboundHtml({})).toBe(false);
  });

  it("throws its own error for an aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const { transport } = scripted({});
    const error = await fetchPhisOutbound("https://github.com/a", policy, {
      transport, resolve: resolveTo({ "github.com": [PUBLIC] }), signal: controller.signal,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PhisOutboundFetchError);
    expect((error as PhisOutboundFetchError).code).toBe("aborted");
  });
});

describe("fetchPhisOutbound under an open policy (external documents)", () => {
  const open = { protocols: ["https:", "http:"] as const, ports: "any" as const, hosts: null, maxRedirects: 3, headersTimeoutMs: 1000, idleTimeoutMs: 1000 };

  it("takes any public host and port, and still no local name or private address", async () => {
    expect(isPhisOutboundUrlAllowed("http://docs.example.com:8080/a.md", open)).toBe(true);
    expect(isPhisOutboundUrlAllowed("http://localhost/a.md", open)).toBe(false);
    expect(isPhisOutboundUrlAllowed("http://printer.local/a.md", open)).toBe(false);
    const { transport } = scripted({});
    await expect(fetchPhisOutbound("http://169.254.169.254/latest/meta-data", open, { transport }))
      .rejects.toMatchObject({ code: "address-refused" });
  });
});
