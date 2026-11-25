import { describe, expect, it } from "vitest";

import { resolvePhiUrlPort, shouldPhiInstallKeepTls } from "./install.mts";
import { renderPhiServerProxyConfig } from "./proxy.mts";

const domain = "api.example.com";

/*
 * phisys test, 2026-11-25: after `phis proxy tls`, the full install run again exited 0 and wrote the
 * Apache site as plain HTTP, its record from tls true to false. A repeated install fills gaps only.
 */
describe("phis install, run again over a proxy", () => {
  for (const kind of ["apache", "nginx"] as const) {
    it(`keeps HTTPS that phis proxy tls put in front of ${kind}`, () => {
      const tls = shouldPhiInstallKeepTls({ kind, domain, tls: true }, { kind, domain });
      expect(tls).toBe(true);
      const config = renderPhiServerProxyConfig({ kind, domain, tls, ports: [5301] });
      expect(config).toContain(`/etc/letsencrypt/live/${domain}/fullchain.pem`);
      expect(config).toContain(kind === "apache" ? "<VirtualHost *:443>" : "listen 443 ssl;");
    });

    it(`writes plain HTTP for ${kind} where no TLS proxy for this domain is recorded`, () => {
      expect(shouldPhiInstallKeepTls(null, { kind, domain })).toBe(false);
      expect(shouldPhiInstallKeepTls({ kind, domain, tls: false }, { kind, domain })).toBe(false);
      // Another domain's certificate does not cover this one, nor is the other web server's file this one.
      expect(shouldPhiInstallKeepTls({ kind, domain: "old.example.com", tls: true }, { kind, domain })).toBe(false);
      const other = kind === "apache" ? "nginx" : "apache";
      expect(shouldPhiInstallKeepTls({ kind: other, domain, tls: true }, { kind, domain })).toBe(false);
    });
  }

  it("checks an HTTPS address through the proxy on 443", () => {
    expect(resolvePhiUrlPort(new URL(`https://${domain}/operator/login`))).toBe("443");
    expect(resolvePhiUrlPort(new URL(`http://${domain}/operator/login`))).toBe("80");
    expect(resolvePhiUrlPort(new URL("http://127.0.0.1:5301/operator/login"))).toBe("5301");
  });
});
