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

function buildProxyHeaderLines(extraHeaders: string[] = []) {
  return [
    "proxy_http_version 1.1;",
    "proxy_set_header Host $host;",
    "proxy_set_header Upgrade $http_upgrade;",
    'proxy_set_header Connection "upgrade";',
    "proxy_set_header X-Real-IP $remote_addr;",
    "proxy_set_header X-Forwarded-Host $host;",
    "proxy_set_header X-Forwarded-Proto $scheme;",
    "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    ...extraHeaders,
  ]
    .map((line) => `    ${line}`)
    .join("\n");
}

export function buildSystemdUnit(site: SiteDeploymentRecord, settings?: SiteDeploymentSettings) {
  const instance = resolvePrimaryInstance(site, settings);
  const port = requireInstancePort(instance, "systemd");
  return `[Unit]
Description=${site.name} site runtime
After=network.target

[Service]
User=phis
WorkingDirectory=${instance.path}
Environment=NODE_ENV=production
Environment=PORT=${port}
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

export function buildNginxConfig(
  site: SiteDeploymentRecord,
  settings?: SiteDeploymentSettings,
  options?: SiteRenderOptions,
) {
  const source =
    options?.useSource && hasSiteSourceOverride(site, settings)
      ? resolveSiteSource(site, settings)
      : null;
  const target = source ?? resolvePrimaryInstance(site, settings);
  const port = requireInstancePort(target, "nginx");
  const upstreamHost = isLocalHost(target.host) ? "127.0.0.1" : target.host;
  const upstreamUrl = `http://${upstreamHost}:${port}`;
  const hmrLocation = source
    ? `
  location = /_next/webpack-hmr {
    proxy_pass ${upstreamUrl};
${buildProxyHeaderLines([`proxy_set_header Origin ${upstreamUrl};`])}
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }
`
    : "";

  return `server {
  listen 80;
  server_name ${site.hostname};
  client_max_body_size ${DEFAULT_NGINX_CLIENT_MAX_BODY_SIZE};
${hmrLocation}

  location / {
    proxy_pass ${upstreamUrl};
${buildProxyHeaderLines()}
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
      return buildSystemdUnit(site, settings);
    case "docker-compose":
      return buildDockerCompose(site, settings);
    case "runtime":
      return buildCustomRuntimeNote(site, settings);
    default:
      return "";
  }
}
