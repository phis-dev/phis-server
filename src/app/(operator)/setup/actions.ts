"use server";

import { randomBytes } from "node:crypto";

import { redirect } from "next/navigation";

import type { BootstrapLocale } from "@/bootstrap/i18n";
import {
  applyPhiBootstrapSchema,
  createPhiBootstrapSites,
  grantPhiAddonCoreReferences,
  verifyPhiDatabaseWriteAccess,
  type PhiBootstrapSiteInput,
} from "@/db/bootstrap";
import {
  readMergedPhiConfigSync,
  readPhiRuntimeConfigSync,
  writePhiRuntimeConfigSync,
} from "@/lib/config-files";
import { resetPhisConfigCache } from "@/lib/config";
import { requirePhisOperatorSurface } from "@/lib/operator-surfaces";
import { hashPassword } from "@/lib/password-core";

/**
 * Every action here writes the installation's configuration, and a Server Action is an endpoint of its
 * own: its id sits in the static chunks, which are served after setup as before it, and a POST that
 * names it runs the function without the layout that gates the page. So each one asks for itself.
 */
function requireSetupSurface() {
  requirePhisOperatorSurface("setup");
}

function readStoredDatabasePassword() {
  const uri = readPhiRuntimeConfigSync().database?.uri?.trim();
  if (!uri) {
    return "";
  }
  try {
    return decodeURIComponent(new URL(uri).password);
  } catch {
    return "";
  }
}

function isValidBootstrapPassword(password: string) {
  return password.length >= 8 && /[^A-Za-z0-9]/.test(password);
}

function buildOperatorStepHref(locale: BootstrapLocale, saved?: boolean) {
  const searchParams = new URLSearchParams({
    lang: locale,
    step: "operator",
  });

  if (saved) {
    searchParams.set("saved", "1");
  }

  return `/setup?${searchParams.toString()}`;
}

function buildDatabaseStepHref(
  locale: BootstrapLocale,
  error?: string,
) {
  const searchParams = new URLSearchParams({
    lang: locale,
    step: "database",
  });

  if (error) {
    searchParams.set("dbError", error);
  }

  return `/setup?${searchParams.toString()}`;
}

function buildTranslationsStepHref(
  locale: BootstrapLocale,
  error?: string,
) {
  const searchParams = new URLSearchParams({
    lang: locale,
    step: "translations",
  });

  if (error) {
    searchParams.set("translationError", error);
  }

  return `/setup?${searchParams.toString()}`;
}

function buildSchemaStepHref(
  locale: BootstrapLocale,
  error?: string,
  applied?: boolean,
) {
  const searchParams = new URLSearchParams({
    lang: locale,
    step: "schema",
  });

  if (error) {
    searchParams.set("schemaError", error);
  }

  if (applied) {
    searchParams.set("schemaApplied", "1");
  }

  return `/setup?${searchParams.toString()}`;
}

function buildSiteStepHref(
  locale: BootstrapLocale,
  error?: string,
) {
  const searchParams = new URLSearchParams({
    lang: locale,
    step: "site",
  });

  if (error) {
    searchParams.set("siteError", error);
  }

  return `/setup?${searchParams.toString()}`;
}

function buildFinishStepHref(
  locale: BootstrapLocale,
  error?: string,
) {
  const searchParams = new URLSearchParams({
    lang: locale,
    step: "finish",
  });

  if (error) {
    searchParams.set("finishError", error);
  }

  return `/setup?${searchParams.toString()}`;
}

function buildDatabaseUri({
  host,
  port,
  database,
  user,
  password,
  sslMode,
}: {
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  sslMode: string;
}) {
  const url = new URL(`postgresql://${host}`);
  url.port = port || "5432";
  url.pathname = `/${database}`;
  url.username = user;
  url.password = password;

  if (sslMode === "require") {
    url.searchParams.set("sslmode", "require");
  }

  return url.toString();
}

function normalizeHostname(value: string) {
  return value.trim().toLowerCase();
}

function normalizeSiteKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

function buildAvailableLocales(defaultLocale: string) {
  const mergedConfig = readMergedPhiConfigSync();
  const configuredLocales =
    (
      mergedConfig.translation?.supportedLocales ??
      mergedConfig.translation?.allowedLocales ??
      []
    ).map((value) => value.trim().toLowerCase()) ??
    [];

  return [...new Set([defaultLocale, ...configuredLocales].filter(Boolean))];
}

export async function createPlatformSuperUser(
  locale: BootstrapLocale,
  formData: FormData,
) {
  requireSetupSurface();
  const displayName = String(formData.get("displayName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!displayName || !email || !password || !isValidBootstrapPassword(password)) {
    redirect(buildOperatorStepHref(locale));
  }

  const runtimeConfig = readPhiRuntimeConfigSync();
  const existingUsers = runtimeConfig.platformSuperUsers ?? [];

  if (existingUsers.length > 0) {
    redirect(buildOperatorStepHref(locale, true));
  }

  const now = new Date().toISOString();
  const passwordHash = await hashPassword(password);

  writePhiRuntimeConfigSync({
    ...runtimeConfig,
    platformSuperUsers: [
      {
        email,
        displayName,
        passwordHash,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
  });

  redirect(buildOperatorStepHref(locale, true));
}

export async function saveDatabaseConnection(
  locale: BootstrapLocale,
  nextStepHref: string,
  formData: FormData,
) {
  requireSetupSurface();
  const host = String(formData.get("host") ?? "").trim();
  const port = String(formData.get("port") ?? "").trim();
  const database = String(formData.get("database") ?? "").trim();
  const user = String(formData.get("user") ?? "").trim();
  // The form never carries the stored password back -- it would sit in the page's HTML -- so an empty
  // field keeps the one the runtime config holds.
  const password = String(formData.get("password") ?? "") || readStoredDatabasePassword();
  const sslMode = formData.get("sslMode") === "on" ? "require" : "disable";

  if (!host || !port || !database || !user || !password) {
    redirect(buildDatabaseStepHref(locale, "Please complete all database fields."));
  }

  const connectionString = buildDatabaseUri({
    host,
    port,
    database,
    user,
    password,
    sslMode,
  });

  try {
    await verifyPhiDatabaseWriteAccess(connectionString);
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : "Database connection failed.";
    redirect(buildDatabaseStepHref(locale, message));
  }

  const runtimeConfig = readPhiRuntimeConfigSync();
  writePhiRuntimeConfigSync({
    ...runtimeConfig,
    database: {
      ...runtimeConfig.database,
      uri: connectionString,
    },
  });

  redirect(nextStepHref);
}

export async function saveTranslationSettings(
  locale: BootstrapLocale,
  nextStepHref: string,
  formData: FormData,
) {
  requireSetupSurface();
  const mode = String(formData.get("translationMode") ?? "").trim();
  const deeplKey = String(formData.get("deeplKey") ?? "").trim();
  const deeplEndpoint = String(formData.get("deeplEndpoint") ?? "").trim();

  if (mode !== "deepl" && mode !== "cdn+deepl" && mode !== "add-on" && mode !== "none") {
    redirect(buildTranslationsStepHref(locale, "Please choose a translation mode."));
  }

  if (mode === "deepl" && (!deeplKey || !deeplEndpoint)) {
    redirect(
      buildTranslationsStepHref(
        locale,
        "DeepL key and API endpoint are required for AI-assisted translations.",
      ),
    );
  }

  const runtimeConfig = readPhiRuntimeConfigSync();

  writePhiRuntimeConfigSync({
    ...runtimeConfig,
    translation: {
      ...runtimeConfig.translation,
      mode,
    },
    deepl:
      mode === "deepl"
        ? {
            ...runtimeConfig.deepl,
            apiKey: deeplKey,
            apiUrl: deeplEndpoint,
          }
        : undefined,
  });

  redirect(nextStepHref);
}

/**
 * The migration role's name, as the separate connection string carries it.
 *
 * Absent is a legitimate answer: an installation that has not configured migration authority yet gets
 * no grants rather than a failed bootstrap, and the same call run later fills them in.
 */
function readMigrationRoleName(migrationUri: string | undefined) {
  const uri = migrationUri?.trim();
  if (!uri) return null;
  try {
    const username = decodeURIComponent(new URL(uri).username);
    return username.length > 0 ? username : null;
  } catch {
    return null;
  }
}

export async function applySchemaBootstrap(
  locale: BootstrapLocale,
  nextStepHref: string,
) {
  requireSetupSurface();
  const runtimeConfig = readPhiRuntimeConfigSync();
  const connectionString = runtimeConfig.database?.uri?.trim();

  if (!connectionString) {
    redirect(buildSchemaStepHref(locale, "No database connection configured."));
  }

  try {
    await applyPhiBootstrapSchema(connectionString);
    // Without this the first Add-on that references a Site fails at migration time, long after anyone
    // would think to look at the roles. It runs here because this is where the tables come into being.
    const migrationRole = readMigrationRoleName(runtimeConfig.database?.migrationUri);
    if (migrationRole) {
      await grantPhiAddonCoreReferences(connectionString, migrationRole);
    }
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : "Schema creation failed.";
    redirect(buildSchemaStepHref(locale, message));
  }

  redirect(nextStepHref);
}

export async function saveInitialSites(
  locale: BootstrapLocale,
  nextStepHref: string,
  formData: FormData,
) {
  requireSetupSurface();
  const createDemoSite = formData.get("createDemoSite") === "on";
  const createCustomSite = formData.get("createCustomSite") === "on";

  if (!createDemoSite && !createCustomSite) {
    redirect(nextStepHref);
  }

  const runtimeConfig = readPhiRuntimeConfigSync();
  const connectionString = runtimeConfig.database?.uri?.trim();

  if (!connectionString) {
    redirect(buildSiteStepHref(locale, "No database connection configured."));
  }

  const siteKey = normalizeSiteKey(String(formData.get("siteKey") ?? ""));
  const siteName = String(formData.get("siteName") ?? "").trim();
  const siteHostname = normalizeHostname(String(formData.get("siteHostname") ?? ""));
  const siteBaseUrl = String(formData.get("siteBaseUrl") ?? "").trim();
  const siteDefaultLocale = String(formData.get("siteDefaultLocale") ?? "en")
    .trim()
    .toLowerCase();
  const siteSupportEmail = String(formData.get("siteSupportEmail") ?? "")
    .trim()
    .toLowerCase();

  if (createCustomSite) {
    if (!siteKey || !siteName || !siteHostname || !siteBaseUrl || !siteSupportEmail) {
      redirect(buildSiteStepHref(locale, "Please complete all site fields."));
    }

    try {
      new URL(siteBaseUrl);
    } catch {
      redirect(buildSiteStepHref(locale, "Please provide a valid public base URL."));
    }
  }

  const sites: PhiBootstrapSiteInput[] = [];
  if (createDemoSite) {
    sites.push({
      key: "demo",
      name: "Demo site",
      hostname: "demo.localhost",
      publicBaseUrl: "http://demo.localhost",
      defaultLocale: "en",
      availableLocales: buildAvailableLocales("en"),
      supportEmail: "hello@demo.localhost",
      mailHost: "demo.localhost",
    });
  }
  if (createCustomSite) {
    const defaultLocale = siteDefaultLocale || "en";
    const mailHost = buildMailHost(siteHostname, siteBaseUrl);
    if (!mailHost) {
      redirect(buildSiteStepHref(locale, "A valid hostname or public base URL is required."));
    }
    sites.push({
      key: siteKey,
      name: siteName,
      hostname: siteHostname,
      publicBaseUrl: siteBaseUrl,
      defaultLocale,
      availableLocales: buildAvailableLocales(defaultLocale),
      supportEmail: siteSupportEmail,
      mailHost,
    });
  }
  try {
    await createPhiBootstrapSites(connectionString, sites);
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : "Site creation failed.";
    redirect(buildSiteStepHref(locale, message));
  }

  redirect(nextStepHref);
}

export async function completeBootstrapSetup(
  locale: BootstrapLocale,
  formData: FormData,
) {
  requireSetupSurface();
  const acceptedTerms = formData.get("acceptedTerms") === "on";

  if (!acceptedTerms) {
    redirect(buildFinishStepHref(locale, "Please accept the terms before continuing."));
  }

  const runtimeConfig = readPhiRuntimeConfigSync();
  const internalToken = runtimeConfig.api?.internalToken?.trim() || randomBytes(32).toString("hex");
  // The operator surface signs with a key of its own, never with the token the Sites hold.
  const sessionSecret = runtimeConfig.operator?.sessionSecret?.trim() || randomBytes(32).toString("hex");
  writePhiRuntimeConfigSync({
    ...runtimeConfig,
    api: {
      ...runtimeConfig.api,
      internalToken,
    },
    operator: {
      ...runtimeConfig.operator,
      sessionSecret,
    },
    bootstrap: {
      ...runtimeConfig.bootstrap,
      enabled: false,
    },
  });
  resetPhisConfigCache();

  redirect("/operator");
}
