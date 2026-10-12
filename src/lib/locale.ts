import config from "../../config/phis-config.json";

export { PHI_CANONICAL_SOURCE_LOCALE } from "@phis/contracts/locale";
import { PHI_CANONICAL_SOURCE_LOCALE } from "@phis/contracts/locale";

const configuredLocales = config.translation?.supportedLocales ?? [];

/**
 * Every locale this installation can serve, with the source language always among them.
 *
 * The canonical source is included because a store's own language is one it can always answer in --
 * not because it is anyone's default.
 */
export const SUPPORTED_LOCALES = Array.from(
  new Set([PHI_CANONICAL_SOURCE_LOCALE, ...configuredLocales]),
) as ReadonlyArray<string>;

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
  return Array.from(new Set([input.locale, input.language, PHI_CANONICAL_SOURCE_LOCALE].filter(Boolean)));
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
  const raw = input?.split(",")[0]?.split(";")[0]?.trim() ?? "";
  return raw.replace(/_/g, "-").toLowerCase();
}

/**
 * An `Accept-Language` header as the languages it asks for, most wanted first.
 *
 * Only the first entry used to be read, with its `;q=` still attached -- `de;q=0.9` matched nothing --
 * so a browser listing `fr-CH, de;q=0.9` on a German-only Site landed on the default, not on German.
 * `*` names no language and is left out; an entry weighted `q=0` is refused by the header itself.
 */
export function parsePhiAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.split(";").map((piece) => piece.trim());
      const weight = params.find((param) => param.startsWith("q="));
      const q = weight ? Number.parseFloat(weight.slice(2)) : 1;
      return { tag, q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((entry) => entry.tag && entry.tag !== "*" && entry.q > 0)
    .sort((left, right) => right.q - left.q || left.index - right.index)
    .map((entry) => entry.tag);
}

/**
 * The language of a locale without its region: `pt-BR`, `pt_br` and ` PT ` are all `pt`.
 *
 * What the DeepL language list and the offered translation targets are keyed by; they kept a copy
 * each. Empty for no locale at all.
 */
export function resolvePhiLocaleBase(input?: string | null) {
  return input?.trim().toLowerCase().split(/[-_]/)[0] ?? "";
}

export function normalizeLocale(input?: string | null) {
  return resolvePhiLocaleCapability(input)?.locale ?? getPhiLocaleCapability(PHI_CANONICAL_SOURCE_LOCALE).locale;
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

/**
 * The catalog's own spelling of a locale a translation is stored under.
 *
 * `tr_*_lang.locale` is compared as written, so `DE`, `de` and `de_de` used to become separate rows and
 * separate paid provider calls, and a delete that lowercased its argument never met `pt-BR` again. A
 * language the catalog does not know is refused rather than stored under a spelling nothing reads.
 */
export function requirePhiTranslationLocale(input: string): string {
  const capability = resolvePhiLocaleCapability(input);
  if (!capability) {
    throw new Error(`Locale "${input.trim()}" is not a supported translation locale.`);
  }
  return capability.locale;
}

export function getPhiLocaleCapability(locale: string | null | undefined): PhiLocaleCapability {
  return resolvePhiLocaleCapability(locale) ?? resolvePhiLocaleCapability(PHI_CANONICAL_SOURCE_LOCALE) as PhiLocaleCapability;
}

/**
 * What each locale a Site serves means, in the order `resolveSiteLocale` matches them.
 *
 * A Site process given these can answer a request that names its locale itself -- the requested locale
 * is matched first, so its answer depends on nothing else -- and asks `/api/v1/site/locale` only when
 * the visitor's preference has to decide.
 */
export function resolveSiteLocaleCapabilities(availableLocales: readonly string[]) {
  return normalizeAvailableLocaleCapabilities(availableLocales);
}

function normalizeAvailableLocaleCapabilities(availableLocales: readonly string[]) {
  const capabilities = availableLocales
    .map((locale) => resolvePhiLocaleCapability(locale))
    .filter((capability): capability is PhiLocaleCapability => Boolean(capability));
  return capabilities.length > 0 ? capabilities : [getPhiLocaleCapability(PHI_CANONICAL_SOURCE_LOCALE)];
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
    // Every language the browser asks for, in its order: the first one the Site offers wins.
    ...parsePhiAcceptLanguage(input.browserLocale)
      .map((value) => ({ source: "browser" as const, value })),
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

  const accepted = parsePhiAcceptLanguage(headers.get("accept-language"))
    .find((tag) => resolvePhiLocaleCapability(tag));
  return normalizeLocale(accepted);
}
