import "server-only";

import {
  PHIS_ADDON_TRANSLATION_CONTEXT_MAX,
  PHIS_ADDON_TRANSLATION_TEXT_MAX,
  PHIS_ADDON_TRANSLATION_TEXTS_MAX,
  PhisTranslationResultFlag,
  type PhisTranslationsCapabilityV1,
} from "@phis/contracts/addon";

import { resolvePhiLocaleBase, resolvePhiLocaleCapability } from "@/lib/locale";
import { trackTranslationStandIns, translateSiteTextsWithCache } from "@/lib/translations";
import { ensureSiteMessageIds } from "@/db/translations";

/**
 * `translations:v1` for one request (SERVER_ADDONS.md, translations:v1): an Add-on's own words as source
 * texts of the Site's translation store, and read back in a reader's language.
 *
 * The Site and the Add-on are closed over. The stored context is built here -- `<addonId>: <context>` --
 * and never taken from the caller, which is the rule the global store applies to another application's
 * strings (TRANSLATIONS.md, "Somebody else's strings in the global store"): whatever an Add-on sends, its
 * texts begin with its own name and cannot land in a register of the platform's or of another Add-on.
 * Beyond that a message is an ordinary Site message, so Editor > Translations, `phis translations
 * export|import --site` and the change markers treat it as they treat a Page's words.
 *
 * The texts' language is the caller's `sourceLocale`, else the manifest's -- the Add-on's own, shipped texts
 * -- else the Site's (`@phis/contracts/products`, the source-language rule). Texts in the Site's language are
 * filled on their own message; texts in another take the TR route's external path under `[extern]<addonId>:
 * <context>`, rendered into the Site's language once and every other language from that rendering. A
 * translation a person keeps on the recorded message wins either way.
 */

export class PhisAddonTranslationsError extends Error {}

export function buildPhisAddonTranslationsCapability(input: {
  addonId: string;
  siteId: number;
  /** The Site's source language. */
  siteSourceLocale: string;
  /** The manifest's `sourceLocale`: the language of what the Add-on records without naming one. */
  addonSourceLocale: string | null;
  /** True when nobody authenticated and no signature stood in for them -- an unverified hook. */
  unauthenticated?: boolean;
}): PhisTranslationsCapabilityV1 {
  const { addonId, siteId } = input;

  /** The stored context: the Add-on's name in front of its own word, checked as a key is. */
  const readContext = (context: unknown) => {
    if (
      typeof context !== "string" ||
      context.trim() !== context ||
      context === "" ||
      context.length > PHIS_ADDON_TRANSLATION_CONTEXT_MAX ||
      context.startsWith("[") ||
      /[\u0000-\u001f]/u.test(context)
    ) {
      throw new PhisAddonTranslationsError(
        `context is the Add-on's own word for its texts, 1 to ${PHIS_ADDON_TRANSLATION_CONTEXT_MAX} characters without a leading [ or surrounding spaces.`,
      );
    }
    return `${addonId}: ${context}`;
  };

  const readTexts = (texts: unknown) => {
    if (!Array.isArray(texts) || texts.length > PHIS_ADDON_TRANSLATION_TEXTS_MAX) {
      throw new PhisAddonTranslationsError(`texts is a list of at most ${PHIS_ADDON_TRANSLATION_TEXTS_MAX} strings.`);
    }
    for (const text of texts) {
      if (typeof text !== "string" || text.length > PHIS_ADDON_TRANSLATION_TEXT_MAX) {
        throw new PhisAddonTranslationsError(`Each text is a string of at most ${PHIS_ADDON_TRANSLATION_TEXT_MAX} characters.`);
      }
    }
    return texts as string[];
  };

  /** The texts' language: the caller's, else the Add-on's own, else the Site's; refused where Core knows none such. */
  const readSourceLocale = (sourceLocale: unknown) => {
    if (sourceLocale === undefined) return input.addonSourceLocale ?? input.siteSourceLocale;
    const capability = typeof sourceLocale === "string" ? resolvePhiLocaleCapability(sourceLocale) : null;
    if (!capability) throw new PhisAddonTranslationsError("sourceLocale is a locale key Core knows, such as en or fr: the language the texts are written in.");
    return capability.locale;
  };

  /** The reader's language, or null where the texts as written are the answer: null, unknown, or theirs. */
  const readLocale = (locale: unknown, sourceLocale: string) => {
    if (locale === null) return null;
    if (typeof locale !== "string") throw new PhisAddonTranslationsError("locale is a locale key such as de, or null for the texts as written.");
    const capability = resolvePhiLocaleCapability(locale);
    if (!capability) return null;
    return resolvePhiLocaleBase(capability.locale) === resolvePhiLocaleBase(sourceLocale) ? null : capability.locale;
  };

  return {
    async record({ context, texts, sourceLocale }) {
      if (input.unauthenticated) {
        throw new PhisAddonTranslationsError(
          `${addonId} called translations.record from an unverified hook; a visitor writes nothing into the Site's translation store.`,
        );
      }
      const ctx = readContext(context);
      // Checked though not stored: the text is kept as written in whatever language, as a product's are.
      readSourceLocale(sourceLocale);
      // Trimmed, as the TR route reads a message back (`translateSiteTextsWithCache`).
      const recorded = readTexts(texts).map((text) => text.trim()).filter((text) => text !== "");
      if (recorded.length === 0) return;
      // A text that collides with a stored one under the same opening is refused; the others are kept.
      const ids = await ensureSiteMessageIds(siteId, recorded, ctx);
      const failed = [...ids.values()].find((id): id is Error => id instanceof Error);
      if (failed) {
        throw new PhisAddonTranslationsError(
          `A text could not be recorded: another text of ${ctx} opens with the same 50 characters. Word it differently.`,
        );
      }
    },

    async translate({ context, locale, texts, sourceLocale }) {
      const ctx = readContext(context);
      const asWritten = readTexts(texts);
      const language = readSourceLocale(sourceLocale);
      const target = readLocale(locale, language);
      if (!target) return { texts: [...asWritten], flags: 0 };
      // The TR route's own choice, reading only what `record` wrote: in the Site's language the Site path on the
      // recorded message; in another a translation held on it wins and the rest takes the external path.
      const { value, standIn } = await trackTranslationStandIns(() => translateSiteTextsWithCache({
        siteId, locale: target, sourceLocale: language, canonicalLocale: input.siteSourceLocale, msgs: asWritten, ctx,
        storedContexts: asWritten.map(() => ctx), format: "text", create: false, recordedMessages: true,
      }));
      return { texts: value, flags: standIn ? PhisTranslationResultFlag.Provisional : 0 };
    },
  } satisfies PhisTranslationsCapabilityV1;
}
