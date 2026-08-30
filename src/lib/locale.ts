import config from "../../config/phis-config.json";

export const DEFAULT_LOCALE = "en";
const configuredLocales = config.translation?.supportedLocales ?? [];
export const SUPPORTED_LOCALES = Array.from(
  new Set([DEFAULT_LOCALE, ...configuredLocales]),
) as ReadonlyArray<string>;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export type PhiTextDirection = "ltr" | "rtl";

export type PhiLocaleCapability = {
  locale: string;
  language: string;
  script?: string;
  region?: string;
  direction: PhiTextDirection;
  intlLocale: string;
  deeplTargetLang: string;
  labelFallbacks: string[];
};

export type PhiResolvedLocale = PhiLocaleCapability & {
  requestedLocale: string | null;
  source: "requested" | "user" | "cookie" | "browser" | "default";
};

type CapabilityInput = Omit<PhiLocaleCapability, "labelFallbacks"> & {
  aliases?: readonly string[];
  labelFallbacks?: readonly string[];
};

const PHI_LOCALE_CAPABILITY_INPUTS = [
  { locale: "ar", language: "ar", direction: "rtl", intlLocale: "ar", deeplTargetLang: "AR" },
  { locale: "bg", language: "bg", direction: "ltr", intlLocale: "bg", deeplTargetLang: "BG" },
  { locale: "cs", language: "cs", direction: "ltr", intlLocale: "cs", deeplTargetLang: "CS" },
  { locale: "da", language: "da", direction: "ltr", intlLocale: "da", deeplTargetLang: "DA" },
  { locale: "de", language: "de", direction: "ltr", intlLocale: "de", deeplTargetLang: "DE" },
  { locale: "de-DE", language: "de", region: "DE", direction: "ltr", intlLocale: "de-DE", deeplTargetLang: "DE" },
  { locale: "de-AT", language: "de", region: "AT", direction: "ltr", intlLocale: "de-AT", deeplTargetLang: "DE" },
  { locale: "de-CH", language: "de", region: "CH", direction: "ltr", intlLocale: "de-CH", deeplTargetLang: "DE" },
  { locale: "el", language: "el", direction: "ltr", intlLocale: "el", deeplTargetLang: "EL" },
  { locale: "en", language: "en", direction: "ltr", intlLocale: "en", deeplTargetLang: "EN-GB" },
  { locale: "en-GB", language: "en", region: "GB", direction: "ltr", intlLocale: "en-GB", deeplTargetLang: "EN-GB" },
  { locale: "en-US", language: "en", region: "US", direction: "ltr", intlLocale: "en-US", deeplTargetLang: "EN-US" },
  { locale: "es", language: "es", direction: "ltr", intlLocale: "es", deeplTargetLang: "ES" },
  { locale: "es-ES", language: "es", region: "ES", direction: "ltr", intlLocale: "es-ES", deeplTargetLang: "ES" },
  { locale: "es-419", language: "es", region: "419", direction: "ltr", intlLocale: "es-419", deeplTargetLang: "ES-419" },
  { locale: "et", language: "et", direction: "ltr", intlLocale: "et", deeplTargetLang: "ET" },
  { locale: "fi", language: "fi", direction: "ltr", intlLocale: "fi", deeplTargetLang: "FI" },
  { locale: "fr", language: "fr", direction: "ltr", intlLocale: "fr", deeplTargetLang: "FR" },
  { locale: "fr-FR", language: "fr", region: "FR", direction: "ltr", intlLocale: "fr-FR", deeplTargetLang: "FR" },
  { locale: "fr-CH", language: "fr", region: "CH", direction: "ltr", intlLocale: "fr-CH", deeplTargetLang: "FR" },
  { locale: "fr-BE", language: "fr", region: "BE", direction: "ltr", intlLocale: "fr-BE", deeplTargetLang: "FR" },
  { locale: "fr-CA", language: "fr", region: "CA", direction: "ltr", intlLocale: "fr-CA", deeplTargetLang: "FR" },
  { locale: "he", language: "he", direction: "rtl", intlLocale: "he", deeplTargetLang: "HE" },
  { locale: "he-IL", language: "he", region: "IL", direction: "rtl", intlLocale: "he-IL", deeplTargetLang: "HE" },
  { locale: "hu", language: "hu", direction: "ltr", intlLocale: "hu", deeplTargetLang: "HU" },
  { locale: "id", language: "id", direction: "ltr", intlLocale: "id", deeplTargetLang: "ID" },
  { locale: "it", language: "it", direction: "ltr", intlLocale: "it", deeplTargetLang: "IT" },
  { locale: "ja", language: "ja", direction: "ltr", intlLocale: "ja", deeplTargetLang: "JA" },
  { locale: "ja-JP", language: "ja", region: "JP", direction: "ltr", intlLocale: "ja-JP", deeplTargetLang: "JA" },
  { locale: "ko", language: "ko", direction: "ltr", intlLocale: "ko", deeplTargetLang: "KO" },
  { locale: "ko-KR", language: "ko", region: "KR", direction: "ltr", intlLocale: "ko-KR", deeplTargetLang: "KO" },
  { locale: "lt", language: "lt", direction: "ltr", intlLocale: "lt", deeplTargetLang: "LT" },
  { locale: "lv", language: "lv", direction: "ltr", intlLocale: "lv", deeplTargetLang: "LV" },
  { locale: "nb", language: "nb", direction: "ltr", intlLocale: "nb", deeplTargetLang: "NB", aliases: ["no"] },
  { locale: "nb-NO", language: "nb", region: "NO", direction: "ltr", intlLocale: "nb-NO", deeplTargetLang: "NB", aliases: ["no-NO"] },
  { locale: "nl", language: "nl", direction: "ltr", intlLocale: "nl", deeplTargetLang: "NL" },
  { locale: "pl", language: "pl", direction: "ltr", intlLocale: "pl", deeplTargetLang: "PL" },
  { locale: "pt", language: "pt", direction: "ltr", intlLocale: "pt", deeplTargetLang: "PT-PT" },
  { locale: "pt-BR", language: "pt", region: "BR", direction: "ltr", intlLocale: "pt-BR", deeplTargetLang: "PT-BR" },
  { locale: "pt-PT", language: "pt", region: "PT", direction: "ltr", intlLocale: "pt-PT", deeplTargetLang: "PT-PT" },
  { locale: "ro", language: "ro", direction: "ltr", intlLocale: "ro", deeplTargetLang: "RO" },
  { locale: "ru", language: "ru", direction: "ltr", intlLocale: "ru", deeplTargetLang: "RU" },
  { locale: "sk", language: "sk", direction: "ltr", intlLocale: "sk", deeplTargetLang: "SK" },
  { locale: "sl", language: "sl", direction: "ltr", intlLocale: "sl", deeplTargetLang: "SL" },
  { locale: "sv", language: "sv", direction: "ltr", intlLocale: "sv", deeplTargetLang: "SV" },
  { locale: "th", language: "th", direction: "ltr", intlLocale: "th", deeplTargetLang: "TH" },
  { locale: "tr", language: "tr", direction: "ltr", intlLocale: "tr", deeplTargetLang: "TR" },
  { locale: "uk", language: "uk", direction: "ltr", intlLocale: "uk", deeplTargetLang: "UK" },
  { locale: "vi", language: "vi", direction: "ltr", intlLocale: "vi", deeplTargetLang: "VI" },
  { locale: "zh-Hans", language: "zh", script: "Hans", direction: "ltr", intlLocale: "zh-Hans", deeplTargetLang: "ZH-HANS", aliases: ["zh", "zh-CN"] },
  { locale: "zh-Hant", language: "zh", script: "Hant", direction: "ltr", intlLocale: "zh-Hant", deeplTargetLang: "ZH-HANT", aliases: ["zh-TW", "zh-HK"] },
] satisfies readonly CapabilityInput[];

function buildLabelFallbacks(input: CapabilityInput) {
  return Array.from(new Set([input.locale, input.language, DEFAULT_LOCALE].filter(Boolean)));
}

function toCapability(input: CapabilityInput): PhiLocaleCapability {
  return {
    locale: input.locale,
    language: input.language,
    ...(input.script ? { script: input.script } : {}),
    ...(input.region ? { region: input.region } : {}),
    direction: input.direction,
    intlLocale: input.intlLocale,
    deeplTargetLang: input.deeplTargetLang,
    labelFallbacks: [...(input.labelFallbacks ?? buildLabelFallbacks(input))],
  };
}

export const PHI_LOCALE_CAPABILITIES: readonly PhiLocaleCapability[] = PHI_LOCALE_CAPABILITY_INPUTS.map(toCapability);

const PHI_LOCALE_CAPABILITY_BY_KEY = new Map<string, PhiLocaleCapability>();

for (const input of PHI_LOCALE_CAPABILITY_INPUTS) {
  const capability = toCapability(input);
  const baseKeys = input.locale === input.language
    ? [input.locale, input.language, input.intlLocale]
    : [input.locale, input.intlLocale];
  for (const key of [...baseKeys, ...(input.aliases ?? [])]) {
    PHI_LOCALE_CAPABILITY_BY_KEY.set(normalizeLocaleKey(key), capability);
  }
}

function normalizeLocaleKey(input?: string | null) {
  const raw = input?.split(",")[0]?.trim() ?? "";
  return raw.replace(/_/g, "-").toLowerCase();
}

export function normalizeLocale(input?: string | null) {
  return resolvePhiLocaleCapability(input)?.locale ?? getPhiLocaleCapability(DEFAULT_LOCALE).locale;
}

export function resolveDeepLTargetLang(input?: string | null) {
  return getPhiLocaleCapability(input).deeplTargetLang;
}

export function resolveDeepLSourceLang(input?: string | null) {
  const targetLang = resolveDeepLTargetLang(input);
  if (targetLang.startsWith("EN-")) {
    return "EN";
  }
  if (targetLang.startsWith("PT-")) {
    return "PT";
  }
  if (targetLang.startsWith("ES-")) {
    return "ES";
  }
  if (targetLang.startsWith("ZH-")) {
    return "ZH";
  }

  return targetLang;
}

export function resolvePhiLocaleCapability(locale: string | null | undefined): PhiLocaleCapability | null {
  const normalized = normalizeLocaleKey(locale);
  if (!normalized) {
    return null;
  }

  const exact = PHI_LOCALE_CAPABILITY_BY_KEY.get(normalized);
  if (exact) {
    return exact;
  }

  return PHI_LOCALE_CAPABILITY_BY_KEY.get(normalized.split("-")[0] ?? "") ?? null;
}

export function getPhiLocaleCapability(locale: string | null | undefined): PhiLocaleCapability {
  return resolvePhiLocaleCapability(locale) ?? resolvePhiLocaleCapability(DEFAULT_LOCALE) as PhiLocaleCapability;
}

function normalizeAvailableLocaleCapabilities(availableLocales: readonly string[]) {
  const capabilities = availableLocales
    .map((locale) => resolvePhiLocaleCapability(locale))
    .filter((capability): capability is PhiLocaleCapability => Boolean(capability));
  return capabilities.length > 0 ? capabilities : [getPhiLocaleCapability(DEFAULT_LOCALE)];
}

function matchAvailableLocale(candidate: string | null | undefined, availableLocales: readonly PhiLocaleCapability[]) {
  const requested = resolvePhiLocaleCapability(candidate);
  if (!requested) {
    return null;
  }

  return availableLocales.find((available) => available.locale === requested.locale) ??
    availableLocales.find((available) => available.language === requested.language) ??
    null;
}

export function resolveSiteLocale(input: {
  requestedLocale?: string | null;
  userPreferredLocale?: string | null;
  cookieLocale?: string | null;
  browserLocale?: string | null;
  defaultLocale: string;
  availableLocales: readonly string[];
}): PhiResolvedLocale {
  const availableLocales = normalizeAvailableLocaleCapabilities(input.availableLocales);
  const fallback = matchAvailableLocale(input.defaultLocale, availableLocales) ?? availableLocales[0];
  const candidates = [
    { source: "requested" as const, value: input.requestedLocale ?? null },
    { source: "user" as const, value: input.userPreferredLocale ?? null },
    { source: "cookie" as const, value: input.cookieLocale ?? null },
    { source: "browser" as const, value: input.browserLocale ?? null },
  ];

  for (const candidate of candidates) {
    const matched = matchAvailableLocale(candidate.value, availableLocales);
    if (matched) {
      return {
        ...matched,
        requestedLocale: candidate.value,
        source: candidate.source,
      };
    }
  }

  return {
    ...fallback,
    requestedLocale: null,
    source: "default",
  };
}

export function filterSiteTranslationTargetLocales<T extends string | { code: string }>(
  sourceLocaleInput: string,
  locales: readonly T[],
) {
  const sourceLocale = resolvePhiLocaleCapability(sourceLocaleInput)?.locale ?? "";
  return locales.filter((entry) => {
    const locale = typeof entry === "string" ? entry : entry.code;
    const normalized = resolvePhiLocaleCapability(locale)?.locale ?? "";
    return Boolean(normalized) && normalized !== sourceLocale;
  });
}

export function resolveRequestLocale(headers: Headers) {
  const explicit = headers.get("x-locale");
  if (explicit) {
    return normalizeLocale(explicit);
  }

  return normalizeLocale(headers.get("accept-language"));
}
