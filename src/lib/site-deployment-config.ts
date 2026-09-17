const DEFAULT_LOCAL_HOST = "localhost";
const DEFAULT_SOURCE_PATH_ROOT = "/opt/phis/sources";
const DEFAULT_INSTANCE_PATH_ROOT = "/var/www/phis/sites";
const DEFAULT_INSTANCE_PORT_BASE = 52000;
const DEFAULT_NGINX_CLIENT_MAX_BODY_SIZE = "2g";

export type SiteDeploymentRecord = {
  id: number;
  key: string;
  name: string;
  hostname: string;
  enabled?: boolean;
  publicBaseUrl?: string;
  supportEmail?: string;
  sourceLocale?: string;
  defaultLocale?: string;
  availableLocales?: Array<string | { code: string }>;
  mailFrom?: string;
  contactRecipient?: string;
};

export type SiteConfigTarget =
  | "nginx"
  | "apache"
  | "systemd"
  | "docker-compose"
  | "runtime";

export type SiteLocation = {
  host: string;
  port: number | null;
  path: string;
};

export type SiteRuntimeSummary = {
  db: {
    key: string;
    name: string;
    hostname: string;
    enabled: boolean;
    publicBaseUrl: string | null;
    supportEmail: string | null;
    defaultLocale: string | null;
    availableLocales: string[];
    mailFrom: string | null;
    contactRecipient: string | null;
  };
  config: {
    sourceLocale: string | null;
    source?: SiteLocation;
    instances: SiteLocation[];
  };
};

export type SiteSourceDefaults = {
  host?: string;
  port?: number;
  pathRoot?: string;
};

export type SiteInstanceDefaults = {
  host?: string;
  portBase?: number;
  pathRoot?: string;
};

export type SiteLocationOverride = {
  host?: string;
  port?: number;
  path?: string;
};

export type SiteDeploymentOverride = {
  sourceLocale?: string;
  source?: SiteLocationOverride;
  instances?: SiteLocationOverride[];
};

export type SiteDeploymentSettings = {
  sourcePathRoot?: string;
  instancePathRoot?: string;
  basePort?: number;
  overrides?: Record<string, SiteDeploymentOverride>;
};

export type SiteRenderOptions = {
  useSource?: boolean;
  /** Which instance a systemd unit is for, as `phis site config runtime` numbers them. */
  instanceIndex?: number;
};

function normalizeHost(host: string | undefined, fallback = DEFAULT_LOCAL_HOST) {
  const value = host?.trim();
  return value || fallback;
}

function normalizePathRoot(root: string | undefined, fallback: string) {
  const value = root?.trim();
  if (!value) {
    return fallback;
  }

  return value.replace(/\/+$/, "");
}

function resolveSiteOverride(site: SiteDeploymentRecord, settings?: SiteDeploymentSettings) {
  return settings?.overrides?.[site.key];
}

export function hasSiteSourceOverride(
  site: SiteDeploymentRecord,
  settings?: SiteDeploymentSettings,
) {
  const override = resolveSiteOverride(site, settings)?.source;
  return Boolean(override?.host?.trim() || override?.port || override?.path?.trim());
}

export function resolveSiteSource(
  site: SiteDeploymentRecord,
  settings?: SiteDeploymentSettings,
): SiteLocation {
  const override = resolveSiteOverride(site, settings)?.source;
  const path =
    override?.path?.trim() ||
    `${normalizePathRoot(settings?.sourcePathRoot, DEFAULT_SOURCE_PATH_ROOT)}/${site.key}`;
  const port =
    override?.port && Number.isInteger(override.port) && override.port > 0
      ? override.port
      : settings?.basePort && Number.isInteger(settings.basePort) && settings.basePort > 0
        ? settings.basePort + site.id
        : DEFAULT_INSTANCE_PORT_BASE + site.id;

  return {
    host: normalizeHost(override?.host),
    port,
    path,
  };
}

function buildDefaultInstance(site: SiteDeploymentRecord, settings?: SiteDeploymentSettings): SiteLocation {
  const portBase =
    settings?.basePort && Number.isInteger(settings.basePort) && settings.basePort > 0
      ? settings.basePort
      : DEFAULT_INSTANCE_PORT_BASE;
  return {
    host: DEFAULT_LOCAL_HOST,
    port: portBase + site.id,
    path: `${normalizePathRoot(settings?.instancePathRoot, DEFAULT_INSTANCE_PATH_ROOT)}/${site.key}`,
  };
}

export function resolveSiteInstances(
  site: SiteDeploymentRecord,
  settings?: SiteDeploymentSettings,
): SiteLocation[] {
  const overrideInstances = resolveSiteOverride(site, settings)?.instances;

  if (overrideInstances && overrideInstances.length > 0) {
    return overrideInstances.map((instance) => {
      const defaultInstance = buildDefaultInstance(site, settings);
      return {
        host: normalizeHost(instance.host ?? defaultInstance.host),
        port:
          instance.port && Number.isInteger(instance.port) && instance.port > 0
            ? instance.port
            : defaultInstance.port,
        path: instance.path?.trim() || defaultInstance.path,
      };
    });
  }

  return [buildDefaultInstance(site, settings)];
}

function isLocalHost(host: string) {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host.trim().toLowerCase());
}

export function resolvePrimaryInstance(
  site: SiteDeploymentRecord,
  settings?: SiteDeploymentSettings,
): SiteLocation {
  const instances = resolveSiteInstances(site, settings);
  const localInstance = instances.find((instance) => isLocalHost(instance.host));
  return localInstance ?? instances[0];
}

function requireInstancePort(instance: SiteLocation, target: SiteConfigTarget) {
  if (!instance.port) {
    throw new Error(`No port configured for ${target} target on ${instance.host}:${instance.path}.`);
  }

  return instance.port;
}

/** An nginx name for this Site: variable names allow letters, digits and `_` only. */
function nginxName(site: SiteDeploymentRecord) {
  return `phis_site_${site.key.replace(/[^a-z0-9_]/gi, "_")}`;
}

/**
 * The headers every proxied request carries.
 *
 * `Connection` comes from the `map` the snippet opens with: empty for an ordinary request, so the pooled
 * upstream connection stays open, and `upgrade` only when the browser asked for one. A constant
 * `Connection "upgrade"` would close every pooled connection after one request.
 *
 * `$http_host` rather than `$host`: on a port other than 80 or 443 `$host` drops the port the browser's
 * `Referer` keeps, and the Site's form relay compares the two and refuses every submit.
 */
function buildProxyHeaderLines(connectionVariable: string, extraHeaders: string[] = []) {
  return [
    "proxy_http_version 1.1;",
    "proxy_set_header Host $http_host;",
    "proxy_set_header Upgrade $http_upgrade;",
    `proxy_set_header Connection $${connectionVariable};`,
    "proxy_set_header X-Real-IP $remote_addr;",
    "proxy_set_header X-Forwarded-Host $http_host;",
    "proxy_set_header X-Forwarded-Proto $scheme;",
    "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    ...extraHeaders,
  ]
    .map((line) => `    ${line}`)
    .join("\n");
}

/**
 * The unit for a Site runtime, bound to the loopback interface.
 *
 * The nginx profile beside this one is what the outside is meant to reach, and it proxies to
 * `127.0.0.1`. Without `HOSTNAME` -- the variable the standalone server reads, not `HOST` -- Next binds
 * `0.0.0.0` and the runtime answers the network directly as
 * well -- on that path a caller sets `X-Real-IP` and `X-Forwarded-For` itself, so the address every
 * rate limit and audit record is keyed on becomes whatever it says. Binding to loopback is what makes
 * the proxy's headers worth reading.
 *
 * The container profile is deliberately not the same: there, `0.0.0.0` is the interface the sibling
 * container reaches, and the boundary is `expose` rather than the bind address.
 *
 * One unit per instance: a Site with several gets one for each, chosen by `instanceIndex`, each on its own
 * port and path. There is no stop step. `phis instance drain` withdraws the readiness a Core instance
 * reports to the database; a Site reports none, and the proxy stops sending to it when it stops
 * answering.
 */
export function buildSystemdUnit(
  site: SiteDeploymentRecord,
  settings?: SiteDeploymentSettings,
  options?: SiteRenderOptions,
) {
  const instances = resolveSiteInstances(site, settings);
  const instance = options?.instanceIndex === undefined
    ? resolvePrimaryInstance(site, settings)
    : instances[options.instanceIndex];
  if (!instance) {
    throw new Error(
      `Site ${site.key} has ${instances.length} instance(s); --instance takes 0 to ${instances.length - 1}.`,
    );
  }
  const port = requireInstancePort(instance, "systemd");
  return `[Unit]
Description=${site.name} site runtime (${instance.host}:${port})
After=network.target

[Service]
User=phis
WorkingDirectory=${instance.path}
Environment=NODE_ENV=production
Environment=HOSTNAME=127.0.0.1
Environment=PORT=${port}
# Rendered Public pages are kept in this process's memory, 128 MB unless set here. Every instance holds
# its own, so size the host for all of them.
#Environment=PHIS_RENDER_CACHE_MB=128
ExecStart=/usr/bin/node server.js
Restart=always

[Install]
WantedBy=multi-user.target`;
}

export function buildDockerCompose(site: SiteDeploymentRecord, settings?: SiteDeploymentSettings) {
  const instance = resolvePrimaryInstance(site, settings);
  const port = requireInstancePort(instance, "docker-compose");
  return `services:
  ${site.key}:
    image: ghcr.io/your-org/${site.key}:latest
    restart: always
    environment:
      NODE_ENV: production
      PORT: ${port}
      PHIS_SITE_KEY: ${site.key}
    expose:
      - "${port}"`;
}

/**
 * The nginx configuration for a Site: one pool over every instance, and the server block in front of it.
 *
 * The pool keeps connections to the instances open (`keepalive`), and its idle timeout sits below Node's
 * keep-alive timeout of 5 seconds. The other way round nginx sends a request down a connection Node has
 * just closed; a `GET` is retried on the next instance, a `POST` -- a form, a login, a publish -- fails
 * with 502. The phis-host README ("Web server in front of several instances") has the measurements.
 *
 * `map` and `upstream` are valid only in nginx's `http` context, so the output is one file included
 * there, which is what Debian's `sites-enabled/*` is. Their names carry the Site key, so the files of
 * several Sites can be included side by side.
 */
export function buildNginxConfig(
  site: SiteDeploymentRecord,
  settings?: SiteDeploymentSettings,
  options?: SiteRenderOptions,
) {
  const source =
    options?.useSource && hasSiteSourceOverride(site, settings)
      ? resolveSiteSource(site, settings)
      : null;
  const targets = source ? [source] : resolveSiteInstances(site, settings);
  const servers = targets.map((target) => {
    const port = requireInstancePort(target, "nginx");
    return `${isLocalHost(target.host) ? "127.0.0.1" : target.host}:${port}`;
  });
  const name = nginxName(site);
  const connection = `${name}_connection`;
  const hmrLocation = source
    ? `
  location = /_next/webpack-hmr {
    proxy_pass http://${name};
${buildProxyHeaderLines(connection, [`proxy_set_header Origin http://${servers[0]};`])}
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }
`
    : "";

  return `# Include in nginx's http context (on Debian: /etc/nginx/sites-available/, linked from sites-enabled/).
map $http_upgrade $${connection} {
  default upgrade;
  ""      "";
}

upstream ${name} {
${servers.map((server) => `  server ${server};`).join("\n")}
  keepalive 64;
  # Below Node's keep-alive timeout of 5 s; otherwise a POST can land on a connection Node closed and fail with 502.
  keepalive_timeout 4s;
}

server {
  listen 80;
  server_name ${site.hostname};
  client_max_body_size ${DEFAULT_NGINX_CLIENT_MAX_BODY_SIZE};
${hmrLocation}
  location / {
    proxy_pass http://${name};
${buildProxyHeaderLines(connection)}
  }
}`;
}

export function buildApacheConfig(site: SiteDeploymentRecord, settings?: SiteDeploymentSettings) {
  const instance = resolvePrimaryInstance(site, settings);
  const port = requireInstancePort(instance, "apache");
  return `<VirtualHost *:80>
  ServerName ${site.hostname}

  ProxyPreserveHost On
  ProxyPass / http://127.0.0.1:${port}/
  ProxyPassReverse / http://127.0.0.1:${port}/
</VirtualHost>`;
}

export function buildCustomRuntimeNote(
  site: SiteDeploymentRecord,
  settings?: SiteDeploymentSettings,
) {
  const summary = buildRuntimeSummary(site, settings);
  const instanceLines =
    summary.config.instances.length > 0
      ? summary.config.instances.map(
          (instance, index) =>
            `instance[${index}]: ${instance.host}:${instance.port ?? "-"}${instance.path}`,
        )
      : ["instance[0]: -"];
  const sourceLine = summary.config.source
    ? [`source: ${summary.config.source.host}:${summary.config.source.port ?? "-"}${summary.config.source.path}`]
    : [];

  return [
    `key: ${summary.db.key}`,
    `name: ${summary.db.name}`,
    `hostname: ${summary.db.hostname}`,
    `enabled: ${summary.db.enabled ? "true" : "false"}`,
    `publicBaseUrl: ${summary.db.publicBaseUrl ?? "-"}`,
    `supportEmail: ${summary.db.supportEmail ?? "-"}`,
    `sourceLocale: ${summary.config.sourceLocale ?? "-"}`,
    `defaultLocale: ${summary.db.defaultLocale ?? "-"}`,
    `availableLocales: ${summary.db.availableLocales.join(", ") || "-"}`,
    `mailFrom: ${summary.db.mailFrom ?? "-"}`,
    `contactRecipient: ${summary.db.contactRecipient ?? "-"}`,
    ...sourceLine,
    ...instanceLines,
  ].join("\n");
}

export function buildRuntimeSummary(
  site: SiteDeploymentRecord,
  settings?: SiteDeploymentSettings,
): SiteRuntimeSummary {
  const availableLocales = (site.availableLocales ?? []).map((entry) =>
    typeof entry === "string" ? entry : entry.code,
  );

  return {
    db: {
      key: site.key,
      name: site.name,
      hostname: site.hostname,
      enabled: site.enabled !== false,
      publicBaseUrl: site.publicBaseUrl ?? null,
      supportEmail: site.supportEmail ?? null,
      defaultLocale: site.defaultLocale ?? null,
      availableLocales,
      mailFrom: site.mailFrom ?? null,
      contactRecipient: site.contactRecipient ?? null,
    },
    config: {
      sourceLocale: site.sourceLocale ?? null,
      ...(hasSiteSourceOverride(site, settings)
        ? { source: resolveSiteSource(site, settings) }
        : {}),
      instances: resolveSiteInstances(site, settings),
    },
  };
}

export function renderSiteConfig(
  target: SiteConfigTarget,
  site: SiteDeploymentRecord,
  settings?: SiteDeploymentSettings,
  options?: SiteRenderOptions,
) {
  switch (target) {
    case "nginx":
      return buildNginxConfig(site, settings, options);
    case "apache":
      return buildApacheConfig(site, settings);
    case "systemd":
      return buildSystemdUnit(site, settings, options);
    case "docker-compose":
      return buildDockerCompose(site, settings);
    case "runtime":
      return buildCustomRuntimeNote(site, settings);
    default:
      return "";
  }
}
