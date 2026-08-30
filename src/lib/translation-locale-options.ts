import "server-only";

import { getSupportedDeepLTargetLanguages } from "@/lib/deepl-languages";
import { getPhiServerConfigSync } from "@/lib/config";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "@/lib/locale";

export type TranslationLocaleOption = {
  code: string;
  label: string;
};

export type TranslationMode = "deepl" | "cdn" | "custom" | "none";

type TranslationLocaleSourceState = {
  mode: TranslationMode;
  options: TranslationLocaleOption[];
  configuredLocales: string[];
  sourceError: string | null;
};

const LOCALE_SOURCE_CACHE_TTL_MS = 15 * 60 * 1000;

const localeSourceCache = new Map<
  string,
  {
    expiresAt: number;
    options: TranslationLocaleOption[];
  }
>();

export function normalizeTranslationMode(input?: string | null): TranslationMode {
  const normalized = input?.trim().toLowerCase();
  return normalized === "deepl" ||
    normalized === "cdn" ||
    normalized === "custom" ||
    normalized === "none"
    ? normalized
    : "none";
}

function normalizeLocaleCode(input?: string | null) {
  return input?.trim().toLowerCase().split(/[-_]/)[0] ?? "";
}

function buildLocaleLabel(code: string, fallbackLabel?: string | null) {
  if (fallbackLabel?.trim()) {
    return fallbackLabel.trim();
  }

  try {
    const label = new Intl.DisplayNames([code], { type: "language" }).of(code);
    return label ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

function buildLocaleOptions(
  entries: Array<string | { code: string; label?: string | null }>,
): TranslationLocaleOption[] {
  const deduped = new Map<string, TranslationLocaleOption>();

  for (const entry of entries) {
    const code =
      typeof entry === "string" ? normalizeLocaleCode(entry) : normalizeLocaleCode(entry.code);
    if (!code) {
      continue;
    }

    deduped.set(code, {
      code,
      label:
        typeof entry === "string"
          ? buildLocaleLabel(code)
          : buildLocaleLabel(code, entry.label),
    });
  }

  deduped.set(DEFAULT_LOCALE, {
    code: DEFAULT_LOCALE,
    label: buildLocaleLabel(DEFAULT_LOCALE, "English"),
  });

  return Array.from(deduped.values()).sort((left, right) => {
    if (left.code === DEFAULT_LOCALE) {
      return -1;
    }
    if (right.code === DEFAULT_LOCALE) {
      return 1;
    }
    return left.label.localeCompare(right.label);
  });
}

export function getConfiguredTranslationSupportedLocalesSync() {
  const config = getPhiServerConfigSync();
  const configured =
    config.translation?.supportedLocales ??
    config.translation?.allowedLocales ??
    [DEFAULT_LOCALE];

  return Array.from(
    new Set([DEFAULT_LOCALE, ...configured.map((value) => normalizeLocaleCode(value)).filter(Boolean)]),
  );
}

export function getConfiguredCdnBaseUrlSync() {
  return getPhiServerConfigSync().translation?.cdnBaseUrl?.trim() || "https://cdn.phis.dev";
}

function coerceConfiguredLocales(
  configuredLocales: string[],
  options: TranslationLocaleOption[],
) {
  const allowedCodes = new Set(options.map((option) => option.code));

  return Array.from(
    new Set(
      [DEFAULT_LOCALE, ...configuredLocales]
        .map((value) => normalizeLocaleCode(value))
        .filter((value) => value && allowedCodes.has(value)),
    ),
  );
}

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

function getStaticLocaleCatalogOptions() {
  return buildLocaleOptions(Array.from(SUPPORTED_LOCALES, (code) => ({ code })));
}

async function fetchCdnLocaleOptions() {
  const config = getPhiServerConfigSync();
  const token = config.api?.phisCdnPublicToken?.trim();
  const cdnBaseUrl = getConfiguredCdnBaseUrlSync().replace(/\/+$/, "");
  const { signal, clear } = createTimeoutSignal(1500);

  try {
    const response = await fetch(`${cdnBaseUrl}/api/v1/locales`, {
      method: "GET",
      headers: token ? { "x-phi-token": token } : {},
      cache: "no-store",
      signal,
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`CDN locales request failed: ${response.status} ${details}`);
    }

    const data = (await response.json()) as {
      locales?: string[];
      options?: Array<{ code?: string; label?: string }>;
    };

    if (Array.isArray(data.options) && data.options.length > 0) {
      return buildLocaleOptions(
        data.options.map((option) => ({
          code: option.code ?? "",
          label: option.label ?? "",
        })),
      );
    }

    if (Array.isArray(data.locales) && data.locales.length > 0) {
      return buildLocaleOptions(data.locales);
    }

    throw new Error("CDN locales response did not include locales.");
  } finally {
    clear();
  }
}

async function fetchDeepLLocaleOptions() {
  const result = await getSupportedDeepLTargetLanguages({ sourceLocale: DEFAULT_LOCALE });
  return buildLocaleOptions(
    result.languages.map((language) => ({
      code: language.language,
      label: language.name,
    })),
  );
}

async function getLocaleSourceOptions(mode: TranslationMode) {
  const cacheKey = `translation-locale-source:${mode}`;
  const cached = localeSourceCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.options;
  }

  const options =
    mode === "deepl"
      ? await fetchDeepLLocaleOptions()
      : mode === "cdn"
        ? await fetchCdnLocaleOptions()
        : mode === "custom"
          ? getStaticLocaleCatalogOptions()
        : getStaticLocaleCatalogOptions();

  localeSourceCache.set(cacheKey, {
    expiresAt: Date.now() + LOCALE_SOURCE_CACHE_TTL_MS,
    options,
  });

  return options;
}

export async function resolveTranslationLocaleSourceState(
  modeOverride?: string | null,
): Promise<TranslationLocaleSourceState> {
  const config = getPhiServerConfigSync();
  const mode = modeOverride
    ? normalizeTranslationMode(modeOverride)
    : normalizeTranslationMode(config.translation?.mode ?? "none");
  const configuredLocales = getConfiguredTranslationSupportedLocalesSync();

  try {
    const options = await getLocaleSourceOptions(mode);
    return {
      mode,
      options,
      configuredLocales: coerceConfiguredLocales(configuredLocales, options),
      sourceError: null,
    };
  } catch (error) {
    const fallbackOptions = buildLocaleOptions(
      configuredLocales.length > 0 ? configuredLocales : Array.from(SUPPORTED_LOCALES),
    );
    const message = error instanceof Error ? error.message : "Locale source lookup failed.";
    return {
      mode,
      options: fallbackOptions,
      configuredLocales: coerceConfiguredLocales(configuredLocales, fallbackOptions),
      sourceError: message,
    };
  }
}

export async function warmTranslationLocaleSourceOptions() {
  await getLocaleSourceOptions(
    normalizeTranslationMode(getPhiServerConfigSync().translation?.mode ?? "none"),
  );
}
