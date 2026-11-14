import { describe, expect, it } from "vitest";

import {
  buildApacheConfig,
  buildNginxConfig,
  buildSystemdUnit,
  type SiteDeploymentRecord,
} from "./site-deployment-config.ts";

const site: SiteDeploymentRecord = { id: 7, key: "acme-shop", name: "ACME", hostname: "www.acme.test" };
const settings = {
  basePort: 52000,
  overrides: {
    "acme-shop": {
      instances: [
        { host: "localhost", port: 52007, path: "/srv/phis/instances/acme-shop" },
        { host: "10.0.0.2", port: 52017, path: "/srv/phis/instances/acme-shop-2" },
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

    expect(first).toContain("WorkingDirectory=/srv/phis/instances/acme-shop\n");
    expect(first).toContain("Environment=PORT=52007");
    expect(second).toContain("WorkingDirectory=/srv/phis/instances/acme-shop-2\n");
    expect(second).toContain("Environment=PORT=52017");
    expect(first).toContain("#Environment=PHIS_RENDER_CACHE_MB=128");
    // A Site reports no readiness to drain; only Core's unit stops through `phis instance drain`.
    expect(first).not.toContain("ExecStop");
    expect(() => buildSystemdUnit(site, settings, { instanceIndex: 2 })).toThrow(/0 to 1/);
  });
});

describe("the web server snippets behind TLS", () => {
  /*
   * A stage `phis proxy tls` serves over HTTPS: the Site's snippet for the same web server answers the
   * certificate challenge on 80, sends everything else to 443, and serves there with the Site's certificate.
   */
  it("serves nginx on 443 and redirects port 80, challenge excepted", () => {
    const plain = buildNginxConfig(site, settings);
    expect(plain).not.toContain("443");
    const tls = buildNginxConfig(site, settings, { tls: true });
    expect(tls).toContain("listen 443 ssl;");
    expect(tls).toContain("ssl_certificate /etc/letsencrypt/live/www.acme.test/fullchain.pem;");
    expect(tls).toContain("location ^~ /.well-known/acme-challenge/");
    expect(tls).toContain("certbot certonly --webroot -w /var/www/phis-acme -d www.acme.test");
    expect(tls).toContain("return 301 https://$host$request_uri;");
    // The proxy and the body limit move to the 443 server; port 80 only redirects.
    const [port80, port443] = tls.split("listen 443 ssl;");
    expect(port80).not.toContain("proxy_pass");
    expect(port443).toContain("proxy_pass http://phis_site_acme_shop;");
    expect(port443).toContain("client_max_body_size 2g;");
  });

  it("serves Apache on 443 and tells the runtime the request was encrypted", () => {
    const plain = buildApacheConfig(site, settings);
    expect(plain).not.toContain("*:443");
    expect(plain).not.toContain("X-Forwarded-Proto");
    const tls = buildApacheConfig(site, settings, { tls: true });
    const [port80, port443] = tls.split("<VirtualHost *:443>");
    expect(port80).toContain(String.raw`RedirectMatch permanent "^/(?!\.well-known/acme-challenge/)(.*)$" "https://www.acme.test/$1"`);
    expect(port80).not.toContain("ProxyPass");
    expect(port443).toContain("SSLCertificateFile /etc/letsencrypt/live/www.acme.test/fullchain.pem");
    expect(port443).toContain("ProxyPass / http://127.0.0.1:52007/");
    expect(port443).toContain('RequestHeader set X-Forwarded-Proto "https"');
  });
});
