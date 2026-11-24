import "server-only";

import {
  PHIS_ADDON_TRANSLATION_CONTEXT_MAX,
  PHIS_ADDON_TRANSLATION_TEXT_MAX,
  PHIS_ADDON_TRANSLATION_TEXTS_MAX,
  type PhisTranslationsCapabilityV1,
} from "@phis/contracts/addon";

import { getPhisConfigSync } from "@/lib/config";
import { resolvePhiSiteSourceLocale } from "@/lib/config-core";
import { resolvePhiLocaleBase, resolvePhiLocaleCapability } from "@/lib/locale";
import { fillSiteMessageTranslations, trackTranslationStandIns } from "@/lib/translations";
import { ensureSiteMessageIds, findSiteMessageIds, getSiteTranslations } from "@/db/translations";

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
 */

export class PhisAddonTranslationsError extends Error {}

export function buildPhisAddonTranslationsCapability(input: {
  addonId: string;
  siteId: number;
  siteKey: string;
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

  /** The reader's language and the Site's, or null where the texts as written are the answer. */
  const readLocale = (locale: unknown) => {
    if (locale === null) return null;
    if (typeof locale !== "string") throw new PhisAddonTranslationsError("locale is a locale key such as de, or null for the texts as written.");
    const capability = resolvePhiLocaleCapability(locale);
    if (!capability) return null;
    const sourceLocale = resolvePhiSiteSourceLocale(getPhisConfigSync(), input.siteKey);
    return resolvePhiLocaleBase(capability.locale) === resolvePhiLocaleBase(sourceLocale) ? null : { locale: capability.locale, sourceLocale };
  };

  return {
    async record({ context, texts }) {
      if (input.unauthenticated) {
        throw new PhisAddonTranslationsError(
          `${addonId} called translations.record from an unverified hook; a visitor writes nothing into the Site's translation store.`,
        );
      }
      const ctx = readContext(context);
      const recorded = readTexts(texts).filter((text) => text.trim() !== "");
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

    async translate({ context, locale, texts }) {
      const ctx = readContext(context);
      const asWritten = readTexts(texts);
      const read = readLocale(locale);
      if (!read) return { texts: [...asWritten], provisional: false };
      const { value, standIn } = await trackTranslationStandIns(async () => {
        const ids = await findSiteMessageIds(siteId, asWritten.filter((text) => text.trim() !== ""), ctx);
        const held = await getSiteTranslations([...ids.values()], read.locale);
        const missing = [...ids].flatMap(([msg, msgId]) => (held.get(msgId)?.trim() ? [] : [{ msgId, msg }]));
        const filled = await fillSiteMessageTranslations({
          siteId, locale: read.locale, sourceLocale: read.sourceLocale, providerContext: ctx, messages: missing,
        });
        return asWritten.map((text) => {
          const msgId = ids.get(text);
          if (msgId === undefined) return text;
          const translation = held.get(msgId);
          return translation?.trim() ? translation : filled.get(msgId) ?? text;
        });
      });
      return { texts: value, provisional: standIn };
    },
  } satisfies PhisTranslationsCapabilityV1;
}
