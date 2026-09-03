import "server-only";

import { getPhiServerConfigSync } from "@/lib/config";
import { PHI_CANONICAL_SOURCE_LOCALE } from "@/lib/locale";

const DEFAULT_DEEPL_TRANSLATE_URL = "https://api-free.deepl.com/v2/translate";
const DEEPL_LANGUAGE_CACHE_TTL_MS = 60 * 60 * 1000;

type DeepLLanguageType = "source" | "target";

export type DeepLSupportedLanguage = {
  language: string;
  name: string;
  supportsFormality: boolean;
};

export type DeepLSupportedTargetLanguagesResult = {
  sourceLocale: string;
  languages: DeepLSupportedLanguage[];
};

type DeepLLanguageCacheEntry = {
  expiresAt: number;
  languages: DeepLSupportedLanguage[];
};

const DEEPL_LANGUAGE_CACHE = new Map<DeepLLanguageType, DeepLLanguageCacheEntry>();

function normalizeLocaleKey(locale?: string | null) {
  return locale?.trim().toLowerCase().split(/[-_]/)[0] ?? "";
}

function getDeepLLanguagesUrl(type: DeepLLanguageType) {
  const configuredUrl =
    getPhiServerConfigSync().deepl?.apiUrl?.trim() || DEFAULT_DEEPL_TRANSLATE_URL;
  const url = new URL(configuredUrl);
  url.pathname = "/v2/languages";
  url.search = "";
  url.searchParams.set("type", type);
  return url.toString();
}

async function requestDeepLLanguages(type: DeepLLanguageType) {
  const cached = DEEPL_LANGUAGE_CACHE.get(type);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.languages;
  }

  const apiKey = getPhiServerConfigSync().deepl?.apiKey?.trim();
  if (!apiKey) {
    throw new Error("Missing deepl.apiKey in config/phis-runtime.json.");
  }

  const response = await fetch(getDeepLLanguagesUrl(type), {
    method: "GET",
    headers: {
      Authorization: `DeepL-Auth-Key ${apiKey}`,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`DeepL languages request failed: ${response.status} ${details}`);
  }

  const data = (await response.json()) as Array<{
    language?: string;
    name?: string;
    supports_formality?: boolean;
  }>;

  const languages = data
    .map((item) => ({
      language: item.language?.trim().toUpperCase() ?? "",
      name: item.name?.trim() ?? "",
      supportsFormality: item.supports_formality === true,
    }))
    .filter((item) => item.language && item.name);

  DEEPL_LANGUAGE_CACHE.set(type, {
    expiresAt: Date.now() + DEEPL_LANGUAGE_CACHE_TTL_MS,
    languages,
  });

  return languages;
}

export async function getSupportedDeepLTargetLanguages(options?: {
  sourceLocale?: string | null;
}): Promise<DeepLSupportedTargetLanguagesResult> {
  const sourceLocale = normalizeLocaleKey(options?.sourceLocale) || PHI_CANONICAL_SOURCE_LOCALE;
  const languages = await requestDeepLLanguages("target");

  return {
    sourceLocale,
    languages: languages.filter(
      (language) => normalizeLocaleKey(language.language) !== sourceLocale,
    ),
  };
}
