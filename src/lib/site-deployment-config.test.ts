import { describe, expect, it } from "vitest";

import { buildNginxConfig, buildSystemdUnit, type SiteDeploymentRecord } from "./site-deployment-config.ts";

const site: SiteDeploymentRecord = { id: 7, key: "acme-shop", name: "ACME", hostname: "www.acme.test" };
const settings = {
  basePort: 52000,
  overrides: {
    "acme-shop": {
      instances: [
        { host: "localhost", port: 52007, path: "/var/www/phis/sites/acme-shop" },
        { host: "10.0.0.2", port: 52017, path: "/var/www/phis/sites/acme-shop-2" },
      ],
    },
  },
};

describe("the generated nginx configuration", () => {
  /*
   * The phis-host README's finding: with a pooled upstream, nginx must give idle connections up before
   * Node does, or a POST lands on a closed one and fails with 502.
   */
  it("pools every instance with a keep-alive below Node's", () => {
    const config = buildNginxConfig(site, settings);

    expect(config).toContain("upstream phis_site_acme_shop {");
    expect(config).toContain("  server 127.0.0.1:52007;");
    expect(config).toContain("  server 10.0.0.2:52017;");
    expect(config).toMatch(/keepalive \d+;/);
    expect(config).toContain("keepalive_timeout 4s;");
    expect(config).toContain("proxy_pass http://phis_site_acme_shop;");
    expect(config).toContain("proxy_http_version 1.1;");
  });

  it("upgrades a connection only when asked, and passes the host with its port", () => {
    const config = buildNginxConfig(site, settings);

    expect(config).toMatch(/map \$http_upgrade \$phis_site_acme_shop_connection \{\n {2}default upgrade;\n {2}"" {6}"";\n\}/);
    expect(config).toContain("proxy_set_header Connection $phis_site_acme_shop_connection;");
    expect(config).not.toContain('Connection "upgrade"');
    expect(config).toContain("proxy_set_header Host $http_host;");
    expect(config).toContain("proxy_set_header X-Forwarded-Host $http_host;");
    // The map and the pool belong to the http context, ahead of the server block that uses them.
    expect(config.indexOf("map ")).toBeLessThan(config.indexOf("server {"));
    expect(config.indexOf("upstream ")).toBeLessThan(config.indexOf("server {"));
  });
});

describe("the generated systemd unit", () => {
  it("is written for one instance at a time and says how to bound the render cache", () => {
    const first = buildSystemdUnit(site, settings);
    const second = buildSystemdUnit(site, settings, { instanceIndex: 1 });

    expect(first).toContain("WorkingDirectory=/var/www/phis/sites/acme-shop\n");
    expect(first).toContain("Environment=PORT=52007");
    expect(second).toContain("WorkingDirectory=/var/www/phis/sites/acme-shop-2\n");
    expect(second).toContain("Environment=PORT=52017");
    expect(first).toContain("#Environment=PHIS_RENDER_CACHE_MB=128");
    // A Site reports no readiness to drain; only Core's unit stops through `phis instance drain`.
    expect(first).not.toContain("ExecStop");
    expect(() => buildSystemdUnit(site, settings, { instanceIndex: 2 })).toThrow(/0 to 1/);
  });
});
