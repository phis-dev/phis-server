import { describe, expect, it } from "vitest";

import { assertPhiProxyDomain, renderPhiServerProxyConfig, requiredApacheModules, resolvePhiStageUnit } from "./proxy.mts";

const base = { domain: "api.example.com", ports: [5301] };

describe("server proxy config", () => {
  it("tells the server the scheme it is really served on", () => {
    expect(renderPhiServerProxyConfig({ ...base, kind: "apache", tls: false })).toContain('X-Forwarded-Proto "http"');
    const tls = renderPhiServerProxyConfig({ ...base, kind: "apache", tls: true });
    expect(tls).toContain('X-Forwarded-Proto "https"');
    expect(tls).not.toContain('X-Forwarded-Proto "http"');
    expect(tls).toContain("/etc/letsencrypt/live/api.example.com/fullchain.pem");
    expect(tls).toContain("ServerName api.example.com");
  });

  it("answers the certificate challenge itself, ahead of the proxy and the redirect", () => {
    const apache = renderPhiServerProxyConfig({ ...base, kind: "apache", tls: true });
    expect(apache).toContain("ProxyPass /.well-known/acme-challenge/ !");
    expect(apache).toContain(String.raw`"^/(?!\.well-known/acme-challenge/)(.*)$"`);
    const nginx = renderPhiServerProxyConfig({ ...base, kind: "nginx", tls: true });
    expect(nginx).toContain("location ^~ /.well-known/acme-challenge/");
    expect(nginx).toContain("listen 443 ssl;");
    expect(nginx).toContain("server 127.0.0.1:5301;");
  });

  it("names the Apache modules, ssl only with TLS", () => {
    expect(requiredApacheModules(false)).toEqual(["proxy", "proxy_http", "proxy_balancer", "lbmethod_byrequests", "headers"]);
    expect(requiredApacheModules(true)).toContain("ssl");
  });

  it("checks the domain and finds the stage's unit", () => {
    expect(assertPhiProxyDomain("API.Example.com")).toBe("api.example.com");
    expect(() => assertPhiProxyDomain("api.example.invalid/")).toThrow();
    expect(resolvePhiStageUnit("/srv/phis/stages/prod")).toBe("phis@prod.service");
    expect(resolvePhiStageUnit("/opt/elsewhere")).toBeNull();
  });
});
