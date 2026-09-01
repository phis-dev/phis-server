#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { Pool } from "pg";
import packageJson from "../../package.json" with { type: "json" };

import {
  getDefaultPhiRoot,
  loadConfigFileSync,
  readMergedPhiConfigSync,
  readPhiRuntimeConfigSync,
  resolvePhiSiteSourceLocale,
  resolvePhiConfigPaths,
  type PlatformSuperUser,
  validatePhiConfig,
  writePhiRuntimeConfigSync,
} from "../lib/config-files-cli.ts";
import {
  checkPhiInstanceVersion,
  writePhiInstanceStamp,
} from "../lib/instance-version-cli.ts";
import { hashPassword } from "../lib/password-core.ts";
import {
  buildRuntimeSummary,
  hasSiteSourceOverride,
  renderSiteConfig,
  resolveSiteInstances,
  resolveSiteSource,
  type SiteConfigTarget,
  type SiteDeploymentRecord,
} from "../lib/site-deployment-config.ts";
import {
  addPhiCliSiteLocale,
  createPhiCliSite,
  deletePhiCliSiteByKey,
  getPhiCliSiteByKey,
  listPhiCliSites,
  setPhiCliSiteEnabled,
  updatePhiCliSite,
} from "../db/cli-sites.mts";
import {
  checkAddons,
  installAddon,
  upgradeAddon,
  listAddons,
  migrateAddons,
  purgeAddon,
  reconcileAddons,
  forgetAddon,
  readInstalledAddonGroups,
  readInstalledAddonModules,
  readInstalledAddonPackageName,
  readInstalledAddonSettings,
  removeAddon,
  setAddonEnabled,
} from "./addons.mts";
import {
  grantPhiServerAddonUserRole,
  readPhiSiteUserAddonRoles,
  revokePhiServerAddonUserRole,
} from "../db/server-addon-roles.mts";
import { getPhiAppRoot } from "../lib/app-paths.ts";
import {
  applyPhiCoreSchema,
  checkPhiCoreSchema,
  readPhiMigrationRoleName,
} from "./schema.mts";
import {
  inspectSiteModulePackage,
  type PhiSiteModulePackageReport,
} from "./module-package.mts";
import {
  addSiteModuleDependency,
  readSiteModuleDesiredState,
  removeSiteModuleDependency,
  writeSiteModuleDesiredState,
  writeSiteModuleProjection,
  type PhiSiteModuleEntry,
} from "./modules.mts";
import {
  parsePhiServerAddonSettingValue,
  readPhiServerAddonSettings,
  writePhiServerAddonSetting,
} from "../db/server-addon-settings.mts";
import {
  ensurePhiServerAddonSiteGroups,
  retirePhiServerAddonSiteGroups,
} from "../db/server-addon-groups.mts";
import {
  readPhiServerAddonSiteStates,
  resolvePhiServerAddonConfigurationStatus,
  setPhiServerAddonSiteEnabled,
} from "../db/server-addon-sites.mts";
import { checkPhiDependencyLicenses } from "./licenses.mts";
import { checkPhiMediaOwnership } from "./media-check.mts";
import {
  addStorageProfile,
  listStorageProfiles,
  reconcileStorageCors,
  removeStorageProfile,
  probeStorageProfiles,
  setStorageProfile,
  useStorageProfile,
} from "./storage.mts";
import { restoreFirstPartyAuthPreset } from "../db/auth-preset.mts";
import { importPhiAuthSecrets } from "../db/auth-secret-import.mts";
import { buildPhiAuthSecretReference } from "../lib/secrets/reference.ts";
import {
  deletePhiServerSecretWithDb,
  listPhiServerSecretsWithDb,
  readPhiServerSecretWithDb,
  writePhiServerSecretWithDb,
} from "../db/server-secrets-store.mts";
import {
  createPhiSecretEncryptionKey,
  PHI_SECRET_INITIAL_KEY_VERSION,
  type PhiSecretEncryptionKey,
} from "../lib/secrets/crypto.ts";
import { buildPhiSecretReference } from "../lib/secrets/reference.ts";
import {
  buildPhiSiteReleaseArtifact,
  reconcilePhiSiteScaffold,
  resolvePhiSiteInstallArgs,
  runPhiSitePackageCommand,
  type PhiSiteScaffoldPackageManager,
} from "../lib/site-scaffold.mts";

type FlagMap = Map<string, string | boolean>;
type ParsedArgv = {
  flags: FlagMap;
  positionals: string[];
};

const SHORT_FLAG_ALIASES = new Map<string, string>([
  ["e", "email"],
  ["u", "public-base-url"],
  ["h", "hostname"],
  ["k", "key"],
  ["l", "locale"],
  ["p", "password"],
  ["n", "name"],
  ["d", "disabled"],
  ["j", "json"],
  ["r", "root"],
]);

let configRoot = getDefaultPhiRoot();

function isJsonOutput(flags: FlagMap) {
  return flags.get("json") === true;
}

function getConfigPaths() {
  return resolvePhiConfigPaths(configRoot);
}

function readCliMergedConfig() {
  return readMergedPhiConfigSync(configRoot);
}

function readCliRuntimeConfig() {
  return readPhiRuntimeConfigSync(configRoot);
}

function writeCliRuntimeConfig(config: Parameters<typeof writePhiRuntimeConfigSync>[0]) {
  writePhiRuntimeConfigSync(config, configRoot);
}

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

function logCliError(event: string, message: string, meta?: Record<string, unknown>) {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      service: "phi-cli",
      event,
      message,
      meta,
    }),
  );
}

function printUsage() {
  console.log(`phis-cli ${packageJson.version}

Usage:
  Append [--json|-j] to any command for JSON output.
  Append [--root|-r <path>] to run against another phis root. Defaults to the current working directory.

  phis config
  phis config paths
  phis config validate
  phis site list [--key|-k <site key>]
  phis site add --key|-k <site key> --name|-n <site name> --hostname|-h <hostname> --public-base-url|-u <url> --source-locale <locale> --default-locale <locale> [--available-locales <csv>] --support-email|-e <email>
  phis site del --key|-k <site key>
  phis site enable --key|-k <site key>
  phis site disable --key|-k <site key>
  phis site set --key|-k <site key> [--name|-n <site name>] [--hostname|-h <hostname>] [--public-base-url|-u <url>] [--support-email|-e <email>]
  phis site locale add --key|-k <site key> --locale|-l <locale>
  phis site config set source --key|-k <site key> [--source-host <host> --source-port <port> --source-path <path>]
  phis site config add --key|-k <site key> --instance-host <host> [--instance-port <port>] --instance-path <path>
  phis site config del --key|-k <site key> --instance-host <host>
  phis site config nginx --key|-k <site key> [--source]
  phis site config apache --key|-k <site key>
  phis site config systemd --key|-k <site key>
  phis site config docker-compose --key|-k <site key>
  phis site config runtime --key|-k <site key>
  phis site check --key|-k <site key> [--url <base url>]
  phis operator list [--email|-e <email>]
  phis operator add --email|-e <email> --password|-p <password> [--name|-n <display name>] [--disabled|-d]
  phis operator del --email|-e <email>
  phis operator passwd --email|-e <email> --password|-p <password>
  phis operator enable --email|-e <email>
  phis operator disable --email|-e <email>
  phis auth restore-preset --site <site key>
  phis auth import-secrets
  phis secret init-key
  phis secret set --name <name> [--site <site key>] [--addon <@scope/name>] [--value <value>]
  phis secret check --name <name> [--site <site key>] [--addon <@scope/name>]
  phis secret list [--site <site key>] [--addon <@scope/name>]
  phis secret del --name <name> [--site <site key>] [--addon <@scope/name>]
  phis init <site key> [--path <site source path>] [--package-manager pnpm|npm|yarn|bun]
  phis reconcile <site key> [--path <site source path>] [--package-manager pnpm|npm|yarn|bun] [--install]
  phis update <site key> [--path <site source path>] [--package-manager pnpm|npm|yarn|bun]
  phis media check [--fix]
  phis licenses check [--package <directory>]

  phis storage list --site <site key>
  phis storage add  --site <site key> --key <profile key> --provider <provider id>
                    [--config <json|@file>] [--secret-name <name>|--secret-reference <ref>]
  phis storage set  --site <site key> --key <profile key>
                    [--config <json|@file>] [--replace] [--secret-name <name>|--secret-reference <ref>]
  phis storage use  --site <site key> --key <profile key>
  phis storage del  --site <site key> --key <profile key>
  phis storage cors
  phis storage probe --site <site key> [--key <profile key>]

  phis schema check
  phis schema apply

  phis addon list
  phis addon check
  phis addon install --artifact <path to addon.mjs>
  phis addon upgrade --addon <@scope/name> --artifact <path to addon.mjs> [--repackage]
  phis addon remove --addon <@scope/name>
  phis addon enable --addon <@scope/name>
  phis addon disable --addon <@scope/name>
  phis addon forget --addon <@scope/name>
  phis addon site   --addon <@scope/name> [--site <site key> --enable [--without-module] | --disable]
  phis addon config --addon <@scope/name> --site <site key>
  phis addon role   --site <site key> [--addon <@scope/name>] [--user <id>]
                    [--grant <role> | --revoke <role>]
                    [--name <setting> [--value <value>]]
  phis addon job    --addon <@scope/name> --job <job id> --site <site key>
                    [--api-base-url <url>]
  phis addon reconcile --release <release/build id>
  phis addon migrate --release <release/build id> [--addon <@scope/name>]
  phis addon purge --addon <@scope/name>
  phis module list [--site <site key>]
  phis module add --site <site key> --package <@scope/name> [--spec <version or workspace:*>]
  phis module del --site <site key> --package <@scope/name>
  phis module sync --site <site key>
  phis module check --site <site key> [--package <@scope/name>]
`);
}

function printVersion(json: boolean) {
  if (json) {
    printJson({
      version: packageJson.version,
    });
    return;
  }

  console.log(packageJson.version);
}

function parseArgv(argv: string[]): ParsedArgv {
  const flags: FlagMap = new Map();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("-")) {
      positionals.push(current);
      continue;
    }

    const isLongFlag = current.startsWith("--");
    const rawKey = current.slice(isLongFlag ? 2 : 1);
    const key = isLongFlag ? rawKey : SHORT_FLAG_ALIASES.get(rawKey);
    if (!key) {
      throw new Error(`Unknown flag: ${current}`);
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("-")) {
      flags.set(key, true);
      continue;
    }

    flags.set(key, next);
    index += 1;
  }

  return {
    flags,
    positionals,
  };
}

function getRequiredFlag(flags: FlagMap, key: string) {
  const value = flags.get(key);
  if (!value || typeof value !== "string") {
    throw new Error(`Missing --${key}.`);
  }

  return value.trim();
}

function printConfigPaths(json: boolean) {
  const configPaths = getConfigPaths();
  if (json) {
    printJson({
      root: configPaths.root,
      static: configPaths.static,
      runtime: configPaths.runtime,
    });
    return;
  }

  console.log(`root:    ${configPaths.root}`);
  console.log(`static:  ${configPaths.static}`);
  console.log(`runtime: ${configPaths.runtime}`);
}

function printMergedConfig() {
  printJson(readCliMergedConfig());
}

function getOptionalFlag(flags: FlagMap, key: string) {
  const value = flags.get(key);
  return typeof value === "string" ? value.trim() : undefined;
}

function getSiteSupportEmailFlag(flags: FlagMap, required = false) {
  const value = getOptionalFlag(flags, "support-email") ?? getOptionalFlag(flags, "email");
  if (required && !value) {
    throw new Error("Missing --support-email.");
  }

  return value;
}

function normalizeSiteKey(value: string) {
  return value.trim().toLowerCase();
}

function normalizeHostname(value: string) {
  return value.trim().toLowerCase();
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function buildMailHost(hostname: string, publicBaseUrl: string) {
  const normalizedHostname = normalizeHostname(hostname);
  if (normalizedHostname) {
    return normalizedHostname;
  }

  try {
    return new URL(publicBaseUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function getSupportedLocales() {
  const translation = readCliMergedConfig().translation;

  return Array.from(
    new Set(
      (translation?.supportedLocales ?? translation?.allowedLocales ?? [])
        .map((entry: string) => entry.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

let pool: Pool | null = null;
let migrationPool: Pool | null = null;

/**
 * The connection `phis-cli` migrates with, which is not the one a running instance serves with.
 *
 * There is no fallback to `database.uri` on purpose. Section 15 says the serving role holds no DDL
 * grant; a fallback would let that sentence stay true in the document and false in the deployment.
 */
function getMigrationPool() {
  if (migrationPool) {
    return migrationPool;
  }

  const connectionString = readCliMergedConfig().database?.migrationUri?.trim();
  if (!connectionString) {
    throw new Error(
      `Missing database.migrationUri in ${getConfigPaths().runtime}. Migration authority is a separate ` +
      "role from the one that serves requests, so there is no fallback to database.uri.",
    );
  }

  migrationPool = new Pool({ connectionString });
  return migrationPool;
}

/** The role that has to be able to read what a migration creates, taken from the serving connection. */
function getServingRole() {
  const connectionString = readCliMergedConfig().database?.uri?.trim();
  if (!connectionString) {
    throw new Error(`Missing database.uri in ${getConfigPaths().runtime}`);
  }
  const username = decodeURIComponent(new URL(connectionString).username);
  if (!username) {
    throw new Error("database.uri names no role, so a migration cannot grant one access.");
  }
  return username;
}

function getPool() {
  if (pool) {
    return pool;
  }

  const connectionString = readCliMergedConfig().database?.uri?.trim();
  if (!connectionString) {
    throw new Error(`Missing database.uri in ${getConfigPaths().runtime}`);
  }

  pool = new Pool({ connectionString });
  return pool;
}

function validateConfig(json: boolean) {
  const configPaths = getConfigPaths();
  const staticResult = loadConfigFileSync(configPaths.static);
  const runtimeResult = loadConfigFileSync(configPaths.runtime);
  const issues = validatePhiConfig(readCliMergedConfig());
  const ok = !staticResult.error && !runtimeResult.error && issues.length === 0;

  if (json) {
    printJson({
      ok,
      staticError: staticResult.error ?? null,
      runtimeError: runtimeResult.error ?? null,
      issues,
    });
    if (!ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (staticResult.error) {
    logCliError("cli.config.static_error", `static config: ${staticResult.error}`, {
      error: staticResult.error,
    });
    console.error(`static config: ${staticResult.error}`);
  }
  if (runtimeResult.error) {
    logCliError("cli.config.runtime_error", `runtime config: ${runtimeResult.error}`, {
      error: runtimeResult.error,
    });
    console.error(`runtime config: ${runtimeResult.error}`);
  }
  for (const issue of issues) {
    logCliError("cli.config.issue", `config issue: ${issue}`, { issue });
    console.error(`config issue: ${issue}`);
  }

  if (!ok) {
    process.exitCode = 1;
    return;
  }

  console.log("phis config is valid.");
}

function getRuntimeSuperUsers() {
  return [...(readCliRuntimeConfig().platformSuperUsers ?? [])];
}

function printSuperUsers(flags: FlagMap, json: boolean) {
  const emailFilter = getOptionalFlag(flags, "email")?.toLowerCase();
  const users = getRuntimeSuperUsers().filter((user) =>
    emailFilter ? user.email.toLowerCase() === emailFilter : true,
  );
  if (json) {
    printJson(users);
    return;
  }

  if (users.length === 0) {
    console.log("No platform operators configured.");
    return;
  }

  for (const user of users) {
    console.log(
      `${user.email}  enabled=${user.enabled !== false ? "true" : "false"}  name=${user.displayName ?? "-"}`,
    );
  }
}

function upsertRuntimeSuperUsers(nextUsers: PlatformSuperUser[]) {
  const runtimeConfig = readCliRuntimeConfig();
  runtimeConfig.platformSuperUsers = nextUsers;
  writeCliRuntimeConfig(runtimeConfig);
}

async function setSiteSourceOverride(flags: FlagMap, json: boolean) {
  const siteKey = getRequiredFlag(flags, "key").toLowerCase();
  await getSiteByKey(siteKey);

  const runtimeConfig = readCliRuntimeConfig();
  const nextSites = { ...(runtimeConfig.sites ?? {}) };
  const nextOverrides = { ...(nextSites.overrides ?? {}) };
  const nextOverride = { ...(nextOverrides[siteKey] ?? {}) };
  const sourceHost = getOptionalFlag(flags, "source-host");
  const sourcePortRaw = getOptionalFlag(flags, "source-port");
  const sourcePath = getOptionalFlag(flags, "source-path");

  const sourceFlagCount = [sourceHost, sourcePortRaw, sourcePath].filter(
    (value) => value !== undefined,
  ).length;

  if (sourceFlagCount !== 0 && sourceFlagCount !== 3) {
    throw new Error(
      "Provide either all of --source-host, --source-port, and --source-path, or none of them to remove the source override.",
    );
  }

  if (sourceFlagCount === 0) {
    delete nextOverride.source;

    if (!nextOverride.sourceLocale && (!nextOverride.instances || nextOverride.instances.length === 0)) {
      delete nextOverrides[siteKey];
    } else {
      nextOverrides[siteKey] = nextOverride;
    }

    nextSites.overrides = nextOverrides;
    runtimeConfig.sites = nextSites;
    writeCliRuntimeConfig(runtimeConfig);

    if (json) {
      printJson({
        ok: true,
        action: "site.config.set.source",
        key: siteKey,
        source: null,
        override: nextOverrides[siteKey] ?? null,
      });
      return;
    }

    console.log(`Removed source override for ${siteKey}.`);
    return;
  }

  const sourcePort = Number(sourcePortRaw);
  if (!Number.isInteger(sourcePort) || sourcePort <= 0) {
    throw new Error("Expected --source-port to be a positive integer.");
  }

  nextOverride.source = {
    host: sourceHost,
    port: sourcePort,
    path: sourcePath,
  };

  nextOverrides[siteKey] = nextOverride;
  nextSites.overrides = nextOverrides;
  runtimeConfig.sites = nextSites;
  writeCliRuntimeConfig(runtimeConfig);

  if (json) {
    printJson({
      ok: true,
      action: "site.config.set.source",
      key: siteKey,
      source: nextOverride.source,
      override: nextOverride,
    });
    return;
  }

  console.log(`Updated source override for ${siteKey}.`);
}

async function addSiteInstance(flags: FlagMap, json: boolean) {
  const siteKey = getRequiredFlag(flags, "key").toLowerCase();
  await getSiteByKey(siteKey);

  const instanceHost = getRequiredFlag(flags, "instance-host");
  const instancePath = getRequiredFlag(flags, "instance-path");
  const instancePortRaw = getOptionalFlag(flags, "instance-port");
  const instancePort =
    instancePortRaw !== undefined
      ? Number(instancePortRaw)
      : undefined;

  if (
    instancePortRaw !== undefined &&
    (instancePort === undefined || !Number.isInteger(instancePort) || instancePort <= 0)
  ) {
    throw new Error("Expected --instance-port to be a positive integer.");
  }

  const runtimeConfig = readCliRuntimeConfig();
  const nextSites = { ...(runtimeConfig.sites ?? {}) };
  const nextOverrides = { ...(nextSites.overrides ?? {}) };
  const nextOverride = { ...(nextOverrides[siteKey] ?? {}) };
  const nextInstances = Array.isArray(nextOverride.instances) ? [...nextOverride.instances] : [];

  nextInstances.push({
    host: instanceHost,
    ...(instancePort !== undefined ? { port: instancePort } : {}),
    path: instancePath,
  });

  nextOverride.instances = nextInstances;
  nextOverrides[siteKey] = nextOverride;
  nextSites.overrides = nextOverrides;
  runtimeConfig.sites = nextSites;
  writeCliRuntimeConfig(runtimeConfig);

  if (json) {
    printJson({
      ok: true,
      action: "site.config.add",
      key: siteKey,
      instance: nextInstances[nextInstances.length - 1],
      instances: nextInstances,
    });
    return;
  }

  console.log(`Added site instance for ${siteKey}.`);
}

async function deleteSiteInstancesByHost(flags: FlagMap, json: boolean) {
  const siteKey = getRequiredFlag(flags, "key").toLowerCase();
  await getSiteByKey(siteKey);

  const instanceHost = getRequiredFlag(flags, "instance-host").trim().toLowerCase();
  const runtimeConfig = readCliRuntimeConfig();
  const nextSites = { ...(runtimeConfig.sites ?? {}) };
  const nextOverrides = { ...(nextSites.overrides ?? {}) };
  const nextOverride = { ...(nextOverrides[siteKey] ?? {}) };
  const currentInstances = Array.isArray(nextOverride.instances) ? nextOverride.instances : [];
  const nextInstances = currentInstances.filter(
    (instance: { host?: string }) => instance.host?.trim().toLowerCase() !== instanceHost,
  );

  if (nextInstances.length === currentInstances.length) {
    throw new Error(`No site instances found for host ${instanceHost}.`);
  }

  const removed = currentInstances.length - nextInstances.length;

  if (nextInstances.length > 0) {
    nextOverride.instances = nextInstances;
  } else {
    delete nextOverride.instances;
  }

  if (!nextOverride.sourceLocale && !nextOverride.source && !nextOverride.instances) {
    delete nextOverrides[siteKey];
  } else {
    nextOverrides[siteKey] = nextOverride;
  }

  nextSites.overrides = nextOverrides;
  runtimeConfig.sites = nextSites;
  writeCliRuntimeConfig(runtimeConfig);

  if (json) {
    printJson({
      ok: true,
      action: "site.config.del",
      key: siteKey,
      instanceHost,
      removed,
      instances: nextInstances,
    });
    return;
  }

  console.log(`Removed ${removed} site instance(s) for ${siteKey} on host ${instanceHost}.`);
}

async function createSite(flags: FlagMap, json: boolean) {
  const key = normalizeSiteKey(getRequiredFlag(flags, "key"));
  const name = getRequiredFlag(flags, "name");
  const hostname = normalizeHostname(getRequiredFlag(flags, "hostname"));
  const publicBaseUrl = getRequiredFlag(flags, "public-base-url");
  const sourceLocale = getRequiredFlag(flags, "source-locale").toLowerCase();
  const defaultLocale = getRequiredFlag(flags, "default-locale").toLowerCase();
  const supportEmail = normalizeEmail(getSiteSupportEmailFlag(flags, true) ?? "");
  const availableLocales = Array.from(
    new Set(
      [
        defaultLocale,
        ...(
          getOptionalFlag(flags, "available-locales")
            ?.split(",")
            .map((entry) => entry.trim().toLowerCase())
            .filter(Boolean) ?? []
        ),
      ].filter(Boolean),
    ),
  );

  if (!key || !name || !hostname || !publicBaseUrl || !sourceLocale || !defaultLocale || !supportEmail) {
    throw new Error("Please complete all site fields.");
  }

  try {
    new URL(publicBaseUrl);
  } catch {
    throw new Error("Please provide a valid public base URL.");
  }

  if (!supportEmail.includes("@")) {
    throw new Error("Expected --support-email to be a valid email address.");
  }

  const supportedLocales = getSupportedLocales();
  const unsupportedLocales = Array.from(new Set([sourceLocale, ...availableLocales]))
    .filter((locale) => !supportedLocales.includes(locale));
  if (unsupportedLocales.length > 0) {
    throw new Error(
      `Locales not available in translation.supportedLocales: ${unsupportedLocales.join(", ")}`,
    );
  }

  const mailHost = buildMailHost(hostname, publicBaseUrl);
  if (!mailHost) {
    throw new Error("A valid hostname or public base URL is required.");
  }

  const previousRuntimeConfig = readCliRuntimeConfig();
  const nextRuntimeConfig = structuredClone(previousRuntimeConfig);
  const nextSites = { ...(nextRuntimeConfig.sites ?? {}) };
  const nextOverrides = { ...(nextSites.overrides ?? {}) };
  const nextOverride = { ...(nextOverrides[key] ?? {}) };
  if (nextOverride.sourceLocale) {
    throw new Error(`Site ${key} already has an immutable source locale configured.`);
  }
  nextOverride.sourceLocale = sourceLocale;
  nextOverrides[key] = nextOverride;
  nextSites.overrides = nextOverrides;
  nextRuntimeConfig.sites = nextSites;
  writeCliRuntimeConfig(nextRuntimeConfig);

  let created;
  try {
    created = await createPhiCliSite(getPool(), {
      key,
      name,
      hostname,
      publicBaseUrl,
      defaultLocale,
      availableLocales,
      supportEmail,
      mailHost,
    });
  } catch (error) {
    writeCliRuntimeConfig(previousRuntimeConfig);
    throw error;
  }

  if (json) {
    printJson({
      ok: true,
      action: "site.add",
      key: created.key,
      name: created.name,
      hostname: created.hostname,
      publicBaseUrl: created.publicBaseUrl,
      supportEmail: created.supportEmail,
      sourceLocale,
      defaultLocale: created.defaultLocale,
      availableLocales: created.availableLocales,
    });
    return;
  }

  console.log(`Created site ${created.key}.`);
}

async function deleteSiteByKey(flags: FlagMap, json: boolean) {
  const siteKey = normalizeSiteKey(getRequiredFlag(flags, "key"));
  const site = await deletePhiCliSiteByKey(getPool(), siteKey);
  if (!site) {
    throw new Error(`Site ${siteKey} does not exist.`);
  }

  const runtimeConfig = readCliRuntimeConfig();
  const nextOverrides = { ...(runtimeConfig.sites?.overrides ?? {}) };
  if (siteKey in nextOverrides) {
    delete nextOverrides[siteKey];
    runtimeConfig.sites = {
      ...(runtimeConfig.sites ?? {}),
      overrides: Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined,
    };
    writeCliRuntimeConfig(runtimeConfig);
  }

  if (json) {
    printJson({
      ok: true,
      action: "site.del",
      key: site.key,
      hostname: site.hostname,
    });
    return;
  }

  console.log(`Deleted site ${site.key}.`);
}

async function listSites() {
  return listPhiCliSites(getPool());
}

async function getSiteByKey(siteKeyInput: string): Promise<SiteDeploymentRecord> {
  const siteKey = siteKeyInput.trim().toLowerCase();
  if (!siteKey) {
    throw new Error("Missing --key.");
  }

  const site = await getPhiCliSiteByKey(getPool(), siteKey);
  if (!site) {
    throw new Error(`Site ${siteKey} does not exist.`);
  }
  return {
    ...site,
    sourceLocale: resolvePhiSiteSourceLocale(readCliMergedConfig(), site.key),
  } satisfies SiteDeploymentRecord;
}

/**
 * The root key, read the way a running instance reads it.
 *
 * Every stored secret is unreadable without it, so a CLI that silently generated one on demand would
 * quietly orphan everything written under the previous key.
 */
function requireSecretEncryptionKey(): PhiSecretEncryptionKey {
  const runtime = readPhiRuntimeConfigSync(configRoot);
  const keyHex = runtime.secrets?.encryptionKey?.trim() ?? "";
  if (!keyHex) {
    throw new Error(
      "Missing secrets.encryptionKey in the runtime configuration. Run `phis secret init-key` first.",
    );
  }
  return {
    keyHex,
    version: runtime.secrets?.encryptionKeyVersion ?? PHI_SECRET_INITIAL_KEY_VERSION,
  };
}

/**
 * Where a secret value comes from.
 *
 * Standard input is the way that leaves nothing behind. `--value` exists because a script sometimes
 * has no other option, and it says so out loud, because an argument list is visible to every process
 * on the host and ends up in shell history.
 */
async function readSecretValue(flags: FlagMap) {
  const inline = getOptionalFlag(flags, "value");
  if (inline) {
    console.warn("Reading a secret from --value exposes it to the process list and shell history.");
    return inline;
  }
  if (process.stdin.isTTY) {
    throw new Error("Provide the secret on standard input, or pass --value.");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const value = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/u, "");
  if (!value) {
    throw new Error("Standard input carried no secret.");
  }
  return value;
}

async function resolveSecretIdentity(flags: FlagMap) {
  const addonId = getOptionalFlag(flags, "addon");
  const siteKey = getOptionalFlag(flags, "site");
  const site = siteKey ? await getSiteByKey(siteKey) : null;
  return {
    reference: buildPhiSecretReference({
      owner: addonId ? { kind: "addon", addonId } : { kind: "core" },
      siteKey: site ? site.key : null,
      name: getRequiredFlag(flags, "name"),
    }),
    siteId: site ? site.id : null,
  };
}

function readSiteScaffoldPackageManager(flags: FlagMap): PhiSiteScaffoldPackageManager {
  const value = getOptionalFlag(flags, "package-manager") ?? "pnpm";
  if (value === "pnpm" || value === "npm" || value === "yarn" || value === "bun") return value;
  throw new Error(`Unsupported package manager: ${value}.`);
}

/**
 * The Site Module commands.
 *
 * `add` and `del` record what an operator installed and rewrite the projection in the same step, because
 * for a Module the generated file *is* the application -- there is no separate reconcile the way an
 * Add-on artifact needs one. `sync` exists for the case where the projection and the desired state have
 * drifted, after a scaffold or a hand edit.
 */
/**
 * What a Site needs from its server, and what it is not getting.
 *
 * A Module whose Core capability is missing deactivates itself, which is correct and silent: the feature
 * is gone and the reason is in a log nobody reads until something is reported. This turns that into a
 * command to run after an update.
 *
 * The Site is asked rather than computed, because `phi-server` does not depend on `@phis/ui` and cannot
 * know what a Site requires. It reports the running Site, not a prediction about the next one.
 */
async function runSiteCheckCommand(flags: FlagMap, json: boolean) {
  const site = await getSiteByKey(getRequiredFlag(flags, "key"));
  const mergedConfig = readCliMergedConfig();
  const token = mergedConfig.api?.internalToken?.trim() ?? "";
  if (!token) {
    throw new Error("Missing api.internalToken; the Site refuses an unauthenticated check.");
  }
  const override = getOptionalFlag(flags, "url");
  const instance = resolveSiteInstances(site, mergedConfig.sites)[0];
  if (!override && !instance) {
    throw new Error(`Site ${site.key} has no instance to ask.`);
  }
  const baseUrl = override ?? `http://${instance.host}:${instance.port}`;

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/site/module-diagnostics`, {
    headers: { "x-phi-token": token, accept: "application/json" },
    cache: "no-store",
  }).catch((error: unknown) => {
    throw new Error(
      `Could not reach ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  const body = await response.json().catch(() => null) as {
    ok?: boolean;
    offeredCapabilities?: string[];
    unavailable?: Array<{
      area: string;
      moduleId: string;
      diagnosticCode: string;
      missingCapabilities: string[];
    }>;
    error?: string;
  } | null;

  if (!body || (response.status !== 200 && response.status !== 409)) {
    throw new Error(`Site ${site.key} answered ${response.status}${body?.error ? `: ${body.error}` : ""}.`);
  }

  if (json) {
    printJson(body);
  } else if (body.ok) {
    console.log(
      `${site.key}: every Module has its server capabilities (${body.offeredCapabilities?.length ?? 0} offered).`,
    );
  } else {
    console.log(`${site.key}: ${body.unavailable?.length ?? 0} Module(s) deactivated.`);
    for (const entry of body.unavailable ?? []) {
      const missing = entry.missingCapabilities.join(", ") || "-";
      console.log(`  ${entry.area}/${entry.moduleId}  ${entry.diagnosticCode}  missing: ${missing}`);
    }
    console.log(`Offered: ${(body.offeredCapabilities ?? []).join(", ") || "none"}`);
  }

  if (!body.ok) {
    process.exitCode = 1;
  }
}

/**
 * What the inspection found, said once per package.
 *
 * A package that is not installed yet is reported as such rather than as sound: `phis module add` runs
 * before the package manager does, and silence there would read as a pass.
 */
function reportSiteModulePackages(
  siteKey: string,
  reports: readonly PhiSiteModulePackageReport[],
) {
  if (reports.length === 0) {
    console.log(`${siteKey}: no Site Modules installed.`);
    return;
  }
  for (const report of reports) {
    if (report.root === null) {
      console.log(`  ${report.packageName}  not installed yet -- run this again after installing.`);
      continue;
    }
    if (report.issues.length === 0) {
      console.log(`  ${report.packageName}  ok`);
      continue;
    }
    console.log(`  ${report.packageName}  ${report.issues.length} issue(s)`);
    for (const issue of report.issues) {
      console.log(`    ${issue.code}  ${issue.message}`);
    }
  }
}

async function runSiteModuleCommand(command: string, flags: FlagMap, json: boolean) {
  const requireFlag = (key: string) => {
    const value = getOptionalFlag(flags, key);
    if (!value) {
      throw new Error(`Missing --${key}.`);
    }
    return value;
  };

  if (command === "list") {
    const siteKey = getOptionalFlag(flags, "site");
    const state = readSiteModuleDesiredState(configRoot);
    const rows = siteKey
      ? [[siteKey, state.sites[siteKey]?.modules ?? []] as const]
      : Object.entries(state.sites).map(([key, site]) => [key, site.modules] as const);
    if (json) {
      printJson(Object.fromEntries(rows));
      return;
    }
    if (rows.length === 0) {
      console.log("No Site Modules installed.");
      return;
    }
    for (const [key, modules] of rows) {
      console.log(`${key}: ${modules.length === 0 ? "none" : ""}`);
      for (const entry of modules) {
        console.log(`  ${entry.packageName}  origin=${entry.origin}${entry.spec ? `  spec=${entry.spec}` : ""}`);
      }
    }
    return;
  }

  const site = await getSiteByKey(requireFlag("site"));
  const mergedConfig = readCliMergedConfig();
  const siteRoot = getOptionalFlag(flags, "path") ?? resolveSiteSource(site, mergedConfig.sites).path;
  const state = readSiteModuleDesiredState(configRoot);
  const current = state.sites[site.key]?.modules ?? [];

  if (command === "check") {
    // A Site root that is not there reads as "no package installed" otherwise, which sends an operator
    // looking for the wrong fault.
    if (!existsSync(path.join(siteRoot, "package.json"))) {
      throw new Error(`No Site at ${siteRoot}. Pass --path if the Site lives elsewhere.`);
    }
    const only = getOptionalFlag(flags, "package");
    const targets = only ? current.filter((entry) => entry.packageName === only) : current;
    if (only && targets.length === 0) {
      throw new Error(`${only} is not installed for site ${site.key}.`);
    }
    const reports = targets.map((entry) => inspectSiteModulePackage(siteRoot, entry.packageName));
    if (json) {
      printJson({ site: site.key, root: siteRoot, reports });
    } else {
      reportSiteModulePackages(site.key, reports);
    }
    if (reports.some((report) => report.issues.length > 0)) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "sync") {
    const result = writeSiteModuleProjection(siteRoot, current);
    if (json) {
      printJson({ site: site.key, root: siteRoot, ...result });
    } else {
      console.log(`Wrote the projection for ${site.key} (${result.moduleCount} Module(s)); rebuild the Site.`);
    }
    return;
  }

  if (command === "add") {
    const packageName = requireFlag("package");
    const spec = getOptionalFlag(flags, "spec");
    if (current.some((entry) => entry.packageName === packageName)) {
      throw new Error(`${packageName} is already installed for site ${site.key}.`);
    }
    // A spec means the package is written into the Site's dependencies; without one it has to be
    // resolvable already. Nothing is fetched here either way.
    const entry: PhiSiteModuleEntry = {
      packageName,
      origin: spec ? "resolved" : "local",
      ...(spec ? { spec } : {}),
    };
    state.sites[site.key] = { modules: [...current, entry] };
    if (spec) {
      addSiteModuleDependency(siteRoot, packageName, spec);
    }
    writeSiteModuleDesiredState(configRoot, state);
    const result = writeSiteModuleProjection(siteRoot, state.sites[site.key].modules);
    const report = inspectSiteModulePackage(siteRoot, packageName);
    if (json) {
      printJson({ site: site.key, root: siteRoot, added: entry, report, ...result });
    } else {
      console.log(
        `Installed ${packageName} for ${site.key}. Install dependencies and rebuild the Site; then activate the Module for an Area in the Builder.`,
      );
      reportSiteModulePackages(site.key, [report]);
    }
    if (report.issues.length > 0) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "del") {
    const packageName = requireFlag("package");
    if (!current.some((entry) => entry.packageName === packageName)) {
      throw new Error(`${packageName} is not installed for site ${site.key}.`);
    }
    state.sites[site.key] = {
      modules: current.filter((entry) => entry.packageName !== packageName),
    };
    const removedDependency = removeSiteModuleDependency(siteRoot, packageName);
    writeSiteModuleDesiredState(configRoot, state);
    const result = writeSiteModuleProjection(siteRoot, state.sites[site.key].modules);
    if (json) {
      printJson({ site: site.key, root: siteRoot, removed: packageName, removedDependency, ...result });
    } else {
      console.log(`Removed ${packageName} from ${site.key}; rebuild the Site.`);
    }
    return;
  }

  throw new Error(`Unknown module command: ${command}`);
}

/**
 * Bringing the Core schema up to the release this checkout is.
 *
 * Runs as the serving role, which is what bootstrap does and what makes the tables the serving role's.
 * Repeating it is free: the script has always been `CREATE TABLE IF NOT EXISTS` throughout.
 */
async function runCoreSchemaCommand(command: string, json: boolean) {
  const database = readCliMergedConfig().database;
  const uri = database?.uri?.trim();
  if (!uri) {
    throw new Error(
      `Missing database.uri in ${getConfigPaths().runtime}. The Core schema belongs to the serving ` +
      `role, so it is applied with the serving connection and not the migration one.`,
    );
  }
  const appRoot = getPhiAppRoot();

  if (command === "check") {
    const result = await checkPhiCoreSchema({ appRoot, uri });
    if (json) {
      printJson(result);
    } else if (result.missing.length === 0) {
      console.log(`Core schema is current (${result.declared} tables).`);
      for (const extension of result.missingExtensions) {
        console.log(`  extension ${extension} is not installed.`);
      }
    } else {
      console.log(`${result.missing.length} of ${result.declared} table(s) missing:`);
      for (const table of result.missing) {
        console.log(`  ${table}`);
      }
      console.log("Run phis schema apply.");
    }
    if (result.missing.length > 0) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "apply") {
    const result = await applyPhiCoreSchema({
      appRoot,
      uri,
      migrationRole: readPhiMigrationRoleName(database?.migrationUri),
    });
    if (json) {
      printJson(result);
      return;
    }
    console.log(
      result.created.length === 0
        ? `Core schema was already current (${result.declared} tables).`
        : `Created ${result.created.length} table(s): ${result.created.join(", ")}.`,
    );
    if (result.grantedTo) {
      console.log(`Re-granted REFERENCES on the Core reference tables to ${result.grantedTo}.`);
    }
    return;
  }

  throw new Error(`Unknown schema command: ${command}. Use check or apply.`);
}

/**
 * What roles one installed Add-on declares, read from the desired state on disk.
 *
 * Not from `@/lib/addons/role-granting`, which is `server-only`: the CLI is a plain Node process and
 * would fail to resolve it. The desired state carries the validated manifest anyway -- that is what
 * "code and description travel together as one per-instance unit" buys.
 */
function readDeclaredAddonRoles(addonId: string) {
  const entry = listAddons(configRoot).addons.find((addon) => addon.addonId === addonId);
  return entry ? entry.manifest.roles ?? [] : null;
}

/**
 * Reading and setting the Add-on roles one person holds on one Site.
 *
 * The operator's way in. Every declared policy still has a Site Admin floor, and an operator on the
 * command line is above that -- somebody has to be able to appoint the first person who can appoint
 * others, and it cannot be one of them.
 */
async function runAddonRoleCommand(flags: FlagMap, json: boolean) {
  const siteKey = getOptionalFlag(flags, "site");
  if (!siteKey) {
    throw new Error("Missing --site.");
  }
  const site = await getSiteByKey(siteKey);
  const pool = getPool();
  const grant = getOptionalFlag(flags, "grant");
  const revoke = getOptionalFlag(flags, "revoke");
  const userFlag = getOptionalFlag(flags, "user");
  const addonId = getOptionalFlag(flags, "addon");

  if (grant || revoke) {
    const role = (grant ?? revoke)!;
    if (!addonId) throw new Error("Missing --addon.");
    if (!userFlag) throw new Error("Missing --user.");
    const userId = Number.parseInt(userFlag, 10);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      throw new Error("--user must be a user id.");
    }
    const declared = readDeclaredAddonRoles(addonId);
    if (declared === null) {
      throw new Error(`${addonId} is not installed on this server.`);
    }
    if (!declared.some((entry) => entry.name === role)) {
      throw new Error(
        `${addonId} declares no role "${role}". Declared: ${
          declared.map((entry) => entry.name).join(", ") || "none"
        }.`,
      );
    }
    const changed = grant
      ? await grantPhiServerAddonUserRole(pool, {
        addonId,
        siteId: site.id,
        userId,
        role,
        grantedByUserId: null,
      })
      : await revokePhiServerAddonUserRole(pool, { addonId, siteId: site.id, userId, role });
    if (json) {
      printJson({ site: site.key, addonId, role, userId, changed });
    } else {
      const verb = grant ? "Granted" : "Revoked";
      console.log(
        changed
          ? `${verb} ${role} on ${addonId} for user ${userId} at ${site.key}.`
          : `No change: user ${userId} already ${grant ? "held" : "did not hold"} ${role}.`,
      );
    }
    return;
  }

  if (userFlag) {
    const userId = Number.parseInt(userFlag, 10);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      throw new Error("--user must be a user id.");
    }
    const held = await readPhiSiteUserAddonRoles(pool, { siteId: site.id, userId });
    if (json) {
      printJson({ site: site.key, userId, held });
    } else if (held.length === 0) {
      console.log(`User ${userId} holds no Add-on roles at ${site.key}.`);
    } else {
      for (const entry of held) {
        console.log(`  ${entry.addonId}  ${entry.role}`);
      }
    }
    return;
  }

  // No user named: what could be granted here at all, which is what an operator needs before they can
  // name one.
  const addons = addonId
    ? [addonId]
    : [...new Set(listAddons(configRoot).addons.map((entry) => entry.addonId))];
  const rows = addons.map((id) => ({ addonId: id, roles: readDeclaredAddonRoles(id) ?? [] }));
  if (json) {
    printJson({ site: site.key, addons: rows });
    return;
  }
  for (const row of rows) {
    console.log(`${row.addonId}: ${row.roles.length === 0 ? "declares no roles" : ""}`);
    for (const role of row.roles) {
      const by = "siteAccess" in role.grantableBy
        ? `siteAccess=${role.grantableBy.siteAccess}`
        : `role=${role.grantableBy.role}`;
      console.log(`  ${role.name}  grantableBy ${by}${role.description ? `  -- ${role.description}` : ""}`);
    }
  }
}

async function runSiteScaffoldCommand(
  mode: "init" | "reconcile" | "update",
  siteKeyInput: string | undefined,
  flags: FlagMap,
  json: boolean,
) {
  if (!siteKeyInput?.trim()) throw new Error(`Missing site key for phis ${mode}.`);
  const site = await getSiteByKey(siteKeyInput);
  const mergedConfig = readCliMergedConfig();
  const manager = readSiteScaffoldPackageManager(flags);
  const root = getOptionalFlag(flags, "path") ?? resolveSiteSource(site, mergedConfig.sites).path;
  const apiBaseUrl = getOptionalFlag(flags, "api-base-url") ?? "http://127.0.0.1:3000";
  const result = await reconcilePhiSiteScaffold(root, {
    siteKey: site.key,
    publicBaseUrl: site.publicBaseUrl ?? `https://${site.hostname}`,
    apiBaseUrl,
    internalToken: mergedConfig.api?.internalToken?.trim() ?? "",
    packageManager: manager,
  }, mode === "init" ? "init" : "reconcile");
  const shouldInstall = mode === "update" || flags.get("install") === true;
  if (shouldInstall) {
    await runPhiSitePackageCommand(result.root, manager, resolvePhiSiteInstallArgs(manager, false));
  }
  if (mode === "update") {
    await runPhiSitePackageCommand(result.root, manager, ["run", "typecheck"]);
    await runPhiSitePackageCommand(result.root, manager, ["run", "build"]);
  }
  const release = mode === "update" ? await buildPhiSiteReleaseArtifact(result.root) : null;
  if (json) {
    printJson({ ok: true, action: `site.${mode}`, packageManager: manager, installed: shouldInstall, built: mode === "update", release, ...result });
    return;
  }
  const changed = result.changes.filter((entry) => entry.action !== "unchanged");
  console.log(`${mode === "init" ? "Initialized" : mode === "update" ? `Updated and built release ${release?.releaseId}` : "Reconciled"} ${site.key} at ${result.root}; ${changed.length} file(s) changed.`);
}

async function printSites(flags: FlagMap, json: boolean) {
  const keyFilter = getOptionalFlag(flags, "key")?.toLowerCase();
  const sites = (await listSites())
    .filter((site) => (keyFilter ? site.key.toLowerCase() === keyFilter : true))
    .map((site) => ({
      ...site,
      sourceLocale: resolvePhiSiteSourceLocale(readCliMergedConfig(), site.key),
    }));

  if (json) {
    printJson(sites);
    return;
  }

  if (sites.length === 0) {
    console.log("No sites configured.");
    return;
  }

  for (const site of sites) {
    console.log(
      `${site.key}  enabled=${site.enabled ? "true" : "false"}  hostname=${site.hostname}  name=${site.name}`,
    );
  }
}

async function printSiteConfig(targetInput: string, flags: FlagMap, json: boolean) {
  const target = targetInput.trim().toLowerCase() as SiteConfigTarget;
  const allowedTargets = new Set<SiteConfigTarget>([
    "nginx",
    "apache",
    "systemd",
    "docker-compose",
    "runtime",
  ]);

  if (!allowedTargets.has(target)) {
    throw new Error(`Unsupported site config target: ${targetInput}`);
  }

  const siteKey = getRequiredFlag(flags, "key");
  const site = await getSiteByKey(siteKey);
  const siteSettings = readCliMergedConfig().sites;
  const useSource = target === "nginx" && flags.get("source") === true;

  if (useSource && !hasSiteSourceOverride(site, siteSettings)) {
    throw new Error(`Site ${site.key} has no source override configured.`);
  }

  const config = renderSiteConfig(target, site, siteSettings, {
    useSource,
  });

  if (json) {
    if (target === "runtime") {
      printJson(buildRuntimeSummary(site, siteSettings));
      return;
    }

    printJson({
      target,
      site,
      config,
    });
    return;
  }

  console.log(config);
}

async function updateSiteFields(flags: FlagMap, json: boolean) {
  const siteKey = getRequiredFlag(flags, "key").toLowerCase();
  const current = await getPhiCliSiteByKey(getPool(), siteKey);
  if (!current) {
    throw new Error(`Site ${siteKey} does not exist.`);
  }

  const name = flags.has("name") ? getRequiredFlag(flags, "name") : undefined;

  let supportEmail: string | undefined;
  if (flags.has("support-email") || flags.has("email")) {
    supportEmail = normalizeEmail(getSiteSupportEmailFlag(flags, true) ?? "");
    if (!supportEmail.includes("@")) {
      throw new Error("Expected --support-email to be a valid email address.");
    }
  }

  const hostnameFlag = getOptionalFlag(flags, "hostname");
  const hostname = hostnameFlag ? normalizeHostname(hostnameFlag) : undefined;

  const publicBaseUrl = getOptionalFlag(flags, "public-base-url");
  if (publicBaseUrl) {
    try {
      new URL(publicBaseUrl);
    } catch {
      throw new Error("Expected --public-base-url to be a valid URL.");
    }
  }

  if (!name && !supportEmail && !hostname && !publicBaseUrl) {
    throw new Error(
      "Nothing to set. Provide at least --name, --hostname, --public-base-url, or --support-email.",
    );
  }

  const nextHostname = hostname ?? current.hostname;
  const nextPublicBaseUrl = publicBaseUrl ?? current.publicBaseUrl;
  const nextSupportEmail = supportEmail ?? current.supportEmail;
  const mailHost = buildMailHost(nextHostname, nextPublicBaseUrl);

  if (!mailHost) {
    throw new Error("A valid hostname or public base URL is required.");
  }

  const updated = await updatePhiCliSite(getPool(), {
    siteKey,
    name,
    hostname,
    publicBaseUrl,
    supportEmail,
    mailFrom: `no-reply@${mailHost}`,
    mailFromName: name ?? current.name,
    contactRecipient: nextSupportEmail,
  });
  if (!updated) {
    throw new Error(`Site ${siteKey} does not exist.`);
  }

  if (json) {
    printJson({
      ok: true,
      action: "site.set",
      key: updated.key,
      name: updated.name,
      hostname: updated.hostname,
      publicBaseUrl: updated.publicBaseUrl,
      supportEmail: updated.supportEmail,
    });
    return;
  }

  console.log(`Updated site ${updated.key}.`);
}

async function setSiteEnabled(flags: FlagMap, enabled: boolean, json: boolean) {
  const siteKey = getRequiredFlag(flags, "key").toLowerCase();
  const site = await setPhiCliSiteEnabled(getPool(), siteKey, enabled);
  if (!site) {
    throw new Error(`Site ${siteKey} does not exist.`);
  }

  if (json) {
    printJson({
      ok: true,
      action: enabled ? "site.enable" : "site.disable",
      key: site.key,
      enabled: site.enabled,
    });
    return;
  }

  console.log(`${enabled ? "Enabled" : "Disabled"} site ${site.key}.`);
}

async function addSiteLocale(flags: FlagMap, json: boolean) {
  const siteKey = getRequiredFlag(flags, "key").toLowerCase();
  const locale = getRequiredFlag(flags, "locale").toLowerCase();
  if (!locale) {
    throw new Error("Missing --locale.");
  }

  const supportedLocales = Array.from(
    new Set(
      (
        readCliMergedConfig().translation?.supportedLocales ??
        readCliMergedConfig().translation?.allowedLocales ??
        []
      )
        .map((entry: string) => entry.trim().toLowerCase())
        .filter(Boolean),
    ),
  );

  if (!supportedLocales.includes(locale)) {
    throw new Error(`Locale ${locale} is not available in translation.supportedLocales.`);
  }

  const updated = await addPhiCliSiteLocale(getPool(), siteKey, locale);
  if (!updated) {
    throw new Error(`Site ${siteKey} does not exist.`);
  }

  if (json) {
    printJson({
      ok: true,
      action: "site.locale.add",
      key: updated.key,
      locale,
      availableLocales: updated.availableLocales,
    });
    return;
  }

  console.log(`Added locale ${locale} to site ${updated.key}.`);
}

async function addSuperUser(flags: FlagMap, json: boolean) {
  const email = getRequiredFlag(flags, "email").toLowerCase();
  const password = getRequiredFlag(flags, "password");
  const displayNameValue = flags.get("name");
  const displayName =
    typeof displayNameValue === "string" && displayNameValue.trim()
      ? displayNameValue.trim()
      : undefined;
  const enabled = flags.get("disabled") === true ? false : true;

  const existingUsers = getRuntimeSuperUsers();
  if (existingUsers.some((user) => user.email.toLowerCase() === email)) {
    throw new Error(`Platform operator ${email} already exists.`);
  }

  const timestamp = new Date().toISOString();
  const passwordHash = await hashPassword(password);
  existingUsers.push({
    email,
    displayName,
    passwordHash,
    enabled,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  upsertRuntimeSuperUsers(existingUsers);
  if (json) {
    printJson({
      ok: true,
      action: "operator.add",
      email,
      enabled,
      displayName: displayName ?? null,
    });
    return;
  }

  console.log(`Added platform operator ${email}.`);
}

async function deleteSuperUser(flags: FlagMap, json: boolean) {
  const email = getRequiredFlag(flags, "email").toLowerCase();
  const existingUsers = getRuntimeSuperUsers();
  const nextUsers = existingUsers.filter((user) => user.email.toLowerCase() !== email);

  if (nextUsers.length === existingUsers.length) {
    throw new Error(`Platform operator ${email} does not exist.`);
  }

  upsertRuntimeSuperUsers(nextUsers);
  if (json) {
    printJson({
      ok: true,
      action: "operator.del",
      email,
    });
    return;
  }

  console.log(`Deleted platform operator ${email}.`);
}

async function updateSuperUserPassword(flags: FlagMap, json: boolean) {
  const email = getRequiredFlag(flags, "email").toLowerCase();
  const password = getRequiredFlag(flags, "password");
  const existingUsers = getRuntimeSuperUsers();
  const userIndex = existingUsers.findIndex(
    (user) => user.email.toLowerCase() === email,
  );

  if (userIndex < 0) {
    throw new Error(`Platform operator ${email} does not exist.`);
  }

  const passwordHash = await hashPassword(password);
  existingUsers[userIndex] = {
    ...existingUsers[userIndex],
    passwordHash,
    updatedAt: new Date().toISOString(),
  };
  upsertRuntimeSuperUsers(existingUsers);
  if (json) {
    printJson({
      ok: true,
      action: "operator.passwd",
      email,
    });
    return;
  }

  console.log(`Updated password for ${email}.`);
}

async function setSuperUserEnabled(flags: FlagMap, enabled: boolean, json: boolean) {
  const email = getRequiredFlag(flags, "email").toLowerCase();
  const existingUsers = getRuntimeSuperUsers();
  const userIndex = existingUsers.findIndex(
    (user) => user.email.toLowerCase() === email,
  );

  if (userIndex < 0) {
    throw new Error(`Platform operator ${email} does not exist.`);
  }

  existingUsers[userIndex] = {
    ...existingUsers[userIndex],
    enabled,
    updatedAt: new Date().toISOString(),
  };
  upsertRuntimeSuperUsers(existingUsers);
  if (json) {
    printJson({
      ok: true,
      action: enabled ? "operator.enable" : "operator.disable",
      email,
      enabled,
    });
    return;
  }

  console.log(`${enabled ? "Enabled" : "Disabled"} platform operator ${email}.`);
}

const SKIP_VERSION_CHECK_ENV = "PHIS_SKIP_VERSION_CHECK";

/**
 * A phis older than the root it points at would write formats the instance has already
 * moved past, so it refuses. The other direction is an ordinary upgrade: it says so once
 * and takes the root over.
 */
function enforceInstanceVersion(root: string) {
  if (process.env[SKIP_VERSION_CHECK_ENV]?.trim()) return;

  const check = checkPhiInstanceVersion(root, packageJson.version);

  if (check.status === "behind") {
    throw new Error(
      `This phis is ${packageJson.version}, but ${root} was last operated by ${check.rootVersion}. ` +
        `Use the phis that belongs to this root, or set ${SKIP_VERSION_CHECK_ENV}=1 to override.`,
    );
  }

  if (check.status === "ahead") {
    console.error(
      `Note: ${root} was last operated by phis ${check.rootVersion}, this is ${packageJson.version}.`,
    );
  }

  if (check.status !== "match") {
    writePhiInstanceStamp(root, packageJson.version);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("-v") || args.includes("--version")) {
    const parsed = parseArgv(
      args.filter((value) => value !== "-v" && value !== "--version"),
    );
    printVersion(isJsonOutput(parsed.flags));
    return;
  }

  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    printUsage();
    return;
  }

  const parsed = parseArgv(args);
  const flags = parsed.flags;
  const json = isJsonOutput(flags);
  const root = getOptionalFlag(flags, "root");

  configRoot = root ? resolvePhiConfigPaths(root).root : getDefaultPhiRoot();
  enforceInstanceVersion(configRoot);

  const [group, command, ...remaining] = parsed.positionals;

  if (group === "init") {
    await runSiteScaffoldCommand("init", command, flags, json);
    return;
  }

  if (group === "reconcile") {
    await runSiteScaffoldCommand("reconcile", command, flags, json);
    return;
  }

  if (group === "update") {
    await runSiteScaffoldCommand("update", command, flags, json);
    return;
  }

  if (group === "config" && command === "paths") {
    printConfigPaths(json);
    return;
  }

  if (group === "config" && !command) {
    printMergedConfig();
    return;
  }

  if (group === "config" && command === "validate") {
    validateConfig(json);
    return;
  }

  if (group === "site" && command === "check") {
    await runSiteCheckCommand(flags, json);
    return;
  }

  if (group === "site" && command === "list") {
    await printSites(flags, json);
    return;
  }

  if (group === "site" && command === "add") {
    await createSite(flags, json);
    return;
  }

  if (group === "site" && command === "del") {
    await deleteSiteByKey(flags, json);
    return;
  }

  if (group === "site" && command === "enable") {
    await setSiteEnabled(flags, true, json);
    return;
  }

  if (group === "site" && command === "disable") {
    await setSiteEnabled(flags, false, json);
    return;
  }

  if (group === "site" && command === "set") {
    await updateSiteFields(flags, json);
    return;
  }

  if (group === "site" && command === "locale") {
    const localeAction = remaining[0]?.trim().toLowerCase();
    if (localeAction === "add") {
      await addSiteLocale(flags, json);
      return;
    }

    throw new Error("Unsupported site locale command.");
  }

  if (group === "site" && command === "config") {
    const target = remaining[0];
    if (!target) {
      throw new Error("Missing site config target.");
    }

    if (target === "set") {
      const subject = remaining[1]?.trim().toLowerCase();
      if (subject !== "source") {
        throw new Error("Unsupported site config set target.");
      }

      await setSiteSourceOverride(flags, json);
      return;
    }

    if (target === "add") {
      await addSiteInstance(flags, json);
      return;
    }

    if (target === "del") {
      await deleteSiteInstancesByHost(flags, json);
      return;
    }

    await printSiteConfig(target, flags, json);
    return;
  }

  if (group === "operator" && command === "list") {
    printSuperUsers(flags, json);
    return;
  }

  if (group === "operator" && command === "add") {
    await addSuperUser(flags, json);
    return;
  }

  if (group === "operator" && command === "del") {
    await deleteSuperUser(flags, json);
    return;
  }

  if (group === "operator" && command === "passwd") {
    await updateSuperUserPassword(flags, json);
    return;
  }

  if (group === "operator" && command === "enable") {
    await setSuperUserEnabled(flags, true, json);
    return;
  }

  if (group === "operator" && command === "disable") {
    await setSuperUserEnabled(flags, false, json);
    return;
  }

  if (group === "auth" && command === "import-secrets") {
    const runtimePath = getConfigPaths().runtime;
    const raw = JSON.parse(readFileSync(runtimePath, "utf8")) as {
      auth?: { secrets?: Record<string, string> };
    };
    const secrets = raw.auth?.secrets ?? {};
    const result = await importPhiAuthSecrets(
      getPool(),
      secrets,
      requireSecretEncryptionKey(),
      buildPhiAuthSecretReference,
    );

    // The file loses the field once the rows exist, so nothing can read a stale plaintext afterwards.
    if (result.entries.some((entry) => entry.status === "imported")) {
      const remaining = { ...raw, auth: { ...raw.auth } };
      delete remaining.auth.secrets;
      if (Object.keys(remaining.auth).length === 0) {
        delete (remaining as { auth?: unknown }).auth;
      }
      writeFileSync(runtimePath, `${JSON.stringify(remaining, null, 2)}\n`, "utf8");
    }

    if (json) {
      printJson({ ok: true, action: "auth.import-secrets", ...result });
    } else if (result.entries.length === 0) {
      console.log(`No authentication secrets left in ${runtimePath}.`);
    } else {
      for (const entry of result.entries) {
        console.log(`${entry.status}: ${entry.legacyReference} -> ${entry.reference}`);
      }
      console.log(`Rewrote ${result.rewritten} stored reference(s).`);
    }
    return;
  }

  if (group === "auth" && command === "restore-preset") {
    const result = await restoreFirstPartyAuthPreset(
      getPool(),
      getRequiredFlag(flags, "site"),
    );
    if (json) {
      printJson(result);
    } else {
      console.log(`Restored ${result.moduleId} for site ${result.site}.`);
      for (const area of result.areas) {
        const removed = area.removedProviderModuleIds.length > 0
          ? `; deactivated ${area.removedProviderModuleIds.join(", ")}`
          : "";
        const state = area.changed ? "changed" : "already effective";
        console.log(`  ${area.area}: ${area.source} (${state})${removed}`);
      }
      for (const page of result.pagePresets) {
        const restored = page.restoredFromDeleted ? "; undeleted" : "";
        console.log(`  ${page.area}/${page.presetKey}: ${page.changed ? "cleared" : "already effective"}${restored}`);
      }
      console.log(`  Public /login owner: ${result.publicLoginOwner}`);
      for (const warning of result.warnings) {
        console.log(`  warning: ${warning}`);
      }
    }
    return;
  }

  if (group === "secret" && command === "init-key") {
    const paths = getConfigPaths();
    const runtime = readPhiRuntimeConfigSync(configRoot);
    if (runtime.secrets?.encryptionKey?.trim()) {
      throw new Error(
        "A secret encryption key is already configured. Replacing it would orphan every stored " +
        "secret; rotation is a separate operation.",
      );
    }
    writePhiRuntimeConfigSync({
      ...runtime,
      secrets: {
        ...runtime.secrets,
        encryptionKey: createPhiSecretEncryptionKey(),
        encryptionKeyVersion: PHI_SECRET_INITIAL_KEY_VERSION,
      },
    }, configRoot);
    const result = {
      ok: true,
      action: "secret.init-key",
      keyVersion: PHI_SECRET_INITIAL_KEY_VERSION,
      path: paths.runtime,
    };
    if (json) {
      printJson(result);
    } else {
      console.log(`Wrote a version ${PHI_SECRET_INITIAL_KEY_VERSION} secret encryption key to ${paths.runtime}.`);
      console.log("Every serving instance needs this file before it can read a stored secret.");
    }
    return;
  }

  if (group === "secret" && command === "set") {
    const { reference, siteId } = await resolveSecretIdentity(flags);
    const record = await writePhiServerSecretWithDb(getPool(), {
      reference,
      value: await readSecretValue(flags),
      key: requireSecretEncryptionKey(),
      siteId,
    });
    if (json) {
      printJson({ ok: true, action: "secret.set", ...record });
    } else {
      console.log(`Stored ${record.reference} (key version ${record.keyVersion}).`);
    }
    return;
  }

  if (group === "secret" && command === "list") {
    const addonId = getOptionalFlag(flags, "addon");
    const siteKey = getOptionalFlag(flags, "site");
    const site = siteKey ? await getSiteByKey(siteKey) : null;
    const records = await listPhiServerSecretsWithDb(getPool(), {
      ...(site ? { siteId: site.id } : {}),
      ...(addonId ? { addonId } : {}),
    });
    if (json) {
      printJson({ ok: true, action: "secret.list", secrets: records });
    } else if (records.length === 0) {
      console.log("No secrets stored.");
    } else {
      for (const record of records) {
        console.log(`${record.reference}  key v${record.keyVersion}  updated ${record.updatedAt}`);
      }
    }
    return;
  }

  if (group === "secret" && command === "check") {
    const { reference } = await resolveSecretIdentity(flags);
    let status: "configured" | "missing" | "unreadable" = "missing";
    try {
      status = (await readPhiServerSecretWithDb(getPool(), reference, requireSecretEncryptionKey()))
        ? "configured"
        : "missing";
    } catch {
      // A secret that exists but cannot be decrypted is not the same as one nobody configured, and an
      // operator needs to be able to tell them apart without ever seeing the value.
      status = "unreadable";
    }
    if (json) {
      printJson({ ok: status !== "unreadable", action: "secret.check", reference, status });
    } else {
      console.log(`${reference}: ${status}`);
    }
    if (status === "unreadable") {
      process.exitCode = 1;
    }
    return;
  }

  if (group === "secret" && command === "del") {
    const { reference } = await resolveSecretIdentity(flags);
    const removed = await deletePhiServerSecretWithDb(getPool(), reference);
    if (json) {
      printJson({ ok: true, action: "secret.del", reference, removed });
    } else {
      console.log(removed ? `Removed ${reference}.` : `${reference} was not stored.`);
    }
    return;
  }

  if (group === "media" && command === "check") {
    const fix = Boolean(flags.get("fix"));
    const roots = await checkPhiMediaOwnership(getPool(), { fix });
    const findings = roots.reduce((total, root) => total + root.findings.length, 0);
    if (json) {
      printJson({ ok: findings === 0 || fix, action: "media.check", fix, roots });
      if (findings > 0 && !fix) {
        process.exitCode = 1;
      }
      return;
    }
    for (const root of roots) {
      if (root.missing) {
        console.log(`${root.rootDir}: missing (named by Storage Profile ${root.profiles.join(", ")})`);
        continue;
      }
      const owner = `${root.expectedUid}:${root.expectedGid}`;
      if (root.findings.length === 0) {
        console.log(`${root.rootDir}: ${root.scanned} entries, all owned by ${owner}.`);
        continue;
      }
      console.log(
        fix
          ? `${root.rootDir}: repaired ${root.fixed} of ${root.scanned} entries to ${owner}.`
          : `${root.rootDir}: ${root.findings.length} of ${root.scanned} entries are not owned by ${owner}.`,
      );
      for (const finding of root.findings.slice(0, 5)) {
        console.log(`  ${finding.path}  (${finding.uid}:${finding.gid})`);
      }
      if (root.findings.length > 5) {
        console.log(`  ... and ${root.findings.length - 5} more`);
      }
    }
    if (findings > 0 && !fix) {
      console.log("Run `phis media check --fix` to give them back to the Server's own account.");
      process.exitCode = 1;
    }
    return;
  }

  if (group === "licenses" && command === "check") {
    const report = checkPhiDependencyLicenses({ packageDir: getOptionalFlag(flags, "package") });
    if (json) {
      printJson({ ok: report.blocking.length === 0, action: "licenses.check", ...report });
      if (report.blocking.length > 0) {
        process.exitCode = 1;
      }
      return;
    }
    console.log(
      `${report.packageName}: ${report.scannedProduction} production and ${report.scannedDevelopment} development dependencies.`,
    );
    if (report.findings.length === 0) {
      console.log("Every one of them is permissively licensed.");
      return;
    }
    for (const finding of report.findings) {
      const marker = finding.scope === "development" ? "build only" : finding.acknowledged ? "accepted" : "BLOCKING";
      console.log(`  [${marker}] ${finding.name}@${finding.version} -- ${finding.license} (${finding.licenseClass})`);
      if (finding.acknowledged) {
        console.log(`      ${finding.acknowledged}`);
      }
    }
    if (report.blocking.length > 0) {
      console.log(
        "\nThese reach a distributed artifact and have not been accepted. Either drop them, or record" +
          " the obligation in THIRD-PARTY-NOTICES.md and add it to ACKNOWLEDGED in src/cli/licenses.mts.",
      );
      process.exitCode = 1;
    }
    return;
  }

  if (group === "storage") {
    // The CLI already holds the encryption key; `secret check` decrypts with the same call. A Provider
    // that has to write a bucket rule needs its credential, and there is no reason to reach for the
    // Server to get it.
    const readStorageSecret = (reference: string) =>
      readPhiServerSecretWithDb(getPool(), reference, requireSecretEncryptionKey());
    const handlers = {
      list: () => listStorageProfiles(getPool(), flags),
      add: () => addStorageProfile(configRoot, getPool(), flags, readStorageSecret),
      set: () => setStorageProfile(configRoot, getPool(), flags, readStorageSecret),
      use: () => useStorageProfile(getPool(), flags),
      del: () => removeStorageProfile(getPool(), flags),
      cors: async () => ({
        ok: true,
        action: "storage.cors" as const,
        storages: await reconcileStorageCors(configRoot, getPool(), readStorageSecret),
      }),
      probe: () => probeStorageProfiles(configRoot, getPool(), flags, readStorageSecret),
    } as const;
    const handler = handlers[command as keyof typeof handlers];
    if (!handler) {
      throw new Error("Unknown storage command. Use: list, add, set, use, del, cors, probe");
    }
    const result = await handler();
    if (json) {
      printJson(result);
      return;
    }
    if (result.action === "storage.list") {
      for (const profile of result.profiles) {
        console.log(
          `${profile.key}  #${profile.id}  ${profile.providerId}` +
          `${profile.secretReference ? `  secret=${profile.secretReference}` : ""}`,
        );
        console.log(`  ${JSON.stringify(profile.config)}`);
      }
      for (const space of result.spaces) {
        console.log(`space #${space.spaceId} (${space.scope}) uses profile #${space.defaultStorageProfileId}`);
      }
    } else if (result.action === "storage.use") {
      console.log(`Site Space of ${result.site} now writes new uploads to "${result.key}".`);
      console.log(result.note);
    } else if (result.action === "storage.cors") {
      for (const storage of result.storages) {
        console.log(
          storage.applied
            ? `${storage.identity}: ${storage.origins.join(" ") || "(no origin, rule removed)"}`
            : `${storage.identity}: FAILED ${storage.error}`,
        );
      }
    } else if (result.action === "storage.del") {
      console.log(`Removed Storage Profile "${result.key}" from ${result.site}.`);
    } else if (result.action === "storage.probe") {
      for (const profile of result.profiles) {
        console.log(
          `${profile.key}  ${profile.providerId}  ` +
          (profile.probed
            ? `${profile.writable ? "writable" : "NOT WRITABLE"}, ` +
              `sha256 ${profile.verifiesSha256 ? "verified by the storage" : "not verified"}`
            : "not probed"),
        );
        for (const finding of profile.findings) {
          console.log(`  ${finding}`);
        }
      }
    } else {
      console.log(
        `${result.action === "storage.add" ? "Added" : "Updated"} Storage Profile ` +
        `"${result.profile.key}" (#${result.profile.id}) on ${result.site}.`,
      );
      for (const storage of result.cors) {
        console.log(
          storage.applied
            ? `  CORS ${storage.identity}: ${storage.origins.join(" ") || "(no origin, rule removed)"}`
            : `  CORS ${storage.identity}: FAILED ${storage.error}`,
        );
      }
    }
    return;
  }

  if (group === "module") {
    await runSiteModuleCommand(command, flags, json);
    return;
  }

  if (group === "addon" && command === "list") {
    const result = listAddons(configRoot);
    if (json) {
      printJson(result);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    for (const entry of result.invalid) {
      console.log(`${entry.addonId}  DOES NOT VALIDATE against this release`);
      for (const issue of entry.issues) {
        console.log(`    ${issue}`);
      }
    }
    if (result.invalid.length > 0) {
      process.exitCode = 1;
    }
    if (result.addons.length === 0) {
      console.log("No server Add-ons installed.");
    } else {
      for (const addon of result.addons) {
        console.log(
          `${addon.addonId}  enabled=${addon.enabled ? "true" : "false"}  package=${addon.packageName}@${addon.packageVersion}`,
        );
      }
    }
    return;
  }

  if (group === "addon" && command === "check") {
    const result = await checkAddons(configRoot);
    if (json) {
      printJson(result);
    } else if (result.ok) {
      console.log(`Validated ${result.addons.length} server Add-on(s).`);
      for (const search of result.unindexedSearches ?? []) {
        console.log(
          `  ${search.addonId}: query "${search.query}" searches ${search.table}.${search.column} ` +
          "with no text index on it, and will read the whole table.",
        );
      }
    } else {
      console.log(`${result.invalid?.length ?? 0} Add-on(s) no longer validate against this release:`);
      for (const entry of result.invalid ?? []) {
        console.log(`  ${entry.addonId}`);
        for (const issue of entry.issues) {
          console.log(`    ${issue}`);
        }
      }
      if (result.hint) {
        console.log(result.hint);
      }
    }
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (group === "addon" && command === "install") {
    const result = await installAddon(configRoot, flags);
    if (json) {
      printJson(result);
    } else {
      console.log(
        `Installed ${result.addon.addonId} disabled; reconcile and enable it after migrations.`,
      );
    }
    return;
  }

  if (group === "addon" && command === "upgrade") {
    const result = await upgradeAddon(configRoot, flags);
    if (json) {
      printJson(result);
    } else {
      const moved = result.from === result.to
        ? `replaced ${result.addonId} ${result.to} in place`
        : `upgraded ${result.addonId} ${result.from} to ${result.to}`;
      console.log(
        `${moved}; run addon ${result.schemaChanged ? "migrate, then " : ""}reconcile for the deployed release.`,
      );
      if (result.previousArtifactKept) {
        console.log(`Kept ${result.previousArtifactKept} for a rollback.`);
      }
    }
    return;
  }

  if (group === "addon" && command === "remove") {
    const result = await removeAddon(configRoot, flags);
    if (json) {
      printJson(result);
    } else {
      console.log(`Removed ${result.addonId} (${result.packageName}).`);
    }
    return;
  }

  if (group === "schema") {
    await runCoreSchemaCommand(command, json);
    return;
  }

  if (group === "addon" && command === "role") {
    await runAddonRoleCommand(flags, json);
    return;
  }

  if (group === "addon" && command === "enable") {
    const result = await setAddonEnabled(configRoot, flags, true);
    if (json) {
      printJson(result);
    } else {
      console.log(
        `Prepared ${result.addon?.addonId} as enabled; run addon reconcile for the deployed release.`,
      );
    }
    return;
  }

  if (group === "addon" && command === "disable") {
    const result = await setAddonEnabled(configRoot, flags, false);
    if (json) {
      printJson(result);
    } else {
      console.log(
        `Prepared ${result.addon?.addonId} as disabled; run addon reconcile for the deployed release.`,
      );
    }
    return;
  }

  if (group === "addon" && command === "migrate") {
    const result = await migrateAddons(configRoot, flags, getMigrationPool(), getServingRole());
    if (json) {
      printJson(result);
    } else {
      for (const outcome of result.outcomes) {
        if (outcome.action === "no-schema") {
          console.log(`${outcome.addonId} owns no tables.`);
        } else if (outcome.action === "unchanged") {
          console.log(`${outcome.addonId} is already at schema version ${outcome.appliedVersion}.`);
        } else {
          console.log(
            `Applied schema version ${outcome.appliedVersion} of ${outcome.addonId} into ` +
            `${outcome.schemaName}:`,
          );
          for (const statement of outcome.statements) {
            console.log(`  - ${statement}`);
          }
        }
      }
    }
    return;
  }

  if (group === "addon" && command === "purge") {
    const result = await purgeAddon(configRoot, flags, getMigrationPool());
    if (json) {
      printJson(result);
    } else {
      console.log(
        result.schemaName
          ? `Dropped schema ${result.schemaName} and every record of ${result.addonId}.`
          : `Removed every record of ${result.addonId}, which owned no tables.`,
      );
    }
    return;
  }

  if (group === "addon" && command === "job") {
    const addonId = getRequiredFlag(flags, "addon");
    const jobId = getRequiredFlag(flags, "job");
    const site = await getSiteByKey(getRequiredFlag(flags, "site"));
    /*
     * Posted to the serving instance rather than run here. The Add-on is loaded there, against the
     * release that instance actually serves, and the CLI stays a caller instead of becoming a second
     * runtime that would have to reproduce the loader, the pool, and the capability bindings.
     */
    const mergedConfig = readCliMergedConfig();
    const apiBaseUrl = (getOptionalFlag(flags, "api-base-url")
      ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
    const internalToken = mergedConfig.api?.internalToken?.trim() ?? "";
    if (!internalToken) {
      throw new Error("Missing api.internalToken; a job is started through the serving instance.");
    }
    const response = await fetch(`${apiBaseUrl}/api/v1/addons/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-phi-token": internalToken },
      body: JSON.stringify({ addonId, jobId, siteKey: site.key }),
    });
    const outcome = await response.json().catch(() => ({ error: "The server answered unreadably." }));
    if (json) {
      printJson(outcome);
    } else if (response.ok) {
      console.log(`Ran ${addonId} job ${jobId} for ${site.key} (run ${outcome.runId}).`);
    } else {
      console.error(`Job ${jobId} did not run for ${site.key}: ${outcome.error ?? response.status}`);
    }
    if (!response.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (group === "addon" && command === "forget") {
    const result = forgetAddon(configRoot, flags);
    if (json) {
      printJson(result);
    } else {
      console.log(
        `Forgot ${result.addonId}; ${result.remaining} Add-on(s) left in the desired state. ` +
        "Its artifact is still on disk -- run addon check to see what is unreferenced.",
      );
    }
    return;
  }

  if (group === "addon" && command === "site") {
    const addonId = getRequiredFlag(flags, "addon");
    const wantsEnable = flags.get("enable") === true;
    const wantsDisable = flags.get("disable") === true;
    if (wantsEnable && wantsDisable) {
      throw new Error("Pass --enable or --disable, not both.");
    }
    if (!wantsEnable && !wantsDisable) {
      const states = await readPhiServerAddonSiteStates(getPool(), addonId);
      if (json) {
        printJson({ ok: true, addon: addonId, sites: states });
      } else if (states.length === 0) {
        console.log(`${addonId} is not activated for any Site.`);
      } else {
        for (const state of states) {
          console.log(
            `site=${state.siteId}  requested=${state.requestedEnabled ? "true" : "false"}  ` +
            `configuration=${state.configurationStatus}  effective=${state.effectiveStatus}`,
          );
        }
      }
      return;
    }
    const site = await getSiteByKey(getRequiredFlag(flags, "site"));
    const declaredModules = readInstalledAddonModules(configRoot, addonId);
    const modulePackage = readInstalledAddonPackageName(configRoot, addonId);
    const siteModules = readSiteModuleDesiredState(configRoot).sites[site.key]?.modules ?? [];
    const moduleInstalled = siteModules.some((entry) => entry.packageName === modulePackage);
    if (wantsEnable && declaredModules.length > 0 && !moduleInstalled) {
      /*
       * The Module half is installed and built before the Add-on is switched on, not after.
       *
       * That order costs nothing and removes a state: a Module whose Add-on is not enabled for the Site
       * deactivates itself -- the capability snapshot is per Site, and an unavailable provider drops
       * the Module out of routes, controllers and widgets while its selection stays recorded. So the
       * build can happen first, harmlessly, and enabling is then the cheap step that takes effect at
       * once, with no second build behind it. Enabling first would instead leave a Site with routes and
       * no surface until somebody remembers to build.
       */
      if (flags.get("without-module") !== true) {
        throw new Error(
          `${addonId} has a Module half (${modulePackage}) that ${site.key} does not have. ` +
          `Run phis module add --site ${site.key} --package ${modulePackage}, rebuild the Site, ` +
          "then enable. Pass --without-module to enable the server half on its own.",
        );
      }
    }
    const state = await setPhiServerAddonSiteEnabled(getPool(), {
      addonId,
      siteId: site.id,
      enabled: wantsEnable,
      configurationStatus: wantsEnable
        ? resolvePhiServerAddonConfigurationStatus(
          readInstalledAddonSettings(configRoot, addonId),
          await readPhiServerAddonSettings(getPool(), addonId, site.id),
        )
        : undefined,
    });
    if (!state) {
      throw new Error(`${addonId} was not activated for ${site.key}; there was nothing to disable.`);
    }
    const groups = wantsEnable
      ? await ensurePhiServerAddonSiteGroups(getPool(), {
        addonId,
        siteId: site.id,
        declared: readInstalledAddonGroups(configRoot, addonId),
      })
      : await retirePhiServerAddonSiteGroups(getPool(), { addonId, siteId: site.id });
    if (json) {
      printJson({ ok: true, addon: addonId, site: site.key, state, groups });
    } else {
      console.log(
        `${addonId} is now ${wantsEnable ? "requested" : "withdrawn"} for ${site.key}.`,
      );
      for (const entry of groups) {
        console.log(`  group ${entry.key} ${entry.action}`);
      }
      if (wantsEnable && declaredModules.length > 0 && !moduleInstalled) {
        console.log(`  warning: the Module half ${modulePackage} is not installed here.`);
      }
      if (!wantsEnable && moduleInstalled) {
        console.log(
          `  ${modulePackage} deactivates itself now; remove it with phis module del and rebuild ` +
          "when it should go for good.",
        );
      }
      if (wantsEnable && state.configurationStatus !== "ready") {
        console.log(`  configuration is ${state.configurationStatus}; run phis addon config --site ${site.key}.`);
      }
    }
    return;
  }

  if (group === "addon" && command === "config") {
    const addonId = getRequiredFlag(flags, "addon");
    const site = await getSiteByKey(getRequiredFlag(flags, "site"));
    const declared = readInstalledAddonSettings(configRoot, addonId);
    const action = getOptionalFlag(flags, "name") == null ? "list" : "set";
    if (action === "list") {
      const stored = await readPhiServerAddonSettings(getPool(), addonId, site.id);
      const rows = declared.map((descriptor) => ({
        name: descriptor.name,
        type: descriptor.type,
        description: descriptor.description ?? null,
        value: stored[descriptor.name] ?? descriptor.default ?? null,
        configured: descriptor.name in stored,
      }));
      if (json) {
        printJson({ ok: true, addon: addonId, site: site.key, settings: rows });
      } else if (rows.length === 0) {
        console.log(`${addonId} declares nothing configurable.`);
      } else {
        for (const row of rows) {
          console.log(
            `${row.name}  ${row.type}  ${row.configured ? "" : "(default) "}${String(row.value)}` +
            (row.description ? `  -- ${row.description}` : ""),
          );
        }
      }
      return;
    }
    const name = getRequiredFlag(flags, "name");
    const descriptor = declared.find((entry) => entry.name === name);
    if (!descriptor) {
      throw new Error(
        `${addonId} declares no setting named "${name}". Run without --name to see what it does.`,
      );
    }
    const raw = getOptionalFlag(flags, "value");
    // Absent `--value` clears the setting, which is how a Site goes back to the declared default.
    const value = raw == null
      ? null
      : (() => {
        const parsed = parsePhiServerAddonSettingValue(descriptor, raw);
        if ("error" in parsed) {
          throw new Error(`${name}: ${parsed.error}`);
        }
        return parsed.value;
      })();
    const written = await writePhiServerAddonSetting(getPool(), {
      addonId,
      siteId: site.id,
      name,
      value,
      declared,
    });
    if (!written) {
      throw new Error(
        `${addonId} is not activated for ${site.key}; there is no row to configure. Enable it first.`,
      );
    }
    if (json) {
      printJson({ ok: true, addon: addonId, site: site.key, name, value });
    } else {
      console.log(
        value === null
          ? `Cleared ${name} for ${addonId} on ${site.key}; the declared default applies.`
          : `Set ${name} for ${addonId} on ${site.key}.`,
      );
    }
    return;
  }

  if (group === "addon" && command === "reconcile") {
    const result = await reconcileAddons(configRoot, flags, getPool());
    if (json) {
      printJson(result);
    } else {
      console.log(
        `Reconciled release ${result.releaseBuildId} with ${result.addons.length} server Add-on(s).`,
      );
    }
    return;
  }

  throw new Error(`Unknown command: ${args.join(" ")}`);
}

main()
  .catch((error) => {
    const message =
      error instanceof Error ? error.message : "Unknown phis-cli failure.";
    const json = process.argv.includes("--json") || process.argv.includes("-j");
    if (json) {
      logCliError("cli.command.failed", message, { json: true });
      console.error(
        JSON.stringify(
          {
            ok: false,
            error: message,
          },
          null,
          2,
          ),
      );
    } else {
      logCliError("cli.command.failed", message);
      console.error(message);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    if (pool) {
      await pool.end();
      pool = null;
    }
  });
