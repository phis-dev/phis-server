"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createSite, deleteSite, listSites, updateSiteSettings } from "@/db/sites";
import { deleteSiteTranslatedVariantsForLocale } from "@/db/translations";
import { isBootstrapEnabled } from "@/lib/config";
import {
  readMergedPhiConfigSync,
  readPhiRuntimeConfigSync,
  writePhiRuntimeConfigSync,
} from "@/lib/config-files";
import { resetPhiServerConfigCache } from "@/lib/config";
import { getOperatorSession } from "@/lib/operator-auth";
import { PHIS_TOKEN_HEADER } from "@/lib/constants/http-headers";
import {
  getConfiguredCdnBaseUrlSync,
  getConfiguredTranslationSupportedLocalesSync,
  normalizeTranslationMode,
  resolveTranslationLocaleSourceState,
} from "@/lib/translation-locale-options";

const DEFAULT_DEEPL_TRANSLATE_URL = "https://api-free.deepl.com/v2/translate";

function createTimeoutSignal(timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timeout);
    },
  };
}

async function verifyDeepLMode(input: { apiKey: string; apiUrl: string }) {
  const apiKey = input.apiKey.trim();
  const apiUrl = input.apiUrl.trim() || DEFAULT_DEEPL_TRANSLATE_URL;
  const url = new URL(apiUrl);
  url.pathname = "/v2/languages";
  url.search = "";
  url.searchParams.set("type", "target");
  const { signal, clear } = createTimeoutSignal(2000);

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `DeepL-Auth-Key ${apiKey}`,
      },
      cache: "no-store",
      signal,
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`DeepL check failed: ${response.status} ${details}`);
    }

    const data = (await response.json()) as Array<{ language?: string }>;
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error("DeepL check failed: no target languages returned.");
    }
  } finally {
    clear();
  }
}

async function verifyCdnMode() {
  const mergedConfig = readMergedPhiConfigSync();
  const token = mergedConfig.api?.phisCdnPublicToken?.trim();
  const url = `${getConfiguredCdnBaseUrlSync().replace(/\/+$/, "")}/api/v1/locales`;
  const { signal, clear } = createTimeoutSignal(2000);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: token ? { [PHIS_TOKEN_HEADER]: token } : {},
      cache: "no-store",
      signal,
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`CDN check failed: ${response.status} ${details}`);
    }

    const data = (await response.json()) as { locales?: string[]; options?: unknown[] };
    if (
      (!Array.isArray(data.locales) || data.locales.length === 0) &&
      (!Array.isArray(data.options) || data.options.length === 0)
    ) {
      throw new Error("CDN check failed: no locales returned.");
    }
  } finally {
    clear();
  }
}

async function verifyCustomMode(endpoint: string) {
  const { signal, clear } = createTimeoutSignal(2000);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        locale: "en",
        msg: "phis operator validation",
        ctx: "phis operator validation",
        sourceLocale: readMergedPhiConfigSync().translation?.sourceLocale ?? "en",
      }),
      cache: "no-store",
      signal,
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Custom endpoint check failed: ${response.status} ${details}`);
    }

    const data = (await response.json()) as {
      translation?: string;
      translations?: string[];
    };

    if (
      typeof data.translation !== "string" &&
      !(Array.isArray(data.translations) && data.translations.length > 0)
    ) {
      throw new Error("Custom endpoint check failed: invalid response payload.");
    }
  } finally {
    clear();
  }
}

function buildSitesHref(input?: {
  error?: string;
  action?: "create" | "settings";
  siteId?: number;
  notice?: string;
  noticeMode?: "success" | "warning" | "error";
  noticeId?: string;
  deleteTranslationsSuccessLocale?: string;
}) {
  const searchParams = new URLSearchParams({
    section: "sites",
  });

  if (input?.error) {
    searchParams.set("siteError", input.error);
  }

  if (input?.action) {
    searchParams.set("siteAction", input.action);
  }

  if (input?.siteId) {
    searchParams.set("siteId", String(input.siteId));
  }

  if (input?.notice) {
    searchParams.set("siteNotice", input.notice);
  }

  if (input?.noticeMode) {
    searchParams.set("siteNoticeMode", input.noticeMode);
  }

  if (input?.noticeId) {
    searchParams.set("siteNoticeId", input.noticeId);
  }

  if (input?.deleteTranslationsSuccessLocale) {
    searchParams.set("siteDeleteTranslationsSuccessLocale", input.deleteTranslationsSuccessLocale);
  }

  return `/operator?${searchParams.toString()}`;
}

function buildTranslationsHref(input?: {
  error?: string;
  mode?: string | null;
  success?: boolean;
}) {
  const searchParams = new URLSearchParams({
    section: "translations",
  });

  if (input?.error) {
    searchParams.set("translationError", input.error);
  }

  if (input?.mode) {
    searchParams.set("translationMode", normalizeTranslationMode(input.mode));
  }

  if (input?.success) {
    searchParams.set("translationSuccess", String(Date.now()));
  }

  return `/operator?${searchParams.toString()}`;
}

function normalizeSiteKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeLocaleList(values: string[]) {
  return Array.from(
    new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean)),
  );
}

function resolveSiteAvailableLocales(formData: FormData, defaultLocale: string) {
  const allowedLocales = new Set(getConfiguredTranslationSupportedLocalesSync());
  const selectedLocales = normalizeLocaleList(
    formData.getAll("siteAvailableLocales").map((value) => String(value ?? "")),
  ).filter((value) => allowedLocales.has(value));

  return Array.from(new Set([defaultLocale, ...selectedLocales]));
}

export async function createOperatorSite(formData: FormData) {
  if (isBootstrapEnabled()) {
    redirect("/setup");
  }

  const session = await getOperatorSession();
  if (!session) {
    redirect("/operator/login");
  }

  const key = normalizeSiteKey(String(formData.get("siteKey") ?? ""));
  const name = String(formData.get("siteName") ?? "").trim();
  const hostname = String(formData.get("siteHostname") ?? "").trim().toLowerCase();
  const publicBaseUrl = String(formData.get("siteBaseUrl") ?? "").trim();
  const defaultLocale = String(formData.get("siteDefaultLocale") ?? "en")
    .trim()
    .toLowerCase();
  const supportEmail = String(formData.get("siteSupportEmail") ?? "")
    .trim()
    .toLowerCase();
  const availableLocales = resolveSiteAvailableLocales(formData, defaultLocale);

  try {
    await createSite({
      key,
      name,
      hostname,
      publicBaseUrl,
      defaultLocale,
      availableLocales,
      supportEmail,
    });
  } catch (error) {
    const message =
      error instanceof Error && error.message ? error.message : "Site creation failed.";
    redirect(buildSitesHref({ error: message, action: "create" }));
  }

  redirect(buildSitesHref());
}

export async function updateOperatorSite(formData: FormData) {
  if (isBootstrapEnabled()) {
    redirect("/setup");
  }

  const session = await getOperatorSession();
  if (!session) {
    redirect("/operator/login");
  }

  const siteId = Number(formData.get("siteId") ?? 0);
  const name = String(formData.get("siteName") ?? "").trim();
  const hostname = String(formData.get("siteHostname") ?? "").trim().toLowerCase();
  const publicBaseUrl = String(formData.get("siteBaseUrl") ?? "").trim();
  const defaultLocale = String(formData.get("siteDefaultLocale") ?? "en")
    .trim()
    .toLowerCase();
  const supportEmail = String(formData.get("siteSupportEmail") ?? "")
    .trim()
    .toLowerCase();
  const availableLocales = resolveSiteAvailableLocales(formData, defaultLocale);

  try {
    await updateSiteSettings({
      id: siteId,
      name,
      hostname,
      publicBaseUrl,
      defaultLocale,
      availableLocales,
      supportEmail,
    });
  } catch (error) {
    const message =
      error instanceof Error && error.message ? error.message : "Site update failed.";
    redirect(
      buildSitesHref({
        error: message,
        action: "settings",
        siteId,
      }),
    );
  }

  redirect(buildSitesHref());
}

export async function deleteOperatorSite(formData: FormData) {
  if (isBootstrapEnabled()) {
    redirect("/setup");
  }

  const session = await getOperatorSession();
  if (!session) {
    redirect("/operator/login");
  }

  const siteId = Number(formData.get("siteId") ?? 0);

  try {
    await deleteSite(siteId);
  } catch (error) {
    const message =
      error instanceof Error && error.message ? error.message : "Site deletion failed.";
    redirect(buildSitesHref({ error: message }));
  }

  redirect(buildSitesHref());
}

export async function deleteOperatorSiteTranslations(formData: FormData) {
  if (isBootstrapEnabled()) {
    redirect("/setup");
  }

  const session = await getOperatorSession();
  if (!session) {
    redirect("/operator/login");
  }

  const siteId = Number(formData.get("siteId") ?? 0);
  const locale = String(formData.get("locale") ?? "").trim().toLowerCase();

  try {
    await deleteSiteTranslatedVariantsForLocale(siteId, locale);
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : "Site translation deletion failed.";
    redirect(
      buildSitesHref({
        notice: message,
        noticeMode: "error",
        noticeId: String(Date.now()),
      }),
    );
  }

  redirect(
    buildSitesHref({
      noticeId: String(Date.now()),
      deleteTranslationsSuccessLocale: locale,
    }),
  );
}

export async function updateOperatorSupportedLocales(formData: FormData) {
  if (isBootstrapEnabled()) {
    redirect("/setup");
  }

  const session = await getOperatorSession();
  if (!session) {
    redirect("/operator/login");
  }

  const requestedLocales = normalizeLocaleList(
    formData.getAll("translationSupportedLocales").map((value) => String(value ?? "")),
  );
  const mode = normalizeTranslationMode(String(formData.get("translationMode") ?? "none"));
  const customEndpoint = String(formData.get("translationCustomEndpoint") ?? "").trim();
  const deeplKey = String(formData.get("translationDeeplKey") ?? "").trim();
  const deeplEndpoint = String(formData.get("translationDeeplEndpoint") ?? "").trim();
  const publicToken = String(formData.get("translationPublicToken") ?? "").trim();
  const allowPublicReads = String(formData.get("translationAllowPublicReads") ?? "false") === "true";
  const allowPublicWrites =
    String(formData.get("translationAllowPublicWrites") ?? "false") === "true";
  const sourceState = await resolveTranslationLocaleSourceState(mode);
  const sourceCodes = new Set(sourceState.options.map((option) => option.code));
  const supportedLocales = Array.from(
    new Set(
      ["en", ...requestedLocales].filter((locale) => sourceCodes.has(locale)),
    ),
  );

  if (mode === "deepl" && (!deeplKey || !deeplEndpoint)) {
    redirect(buildTranslationsHref({ error: "Please provide a DeepL key and endpoint.", mode }));
  }

  if (mode === "custom" && !customEndpoint) {
    redirect(buildTranslationsHref({ error: "Please provide a custom endpoint.", mode }));
  }

  if (allowPublicWrites && !allowPublicReads) {
    redirect(
      buildTranslationsHref({
        error: "Public write access requires public read access.",
        mode,
      }),
    );
  }

  if (allowPublicReads && !publicToken) {
    redirect(
      buildTranslationsHref({
        error: "Please provide a public token when public read access is enabled.",
        mode,
      }),
    );
  }

  try {
    if (mode === "deepl") {
      await verifyDeepLMode({
        apiKey: deeplKey,
        apiUrl: deeplEndpoint,
      });
    } else if (mode === "cdn") {
      await verifyCdnMode();
    } else if (mode === "custom") {
      await verifyCustomMode(customEndpoint);
    }
  } catch (error) {
    const message =
      error instanceof Error && error.message ? error.message : "Translation mode check failed.";
    redirect(buildTranslationsHref({ error: message, mode }));
  }
  const sites = await listSites();
  const blockedLocales = new Map<string, string[]>();

  for (const site of sites) {
    const usedLocales = new Set([
      site.defaultLocale,
      ...site.availableLocales.map((locale) => locale.code),
    ]);

    for (const locale of usedLocales) {
      if (supportedLocales.includes(locale)) {
        continue;
      }

      const siteNames = blockedLocales.get(locale) ?? [];
      siteNames.push(site.name);
      blockedLocales.set(locale, siteNames);
    }
  }

  if (blockedLocales.size > 0) {
    const message = Array.from(blockedLocales.entries())
      .map(([locale, siteNames]) => `${locale.toUpperCase()} (${siteNames.join(", ")})`)
      .join(", ");
    redirect(buildTranslationsHref({ error: message, mode }));
  }

  const runtimeConfig = readPhiRuntimeConfigSync();
  writePhiRuntimeConfigSync({
    ...runtimeConfig,
    api: {
      ...runtimeConfig.api,
      publicToken: publicToken || runtimeConfig.api?.publicToken || "",
    },
    translation: {
      ...runtimeConfig.translation,
      mode,
      customEndpoint: mode === "custom" ? customEndpoint : "",
      supportedLocales,
      allowPublicReads,
      allowPublicWrites,
    },
    deepl: {
      ...runtimeConfig.deepl,
      apiKey: deeplKey || runtimeConfig.deepl?.apiKey || "",
      apiUrl: deeplEndpoint || runtimeConfig.deepl?.apiUrl || "",
    },
  });
  resetPhiServerConfigCache();
  revalidatePath("/operator");

  redirect(buildTranslationsHref({ mode, success: true }));
}
