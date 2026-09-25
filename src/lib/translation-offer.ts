import "server-only";

import { getPhisConfigSync } from "@/lib/config";
import { resolvePhiLocaleCapability } from "@/lib/locale";
import {
  getConfiguredTranslationMode,
  translationModeUsesDeepL,
} from "@/lib/translation-unit";

/**
 * Whether this installation can translate a body, and into which of a Site's languages.
 *
 * A Site has to know before it draws a control. A translate button that answers "this installation does
 * not translate" is a button that should not have been there, and the answer cannot be derived on the
 * Site side: the mode, the key and the selected Provider are all installation state a Site never sees.
 *
 * Deliberately **not** carried in the capability snapshot, although an earlier note said so. That
 * snapshot answers whether a provider *offers a capability interface*, one verdict per provider, and
 * Core's entry is unconditionally `available` because Core is the server that is answering. Translation
 * is configuration, not interface: the same build translates or does not depending on what an operator
 * saved. Folding it in would have meant either a Core entry that turns `misconfigured` -- switching off
 * every unrelated first-party Module with it -- or a capability id whose presence means nothing.
 *
 * It is about a Site because the offered list is, and about nothing narrower: not a thread, not a
 * message, not a viewer. What is asked at the moment of use is only whether *this* body may leave Core.
 */

export type PhisTranslationOffer = {
  /** Whether asking is worth anything at all. False means no control, not an empty one. */
  available: boolean;
  /**
   * The Site's own locales that can actually be produced, in the Site's order.
   *
   * The intersection and not the platform's list: a Site publishing German and English offers German and
   * English, because a translation into a language the Site does not run is a page nobody can read
   * afterwards.
   */
  targetLocales: string[];
};

const UNAVAILABLE: PhisTranslationOffer = { available: false, targetLocales: [] };

/**
 * The Site's locales, normalized and deduplicated, keeping the Site's order.
 *
 * Aliases resolve, so a Site configured with `zh-CN` offers `zh-Hans` and one language appears once.
 */
function normalizeSiteLocales(locales: readonly string[]) {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of locales) {
    const locale = resolvePhiLocaleCapability(entry)?.locale;
    if (!locale || seen.has(locale)) {
      continue;
    }
    seen.add(locale);
    normalized.push(locale);
  }
  return normalized;
}

/**
 * Kept for the life of the process, and keyed by the selection it was asked about.
 *
 * The contract says a Provider is probed when it is configured rather than per translation, for the
 * reason given there: a list fetched at the moment of use decides whether a control may be drawn after
 * it has been drawn. What an operator changes is the selection, and a changed selection is a different
 * key -- so a saved change takes effect without a restart and nothing else does.
 */
let cachedProbe: {
  providerKey: string;
  secretReference: string | null;
  targetLocales: string[];
} | null = null;

async function resolveAddonTargetLocales() {
  const translation = getPhisConfigSync().translation;
  const providerKey = translation?.providerKey?.trim() ?? "";
  const secretReference = translation?.secretReference?.trim() || null;
  if (!providerKey) {
    return [];
  }
  if (cachedProbe?.providerKey === providerKey && cachedProbe.secretReference === secretReference) {
    return cachedProbe.targetLocales;
  }

  // Reached for rather than held, for the reason the unit reaches for the same module: the Add-on
  // machinery has no business in the graph of an installation that translates with DeepL.
  const { probeTranslationAddon } = await import("@/lib/translation-addon");
  const probe = await probeTranslationAddon();
  const targetLocales = probe?.usable
    ? normalizeSiteLocales(probe.targetLangs)
    : [];
  cachedProbe = { providerKey, secretReference, targetLocales };
  return targetLocales;
}

/**
 * What this installation offers one Site.
 *
 * The DeepL modes answer from the platform's own locale capability table rather than from DeepL's
 * `/v2/languages`. Every entry in that table carries the DeepL target code it is reached under, so the
 * table already *is* this platform's statement of what DeepL can produce -- asking the API per call would
 * be a round trip for a list we shipped, and an outage in it would hide a control that works. An earlier
 * note planned the API call; keeping the two in step is a table to maintain, which is the honest cost.
 *
 * `cdn+deepl` needs the key here even though the mode is usable without one. The CDN step answers for the
 * platform's own messages and is never shown a body, so an installation with a CDN and no key translates
 * the interface and no conversation -- which is exactly `available: false` for this question.
 */
export async function resolvePhisTranslationOffer(
  siteLocales: readonly string[],
): Promise<PhisTranslationOffer> {
  const locales = normalizeSiteLocales(siteLocales);
  if (locales.length === 0) {
    return UNAVAILABLE;
  }

  const mode = getConfiguredTranslationMode();
  if (translationModeUsesDeepL(mode)) {
    if (!getPhisConfigSync().deepl?.apiKey?.trim()) {
      return UNAVAILABLE;
    }
    return { available: true, targetLocales: locales };
  }

  if (mode === "add-on") {
    const offered = new Set(await resolveAddonTargetLocales());
    const targetLocales = locales.filter((locale) => offered.has(locale));
    return targetLocales.length > 0 ? { available: true, targetLocales } : UNAVAILABLE;
  }

  return UNAVAILABLE;
}
