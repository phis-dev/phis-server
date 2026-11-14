/**
 * The TLS pieces of a web server file in front of phis: certbot's challenge, the HTTPS redirect and the
 * certificate lines.
 *
 * Shared by `phis proxy config|tls` for the server itself (src/cli/proxy.mts) and by a Site's snippet
 * (site-deployment-config.ts), so a Site behind the same web server is served the way the server is. Pure
 * strings: the operator's Sites panel renders these in the browser.
 */

export type PhiProxyKind = "apache" | "nginx";

/**
 * Where certbot's webroot challenge is answered from. Served by the web server itself on port 80, ahead of
 * the proxy and of the HTTPS redirect, so issuing and renewing need neither a certbot plugin nor an edit of
 * this file.
 */
export const PHI_ACME_WEBROOT = "/var/www/phis-acme";

export function certificatePaths(domain: string) {
  const live = `/etc/letsencrypt/live/${domain}`;
  return { fullchain: `${live}/fullchain.pem`, privkey: `${live}/privkey.pem` };
}

/** Apache: the challenge, served from `PHI_ACME_WEBROOT` inside a `:80` virtual host. */
export function renderApacheAcmeChallenge(tool: string) {
  return `  # certbot's webroot challenge (\`${tool}\`), answered here rather than by phis.
  Alias /.well-known/acme-challenge/ ${PHI_ACME_WEBROOT}/.well-known/acme-challenge/
  <Directory ${PHI_ACME_WEBROOT}/.well-known/acme-challenge/>
    Require all granted
  </Directory>`;
}

/** Apache: everything on `:80` but the challenge goes to HTTPS on the same host. */
export function renderApacheHttpsRedirect(domain: string) {
  return `  # Everything but the challenge goes to HTTPS.
  RedirectMatch permanent "^/(?!\\.well-known/acme-challenge/)(.*)$" "https://${domain}/$1"`;
}

/** Apache: the certificate lines of a `:443` virtual host. */
export function renderApacheSslLines(domain: string) {
  const cert = certificatePaths(domain);
  return `  SSLEngine on
  SSLCertificateFile ${cert.fullchain}
  SSLCertificateKeyFile ${cert.privkey}`;
}

/** nginx: the challenge, served from `PHI_ACME_WEBROOT` inside the `listen 80` server. */
export function renderNginxAcmeChallenge(tool: string) {
  return `  # certbot's webroot challenge (\`${tool}\`), answered here rather than by phis.
  location ^~ /.well-known/acme-challenge/ {
    root ${PHI_ACME_WEBROOT};
  }`;
}

/** nginx: everything on port 80 but the challenge goes to HTTPS. */
export function renderNginxHttpsRedirect() {
  return `  location / {
    return 301 https://$host$request_uri;
  }`;
}

/** nginx: the listen and certificate lines of the `443` server. */
export function renderNginxSslLines(domain: string) {
  const cert = certificatePaths(domain);
  return `  listen 443 ssl;
  server_name ${domain};

  ssl_certificate ${cert.fullchain};
  ssl_certificate_key ${cert.privkey};`;
}
