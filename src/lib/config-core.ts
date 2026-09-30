import { readFileSync, renameSync, writeFileSync } from "node:fs";

export const PHIS_ROOT_ENV = "PHIS_ROOT";
export const PHIS_DEFAULT_STAGE_ROOT = "/srv/phis/stages/prod";

export type PlatformSuperUser = {
  email: string;
  displayName?: string;
  passwordHash: string;
  enabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type PhiSiteLocationConfig = {
  host?: string;
  port?: number;
  path?: string;
};

export type PhiSiteOverrideConfig = {
  sourceLocale?: string;
  source?: PhiSiteLocationConfig;
  instances?: PhiSiteLocationConfig[];
};

export type PhiSitesConfig = {
  sourcePathRoot?: string;
  instancePathRoot?: string;
  basePort?: number;
  overrides?: Record<string, PhiSiteOverrideConfig>;
};

export type PhisConfig = {
  sites?: PhiSitesConfig;
  runtime?: {
    containerized?: boolean;
  };
  bootstrap?: {
    enabled?: boolean;
  };
  platformSuperUsers?: PlatformSuperUser[];
  database?: {
    uri?: string;
    /**
     * What `phis-cli` migrates with, which is not what a running instance serves with.
     *
     * Section 15 keeps DDL authority away from the role that answers requests. There is deliberately no
     * fallback to `uri`: a silent one would make that separation a claim rather than a fact.
     *
     * This one cannot live in the encrypted store, because reading the store needs the database.
     */
    migrationUri?: string;
  };
  api?: {
    publicToken?: string;
    phisCdnPublicToken?: string;
    internalToken?: string;
    disableRateLimit?: boolean;
  };
  deepl?: {
    apiKey?: string;
    apiUrl?: string;
  };
  registration?: {
    intentEncryptionKey?: string;
  };
  auth?: {
    transactionEncryptionKey?: string;
  };
  /**
   * What operator session cookies are signed with, and nothing else is.
   *
   * It used to be `api.internalToken`, which every Site runtime holds: anyone with a Site's copy could
   * mint an operator session for any address. A key of its own, written by the setup finish and by
   * `phis operator add`, keeps the operator surface out of reach of the Sites it administers.
   */
  operator?: {
    sessionSecret?: string;
  };
  /**
   * The one secret that stays out of the database.
   *
   * Every other secret lives encrypted in `phis.server_secrets`, so a second instance reads what the
   * first one wrote. This key is what a new host needs before it can serve anything, and an instance
   * that cannot read it must not report ready.
   */
  secrets?: {
    encryptionKey?: string;
    encryptionKeyVersion?: number;
  };
  forms?: {
    timeouts?: {
      minSubmitMs?: number;
      maxSubmitMs?: number;
    };
  };
  email?: {
    from?: string;
    fromName?: string;
    smtp?: {
      targets?: string[];
      secure?: boolean;
      ignoreTls?: boolean;
      tlsRejectUnauthorized?: boolean;
    };
  };
  /**
   * What the links inside outgoing messages are signed with.
   *
   * An unsubscribe link has to work for as long as the mail carrying it exists, which rules out a stored
   * one-time token, and it must not be guessable, which rules out an unsigned id. So the link carries a
   * signature over the recipient and a salt kept beside the membership, and this is the key -- the salt
   * alone is public and proves nothing. Installation-wide and therefore here: two instances must sign the
   * same link, and rotating this invalidates every link still sitting in a mailbox.
   */
  notifications?: {
    linkSecret?: string;
  };
  /**
   * Local Storage defaults only. The global `local | s3` switch, the persisted public URL base, and
   * inline S3 credentials are retired: a Storage Provider and its configuration are bound per Site
   * through `media_storage_profiles`. See `GROUPS_AND_STORAGE.md` section 8.
   */
  media?: {
    /** Seeds the Local Storage Profile's config the first time it is materialized. */
    storageKeyPrefix?: string;
    local?: {
      rootDir?: string;
    };
    /**
     * Versioned installation defaults applied once when a Site's `site_media_config` row is first
     * materialized. Operator owned: Site administration edits the row, never this layer, and there is
     * no request-time fallback to it. See `GROUPS_AND_STORAGE.md` section 7.
     */
    defaults?: {
      userQuotaBytes?: number | null;
      groupQuotaBytes?: number | null;
    };
  };
  translation?: {
    sourceLocale?: string;
    /**
     * Where a translation comes from. See TRANSLATIONS.md, "Translation modes".
     *
     * `cdn+deepl` asks the CDN first and DeepL for what it does not answer; `deepl` is the same without
     * the CDN in front, which an installation that words its own global messages wants, because the CDN
     * answers first and would win. `add-on` hands the question to the translation service provider the
     * operator selected. `none` returns source text.
     */
    mode?: "deepl" | "cdn+deepl" | "add-on" | "none";
    /**
     * Which translation service provider `add-on` mode uses, as the provider key of a manifest.
     *
     * Several implementations may be installed, so naming the kind is not enough -- uniqueness is on
     * `(service kind, provider key)`. Empty while nothing is selected, which is also what an
     * installation with no such Add-on can only ever have.
     */
    providerKey?: string;
    /**
     * The secret the selected translation Provider is given, as a secret reference.
     *
     * Installation-wide and therefore here, not in an Add-on's per-Site configuration: which translator
     * an installation uses is an installation's decision, and the Provider is handed no Site at all. The
     * reference names the secret and never holds it -- `addon:@scope/name:api-key` -- and Core resolves
     * it, because the configuration that names it is Core's and an Add-on asking for its own reference
     * would be an Add-on trusted to ask only for its own.
     *
     * Empty is a Provider that needs none, which is a real case: one that talks to a model on the same
     * machine has nothing to authenticate with.
     */
    secretReference?: string;
    cdnBaseUrl?: string;
    supportedLocales?: string[];
    allowedLocales?: string[];
    allowPublicWrites?: boolean;
    allowPublicReads?: boolean;
    /**
     * When the window for creating global messages closes, as an ISO timestamp.
     *
     * `allowPublicWrites` says a public caller may write; this says until when it may write messages
     * nobody here has seen yet. Absent is closed, because a window has to be opened deliberately, and
     * it is capped at ten minutes where it is written (`PHIS_TRANSLATION_WRITE_WINDOW_MAX_MS`). It runs
     * out by being read rather than by being switched off, so nothing has to remember to close it.
     */
    allowPublicWritesUntil?: string;
  };
};

export type ConfigFileLoadResult = {
  config: PhisConfig;
  error?: string;
};

export type PhiConfigPaths = {
  root: string;
  static: string;
  runtime: string;
};

export const DEFAULT_CONFIG: PhisConfig = {
  sites: {
    sourcePathRoot: "/opt/phis/sources",
    instancePathRoot: "/var/www/phis/sites",
    basePort: 52000,
  },
  runtime: {
    containerized: false,
  },
  bootstrap: {
    enabled: false,
  },
  platformSuperUsers: [],
  email: {
    fromName: "",
    smtp: {
      targets: [],
      secure: false,
      ignoreTls: false,
    },
  },
  media: {
    storageKeyPrefix: "sites",
    local: {},
    // Capacity only. Whether a Space kind exists at all is not configured here: it follows from the
    // Modules a Site activates, so a Site that activates none has no User or Group Space.
    defaults: {
      userQuotaBytes: null,
      groupQuotaBytes: null,
    },
  },
  translation: {
    sourceLocale: "en",
    mode: "none",
    cdnBaseUrl: "https://cdn.phis.dev",
    supportedLocales: ["en"],
    allowedLocales: ["en"],
    allowPublicWrites: false,
    allowPublicReads: false,
  },
};

export function resolvePhiSiteSourceLocale(config: PhisConfig, siteKeyInput: string) {
  const siteKey = siteKeyInput.trim().toLowerCase();
  const siteLocale = siteKey ? config.sites?.overrides?.[siteKey]?.sourceLocale?.trim().toLowerCase() : "";
  const fallbackLocale = config.translation?.sourceLocale?.trim().toLowerCase() ?? "";
  return siteLocale || fallbackLocale || "en";
}

export function loadConfigFileSync(configPath: string): ConfigFileLoadResult {
  try {
    const raw = readFileSync(configPath, "utf-8");
    return {
      config: JSON.parse(raw) as PhisConfig,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown config file read failure.";
    return {
      config: {},
      error: message,
    };
  }
}

export function readConfigFileSync(configPath: string): PhisConfig {
  return loadConfigFileSync(configPath).config;
}

export function mergeConfig(base: PhisConfig, override: PhisConfig): PhisConfig {
  const mergedSiteOverrides =
    base.sites?.overrides || override.sites?.overrides
      ? Object.fromEntries(
          Array.from(
            new Set([
              ...Object.keys(base.sites?.overrides ?? {}),
              ...Object.keys(override.sites?.overrides ?? {}),
            ]),
          ).map((siteKey) => [
            siteKey,
            {
              ...base.sites?.overrides?.[siteKey],
              ...override.sites?.overrides?.[siteKey],
              source: {
                ...base.sites?.overrides?.[siteKey]?.source,
                ...override.sites?.overrides?.[siteKey]?.source,
              },
              instances:
                override.sites?.overrides?.[siteKey]?.instances ??
                base.sites?.overrides?.[siteKey]?.instances,
            },
          ]),
        )
      : undefined;

  return {
    ...base,
    ...override,
    sites: {
      ...base.sites,
      ...override.sites,
      overrides: mergedSiteOverrides,
    },
    runtime: {
      ...base.runtime,
      ...override.runtime,
    },
    bootstrap: {
      ...base.bootstrap,
      ...override.bootstrap,
    },
    platformSuperUsers: override.platformSuperUsers ?? base.platformSuperUsers,
    database: {
      ...base.database,
      ...override.database,
    },
    api: {
      ...base.api,
      ...override.api,
    },
    deepl: {
      ...base.deepl,
      ...override.deepl,
    },
    registration: {
      ...base.registration,
      ...override.registration,
    },
    auth: {
      ...base.auth,
      ...override.auth,
    },
    forms: {
      ...base.forms,
      ...override.forms,
      timeouts: {
        ...base.forms?.timeouts,
        ...override.forms?.timeouts,
      },
    },
    email: {
      ...base.email,
      ...override.email,
      smtp: {
        ...base.email?.smtp,
        ...override.email?.smtp,
        targets: override.email?.smtp?.targets ?? base.email?.smtp?.targets,
      },
    },
    media: {
      ...base.media,
      ...override.media,
      storageKeyPrefix: override.media?.storageKeyPrefix ?? base.media?.storageKeyPrefix,
      local: {
        ...base.media?.local,
        ...override.media?.local,
      },
      defaults: {
        ...base.media?.defaults,
        ...override.media?.defaults,
      },
    },
    translation: {
      ...base.translation,
      ...override.translation,
      supportedLocales:
        override.translation?.supportedLocales ??
        override.translation?.allowedLocales ??
        base.translation?.supportedLocales ??
        base.translation?.allowedLocales,
      allowedLocales:
        override.translation?.allowedLocales ?? base.translation?.allowedLocales,
    },
  };
}

export function readPhiStaticConfigSync(configPaths: PhiConfigPaths) {
  return readConfigFileSync(configPaths.static);
}

export function readPhiRuntimeConfigSync(configPaths: PhiConfigPaths) {
  return readConfigFileSync(configPaths.runtime);
}

export function readMergedPhiConfigSync(configPaths: PhiConfigPaths) {
  return mergeConfig(
    mergeConfig(DEFAULT_CONFIG, readPhiStaticConfigSync(configPaths)),
    readPhiRuntimeConfigSync(configPaths),
  );
}

export function writePhiRuntimeConfigSync(configPaths: PhiConfigPaths, config: PhisConfig) {
  const nextContent = `${JSON.stringify(config, null, 2)}\n`;
  const tempPath = `${configPaths.runtime}.tmp`;
  writeFileSync(tempPath, nextContent, "utf-8");
  renameSync(tempPath, configPaths.runtime);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validateSiteLocationConfig(
  value: PhiSiteLocationConfig | undefined,
  keyPrefix: string,
  issues: string[],
) {
  if (!value) {
    return;
  }

  if (value.host !== undefined && typeof value.host !== "string") {
    issues.push(`${keyPrefix}.host must be a string.`);
  }

  if (value.port !== undefined && (!Number.isInteger(value.port) || value.port <= 0)) {
    issues.push(`${keyPrefix}.port must be a positive integer.`);
  }

  if (value.path !== undefined && typeof value.path !== "string") {
    issues.push(`${keyPrefix}.path must be a string.`);
  }
}

export function validatePhiConfig(config: PhisConfig) {
  const issues: string[] = [];

  if (
    config.platformSuperUsers &&
    !Array.isArray(config.platformSuperUsers)
  ) {
    issues.push("platformSuperUsers must be an array.");
  }

  if (
    config.sites?.sourcePathRoot !== undefined &&
    typeof config.sites.sourcePathRoot !== "string"
  ) {
    issues.push("sites.sourcePathRoot must be a string.");
  }

  if (
    config.sites?.instancePathRoot !== undefined &&
    typeof config.sites.instancePathRoot !== "string"
  ) {
    issues.push("sites.instancePathRoot must be a string.");
  }

  if (
    config.sites?.basePort !== undefined &&
    (!Number.isInteger(config.sites.basePort) || config.sites.basePort <= 0)
  ) {
    issues.push("sites.basePort must be a positive integer.");
  }

  if (
    config.sites?.overrides !== undefined &&
    (typeof config.sites.overrides !== "object" ||
      config.sites.overrides === null ||
      Array.isArray(config.sites.overrides))
  ) {
    issues.push("sites.overrides must be an object keyed by site key.");
  }

  for (const [siteKey, override] of Object.entries(config.sites?.overrides ?? {})) {
    if (override.sourceLocale !== undefined &&
      (typeof override.sourceLocale !== "string" || !override.sourceLocale.trim())) {
      issues.push(`sites.overrides.${siteKey}.sourceLocale must be a non-empty string.`);
    }
    validateSiteLocationConfig(override.source, `sites.overrides.${siteKey}.source`, issues);

    if (override.instances !== undefined && !Array.isArray(override.instances)) {
      issues.push(`sites.overrides.${siteKey}.instances must be an array.`);
      continue;
    }

    for (const [index, instance] of (override.instances ?? []).entries()) {
      validateSiteLocationConfig(
        instance,
        `sites.overrides.${siteKey}.instances[${index}]`,
        issues,
      );
    }
  }

  const seenEmails = new Set<string>();

  for (const [index, user] of (config.platformSuperUsers ?? []).entries()) {
    if (!user.email?.trim()) {
      issues.push(`platformSuperUsers[${index}].email is required.`);
    }
    if (!user.passwordHash?.trim()) {
      issues.push(`platformSuperUsers[${index}].passwordHash is required.`);
    }

    const normalizedEmail = user.email.trim().toLowerCase();
    if (seenEmails.has(normalizedEmail)) {
      issues.push(`platformSuperUsers contains duplicate email ${user.email}.`);
    }
    seenEmails.add(normalizedEmail);
  }

  if (
    config.auth?.transactionEncryptionKey !== undefined &&
    !/^[a-f0-9]{64}$/i.test(config.auth.transactionEncryptionKey)
  ) {
    issues.push("auth.transactionEncryptionKey must be a 64-character hex string.");
  }

  if (
    config.secrets?.encryptionKey !== undefined &&
    !/^[a-f0-9]{64}$/i.test(config.secrets.encryptionKey)
  ) {
    issues.push("secrets.encryptionKey must be a 64-character hex string.");
  }

  if (
    config.secrets?.encryptionKeyVersion !== undefined &&
    (!Number.isInteger(config.secrets.encryptionKeyVersion) ||
      config.secrets.encryptionKeyVersion < 1)
  ) {
    issues.push("secrets.encryptionKeyVersion must be a positive integer.");
  }

  // `auth.secrets` used to live here in cleartext. It is a row in `phis.server_secrets` now, and an
  // installation still carrying the field runs `phis auth import-secrets` once.
  if (config.auth && "secrets" in config.auth) {
    issues.push(
      "auth.secrets is no longer read. Run `phis auth import-secrets` to move it into the encrypted " +
      "store, which is what a second instance can read.",
    );
  }

  if (
    config.email?.smtp?.targets &&
    !isStringArray(config.email.smtp.targets)
  ) {
    issues.push("email.smtp.targets must be an array of strings.");
  }

  for (const key of ["userQuotaBytes", "groupQuotaBytes"] as const) {
    const value = config.media?.defaults?.[key];
    if (
      value !== undefined && value !== null &&
      (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    ) {
      issues.push(`media.defaults.${key} must be null or a non-negative integer.`);
    }
  }

  if (
    config.media?.storageKeyPrefix !== undefined &&
    typeof config.media.storageKeyPrefix !== "string"
  ) {
    issues.push("media.storageKeyPrefix must be a string.");
  }

  if (
    config.media?.local?.rootDir !== undefined &&
    typeof config.media.local.rootDir !== "string"
  ) {
    issues.push("media.local.rootDir must be a string.");
  }







  if (
    config.translation?.sourceLocale !== undefined &&
    (typeof config.translation.sourceLocale !== "string" || !config.translation.sourceLocale.trim())
  ) {
    issues.push("translation.sourceLocale must be a non-empty string.");
  }

  if (
    config.translation?.supportedLocales &&
    !isStringArray(config.translation.supportedLocales)
  ) {
    issues.push("translation.supportedLocales must be an array of strings.");
  }

  if (
    config.translation?.allowedLocales &&
    !isStringArray(config.translation.allowedLocales)
  ) {
    issues.push("translation.allowedLocales must be an array of strings.");
  }

  const configuredSupportedLocales =
    (isStringArray(config.translation?.supportedLocales)
      ? config.translation?.supportedLocales
      : isStringArray(config.translation?.allowedLocales)
        ? config.translation?.allowedLocales
        : []) ?? [];
  const supportedLocales = new Set(
    configuredSupportedLocales.map((locale) => locale.trim().toLowerCase()),
  );
  const globalSourceLocale = config.translation?.sourceLocale?.trim().toLowerCase();
  if (globalSourceLocale && supportedLocales.size > 0 && !supportedLocales.has(globalSourceLocale)) {
    issues.push("translation.sourceLocale must be included in translation.supportedLocales.");
  }
  for (const [siteKey, override] of Object.entries(config.sites?.overrides ?? {})) {
    const sourceLocale = override.sourceLocale?.trim().toLowerCase();
    if (sourceLocale && supportedLocales.size > 0 && !supportedLocales.has(sourceLocale)) {
      issues.push(
        `sites.overrides.${siteKey}.sourceLocale must be included in translation.supportedLocales.`,
      );
    }
  }

  if (
    config.forms?.timeouts !== undefined &&
    (typeof config.forms.timeouts !== "object" ||
      config.forms.timeouts === null ||
      Array.isArray(config.forms.timeouts))
  ) {
    issues.push("forms.timeouts must be an object.");
  }

  if (
    config.forms?.timeouts?.minSubmitMs !== undefined &&
    (!Number.isInteger(config.forms.timeouts.minSubmitMs) ||
      config.forms.timeouts.minSubmitMs < 0)
  ) {
    issues.push("forms.timeouts.minSubmitMs must be a non-negative integer.");
  }

  if (
    config.forms?.timeouts?.maxSubmitMs !== undefined &&
    (!Number.isInteger(config.forms.timeouts.maxSubmitMs) ||
      config.forms.timeouts.maxSubmitMs < 0)
  ) {
    issues.push("forms.timeouts.maxSubmitMs must be a non-negative integer.");
  }

  return issues;
}
