import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The web server in front of the server itself: `phis proxy config` and `phis proxy tls`.
 *
 * The Debian package copies a template into `sites-available/phis.conf` with a placeholder host name and a
 * plain-HTTP `X-Forwarded-Proto`. On a real host three hand edits followed: the host name, the Apache modules
 * named only in a comment, and -- after `certbot --apache` copied the :80 virtual host to :443 --
 * `X-Forwarded-Proto "http"` in the copy, which tells the server every request came in unencrypted. This
 * writes the file for the domain and the scheme it is actually served on, so none of that is left.
 *
 * A Site's own proxy configuration is `phis site config nginx|apache`; this is only the server's.
 */

export type PhiProxyKind = "apache" | "nginx";

export type PhiServerProxyInput = {
  kind: PhiProxyKind;
  domain: string;
  tls: boolean;
  /** The loopback ports of the instances of this stage. */
  ports: readonly number[];
};

const APACHE_SITE = "/etc/apache2/sites-available/phis.conf";
/**
 * Where certbot's webroot challenge is answered from. Served by the web server itself on port 80, ahead of
 * the proxy and of the HTTPS redirect, so issuing and renewing need neither a certbot plugin nor an edit of
 * this file.
 */
export const PHI_ACME_WEBROOT = "/var/www/phis-acme";
const NGINX_SITE = "/etc/nginx/sites-available/phis.conf";
const NGINX_ENABLED = "/etc/nginx/sites-enabled/phis.conf";

export function readPhiProxyKind(value: string | null | undefined): PhiProxyKind {
  if (value === "apache" || value === "apache2") return "apache";
  if (value === "nginx") return "nginx";
  throw new Error(`"${value ?? ""}" is not a proxy this command writes: apache or nginx.`);
}

export function assertPhiProxyDomain(domain: string) {
  const value = domain.trim().toLowerCase();
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(value)) {
    throw new Error(`"${domain}" is not a host name, as api.example.com.`);
  }
  return value;
}

export function certificatePaths(domain: string) {
  const live = `/etc/letsencrypt/live/${domain}`;
  return { fullchain: `${live}/fullchain.pem`, privkey: `${live}/privkey.pem` };
}

/** The modules the Apache file needs, in the order `a2enmod` takes them. */
export function requiredApacheModules(tls: boolean) {
  return ["proxy", "proxy_http", "proxy_balancer", "lbmethod_byrequests", "headers", ...(tls ? ["ssl"] : [])];
}

export function renderPhiServerProxyConfig(input: PhiServerProxyInput) {
  return input.kind === "apache" ? renderApache(input) : renderNginx(input);
}

const HEADER = (input: PhiServerProxyInput, tool: string) => `# Written by \`phis proxy ${tool}\` for ${input.domain}${input.tls ? " over HTTPS" : ""}.
# Written again, as a whole, by the next \`phis proxy config\` or \`phis proxy tls\`: change those flags rather
# than this file, or keep a copy of your edits.
`;

function renderApache(input: PhiServerProxyInput) {
  const members = input.ports.map((port) => `  BalancerMember http://127.0.0.1:${port} ttl=4`).join("\n");
  const challenge = `  # certbot's webroot challenge (\`phis proxy tls\`), answered here rather than by phis.
  Alias /.well-known/acme-challenge/ ${PHI_ACME_WEBROOT}/.well-known/acme-challenge/
  <Directory ${PHI_ACME_WEBROOT}/.well-known/acme-challenge/>
    Require all granted
  </Directory>`;
  const proxy = (scheme: "http" | "https") => `  # The original Host reaches the runtime with its port, which the form relay compares against the
  # browser's Referer.
  ProxyPreserveHost On
  ProxyPass /.well-known/acme-challenge/ !
  ProxyPass / balancer://phis/
  ProxyPassReverse / balancer://phis/
  RequestHeader set X-Forwarded-Proto "${scheme}"`;
  const pool = `# \`ttl\` below Node's keep-alive timeout of 5 s, so a pooled connection Node has closed is never handed to
# a POST (phis-host README.md, "Web server in front of several instances").
<Proxy balancer://phis>
${members}
</Proxy>
`;
  if (!input.tls) {
    return `${HEADER(input, "config")}# Modules: a2enmod ${requiredApacheModules(false).join(" ")}

${pool}
<VirtualHost *:80>
  ServerName ${input.domain}

${challenge}

${proxy("http")}
</VirtualHost>
`;
  }
  const cert = certificatePaths(input.domain);
  return `${HEADER(input, "tls")}# Modules: a2enmod ${requiredApacheModules(true).join(" ")}

${pool}
<VirtualHost *:80>
  ServerName ${input.domain}

${challenge}

  # Everything but the challenge goes to HTTPS.
  RedirectMatch permanent "^/(?!\\.well-known/acme-challenge/)(.*)$" "https://${input.domain}/$1"
</VirtualHost>

<VirtualHost *:443>
  ServerName ${input.domain}

  SSLEngine on
  SSLCertificateFile ${cert.fullchain}
  SSLCertificateKeyFile ${cert.privkey}

${proxy("https")}
</VirtualHost>
`;
}

function renderNginx(input: PhiServerProxyInput) {
  const servers = input.ports.map((port) => `  server 127.0.0.1:${port};`).join("\n");
  const location = `  location / {
    proxy_pass http://phis;
    proxy_http_version 1.1;
    # \`$http_host\` rather than \`$host\`: the form relay compares it, port included, with the Referer.
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $phis_connection;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }`;
  const challenge = `  # certbot's webroot challenge (\`phis proxy tls\`), answered here rather than by phis.
  location ^~ /.well-known/acme-challenge/ {
    root ${PHI_ACME_WEBROOT};
  }`;
  const head = `${HEADER(input, input.tls ? "tls" : "config")}# In nginx's http context (Debian's sites-enabled/*), where \`map\` and \`upstream\` are allowed.

map $http_upgrade $phis_connection {
  default upgrade;
  ""      "";
}

upstream phis {
${servers}
  keepalive 64;
  # Below Node's keep-alive timeout of 5 s (phis-host README.md, "Web server in front of several instances").
  keepalive_timeout 4s;
}
`;
  if (!input.tls) {
    return `${head}
server {
  listen 80;
  server_name ${input.domain};

${challenge}

${location}
}
`;
  }
  const cert = certificatePaths(input.domain);
  return `${head}
server {
  listen 80;
  server_name ${input.domain};

${challenge}

  location / {
    return 301 https://$host$request_uri;
  }
}

server {
  listen 443 ssl;
  server_name ${input.domain};

  ssl_certificate ${cert.fullchain};
  ssl_certificate_key ${cert.privkey};

${location}
}
`;
}

/** The loopback ports this stage's instances listen on: `PORT` of the stage's `.env`, else the package's 5301. */
export function readPhiStagePorts(root: string): number[] {
  const envPath = path.join(root, ".env");
  if (existsSync(envPath)) {
    const match = /^PORT=(\d+)\s*$/mu.exec(readFileSync(envPath, "utf8"));
    if (match) return [Number(match[1])];
  }
  return [5301];
}

/** `phis@<stage>.service` for a root under `/srv/phis/stages/<stage>`; null for any other root. */
export function resolvePhiStageUnit(root: string) {
  const match = /^\/srv\/phis\/stages\/([a-z0-9_-]+)\/?$/u.exec(path.resolve(root));
  return match ? `phis@${match[1]}.service` : null;
}

export function isPhiProxyInstalled(kind: PhiProxyKind) {
  return kind === "apache"
    ? existsSync("/etc/apache2/sites-available") && commandExists("apache2ctl")
    : existsSync("/etc/nginx/sites-available") && commandExists("nginx");
}

/** Apache or nginx, whichever is installed here; null for neither, an error for both unless one is named. */
export function detectPhiProxyKind(named: string | null): PhiProxyKind | null {
  if (named) return readPhiProxyKind(named);
  const apache = isPhiProxyInstalled("apache");
  const nginx = isPhiProxyInstalled("nginx");
  if (apache && nginx) {
    throw new Error("Both Apache and nginx are installed: name the one in front of phis with --proxy apache|nginx.");
  }
  return apache ? "apache" : nginx ? "nginx" : null;
}

export function commandExists(command: string) {
  return spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

export type PhiCommandStep = { command: string; ok: boolean; output: string };

export function runPhiSystemCommand(command: string, args: readonly string[]): PhiCommandStep {
  const result = spawnSync(command, args, { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const step = { command: [command, ...args].join(" "), ok: result.status === 0, output };
  if (!step.ok) {
    throw new Error(`\`${step.command}\` failed${output ? `:\n${output}` : result.error ? `: ${result.error.message}` : "."}`);
  }
  return step;
}

/**
 * Writes the file, enables what it needs, checks the server's configuration and reloads it.
 *
 * Only on a host where that web server is installed -- the caller decides that with `isPhiProxyInstalled`.
 * A configuration the check refuses is not reloaded: the running server keeps serving what it had.
 */
export type PhiServerProxyApplyResult = {
  path: string;
  steps: PhiCommandStep[];
  content: string;
  /** The Apache modules this run switched on that were off before it; the ones removal may switch off. */
  enabledModules: string[];
};

function isApacheModuleEnabled(module: string) {
  return existsSync(`/etc/apache2/mods-enabled/${module}.load`);
}

export function applyPhiServerProxyConfig(input: PhiServerProxyInput): PhiServerProxyApplyResult {
  const steps: PhiCommandStep[] = [];
  const content = renderPhiServerProxyConfig(input);
  mkdirSync(path.join(PHI_ACME_WEBROOT, ".well-known", "acme-challenge"), { recursive: true, mode: 0o755 });
  if (input.kind === "apache") {
    const modules = requiredApacheModules(input.tls);
    // What a2enmod pulls in besides, as `proxy_balancer` pulls in `slotmem_shm`, is the run's too.
    const watched = [...modules, "slotmem_shm"];
    const offBefore = watched.filter((module) => !isApacheModuleEnabled(module));
    writeFileSync(APACHE_SITE, content, { mode: 0o644 });
    steps.push(runPhiSystemCommand("a2enmod", ["-q", ...modules]));
    const enabledModules = offBefore.filter(isApacheModuleEnabled);
    steps.push(runPhiSystemCommand("a2ensite", ["-q", "phis"]));
    steps.push(runPhiSystemCommand("apache2ctl", ["configtest"]));
    steps.push(runPhiSystemCommand("systemctl", ["reload-or-restart", "apache2"]));
    return { path: APACHE_SITE, steps, content, enabledModules };
  }
  writeFileSync(NGINX_SITE, content, { mode: 0o644 });
  if (!existsSync(NGINX_ENABLED)) {
    symlinkSync(NGINX_SITE, NGINX_ENABLED);
    steps.push({ command: `ln -s ${NGINX_SITE} ${NGINX_ENABLED}`, ok: true, output: "" });
  }
  steps.push(runPhiSystemCommand("nginx", ["-t"]));
  steps.push(runPhiSystemCommand("systemctl", ["reload-or-restart", "nginx"]));
  return { path: NGINX_SITE, steps, content, enabledModules: [] };
}

/**
 * What `phis proxy config --write` and `phis proxy tls` put on this host, kept in the stage they serve.
 *
 * Removal takes exactly this and nothing else: the file as it was written (an edited one is the operator's
 * and stays), the modules that were off before phis switched them on, the challenge directory, and the
 * certificate `proxy tls` obtained. Kept beside the stage's own configuration in
 * `config/phis-proxy.json`, because the proxy serves that stage's ports and goes when it goes. A host where
 * the file was written by hand, or by a release before this record existed, has none, and removal then
 * lists rather than guesses.
 */
export type PhiServerProxyRecord = {
  version: 1;
  kind: PhiProxyKind;
  domain: string;
  tls: boolean;
  path: string;
  /** The enabled link `proxy config` made (nginx) or `a2ensite` made (Apache). */
  enabledPath: string;
  sha256: string;
  enabledModules: string[];
  acmeWebroot: string;
  /** certbot's certificate name, which `proxy tls` makes the domain. */
  certificate: string | null;
  writtenAt: string;
};

export function resolvePhiProxyRecordPath(root: string) {
  return path.join(root, "config", "phis-proxy.json");
}

export function readPhiServerProxyRecord(root: string): PhiServerProxyRecord | null {
  const file = resolvePhiProxyRecordPath(root);
  if (!existsSync(file)) return null;
  const value = JSON.parse(readFileSync(file, "utf8")) as Partial<PhiServerProxyRecord>;
  if (value.version !== 1 || (value.kind !== "apache" && value.kind !== "nginx") || typeof value.path !== "string") {
    throw new Error(`${file} is not a proxy record this release reads.`);
  }
  return value as PhiServerProxyRecord;
}

function sha256(content: string | Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * The record after one more write: the file as it now is, and the modules and certificate of every earlier
 * run kept, since a second `proxy config` that found the modules on did not make them anybody else's.
 */
export function mergePhiServerProxyRecord(
  previous: PhiServerProxyRecord | null,
  input: { kind: PhiProxyKind; domain: string; tls: boolean; result: PhiServerProxyApplyResult; certificate?: string | null },
  now = new Date(),
): PhiServerProxyRecord {
  const sameHost = previous && previous.kind === input.kind;
  return {
    version: 1,
    kind: input.kind,
    domain: input.domain,
    tls: input.tls,
    path: input.result.path,
    enabledPath: input.kind === "apache" ? "/etc/apache2/sites-enabled/phis.conf" : NGINX_ENABLED,
    sha256: sha256(input.result.content),
    enabledModules: [...new Set([...(sameHost ? previous.enabledModules : []), ...input.result.enabledModules])],
    acmeWebroot: PHI_ACME_WEBROOT,
    certificate: input.certificate ?? (sameHost && previous.domain === input.domain ? previous.certificate : null),
    writtenAt: now.toISOString(),
  };
}

export function writePhiServerProxyRecord(root: string, record: PhiServerProxyRecord) {
  const file = resolvePhiProxyRecordPath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
  return file;
}

export type PhiProxyRemovalStep = { action: string; done: boolean; note?: string };

/**
 * What removing a recorded proxy would do on this host, read without changing anything.
 *
 * A file whose content is no longer what phis wrote stays: the operator changed it, and it is theirs.
 */
export function planPhiServerProxyRemoval(record: PhiServerProxyRecord) {
  const fileState = !existsSync(record.path)
    ? "missing" as const
    : sha256(readFileSync(record.path)) === record.sha256 ? "unchanged" as const : "changed" as const;
  let enabled = false;
  try {
    enabled = lstatSync(record.enabledPath).isSymbolicLink() &&
      path.resolve(path.dirname(record.enabledPath), readlinkSync(record.enabledPath)) === record.path;
  } catch {
    enabled = false;
  }
  return {
    record,
    fileState,
    enabled,
    modules: record.kind === "apache" ? record.enabledModules.filter(isApacheModuleEnabled) : [],
    acmeWebroot: existsSync(record.acmeWebroot) ? record.acmeWebroot : null,
    certificate: record.certificate && existsSync(`/etc/letsencrypt/renewal/${record.certificate}.conf`)
      ? record.certificate
      : null,
  };
}

export type PhiServerProxyRemovalPlan = ReturnType<typeof planPhiServerProxyRemoval>;

/**
 * Carries the plan out: disable the site, remove the file if it is still phis's, switch off the modules
 * phis switched on, check and reload, then the challenge directory and, unless kept, the certificate.
 *
 * Modules go only if the web server still passes its check without them; otherwise they are switched on
 * again and named, because another site took them up since.
 */
export function removePhiServerProxyConfig(plan: PhiServerProxyRemovalPlan, options: { keepCertificate: boolean }) {
  const steps: PhiProxyRemovalStep[] = [];
  const { record } = plan;
  const service = record.kind === "apache" ? "apache2" : "nginx";
  const check = () => record.kind === "apache"
    ? runPhiSystemCommand("apache2ctl", ["configtest"])
    : runPhiSystemCommand("nginx", ["-t"]);

  if (plan.enabled) {
    if (record.kind === "apache") runPhiSystemCommand("a2dissite", ["-q", path.basename(record.path, ".conf")]);
    else rmSync(record.enabledPath, { force: true });
    steps.push({ action: `disabled ${record.enabledPath}`, done: true });
  }
  if (plan.fileState === "unchanged") {
    rmSync(record.path, { force: true });
    steps.push({ action: `removed ${record.path}`, done: true });
  } else if (plan.fileState === "changed") {
    steps.push({ action: `kept ${record.path}`, done: false, note: "changed since phis wrote it" });
  }
  if (plan.modules.length > 0) {
    // Dependents ahead of what they depend on: `lbmethod_byrequests` before `proxy_balancer`, that before
    // `slotmem_shm`, and every `proxy_*` before `proxy`.
    const order = ["lbmethod_byrequests", "proxy_balancer", "slotmem_shm", "proxy_http", "proxy", "headers", "ssl"];
    const modules = [...plan.modules].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    runPhiSystemCommand("a2dismod", ["-q", "-f", ...modules]);
    try {
      check();
      steps.push({ action: `a2dismod ${modules.join(" ")}`, done: true });
    } catch {
      runPhiSystemCommand("a2enmod", ["-q", ...plan.modules]);
      steps.push({
        action: `kept modules ${plan.modules.join(" ")}`,
        done: false,
        note: "the web server's check failed without them; another site uses them",
      });
    }
  }
  if (plan.enabled || plan.fileState === "unchanged" || plan.modules.length > 0) {
    check();
    runPhiSystemCommand("systemctl", ["reload", service]);
    steps.push({ action: `reloaded ${service}`, done: true });
  }
  if (plan.acmeWebroot) {
    rmSync(plan.acmeWebroot, { recursive: true, force: true });
    steps.push({ action: `removed ${plan.acmeWebroot}`, done: true });
  }
  if (plan.certificate) {
    if (options.keepCertificate) {
      steps.push({ action: `kept certificate ${plan.certificate}`, done: false, note: "--keep-certificate" });
    } else {
      runPhiSystemCommand("certbot", ["delete", "--cert-name", plan.certificate, "--non-interactive"]);
      steps.push({ action: `certbot delete --cert-name ${plan.certificate}`, done: true });
    }
  }
  return steps;
}

/**
 * A certificate for the server's domain, by certbot's webroot challenge.
 *
 * The proxy file already answers `/.well-known/acme-challenge/` from `PHI_ACME_WEBROOT` on port 80, so
 * certbot needs no web server plugin and touches no configuration. Renewal stays certbot's (its timer),
 * with a deploy hook that reloads the web server so the renewed certificate is used.
 */
export function obtainPhiCertificate(input: { kind: PhiProxyKind; domain: string; email: string | null }) {
  if (!commandExists("certbot")) {
    throw new Error("certbot is not installed: apt install certbot");
  }
  mkdirSync(path.join(PHI_ACME_WEBROOT, ".well-known", "acme-challenge"), { recursive: true, mode: 0o755 });
  return runPhiSystemCommand("certbot", [
    "certonly",
    "--webroot",
    "-w", PHI_ACME_WEBROOT,
    "-d", input.domain,
    "--non-interactive",
    "--agree-tos",
    ...(input.email ? ["-m", input.email] : ["--register-unsafely-without-email"]),
    "--keep-until-expiring",
    "--deploy-hook", `systemctl reload ${input.kind === "apache" ? "apache2" : "nginx"}`,
  ]);
}

/**
 * `applyPhiServerProxyConfig`, and the record of it in the stage it serves, so `phis stage remove` can take
 * exactly that away again. Every writer goes through this: `proxy config --write`, `proxy tls` and
 * `phis install`.
 */
export function applyAndRecordPhiServerProxyConfig(
  root: string,
  input: PhiServerProxyInput,
  options: { certificate?: string | null } = {},
) {
  const result = applyPhiServerProxyConfig(input);
  const record = mergePhiServerProxyRecord(readPhiServerProxyRecord(root), {
    kind: input.kind,
    domain: input.domain,
    tls: input.tls,
    result,
    certificate: options.certificate,
  });
  return { ...result, record, recordPath: writePhiServerProxyRecord(root, record) };
}
