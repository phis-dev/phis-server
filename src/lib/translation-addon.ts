import "server-only";

import type {
  PhisTranslationAdapter,
  PhisTranslationProbe,
  PhisTranslationProviderId,
  PhisTranslationServiceContext,
} from "@phis/contracts/addon";

import { getPhisConfigSync } from "@/lib/config";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
import { resolvePhiSecret } from "@/lib/secrets/resolver";
import type {
  PhisTranslationUnitFormat,
  PhisTranslationUnitResult,
} from "@/lib/translation-unit";

/**
 * The `add-on` mode, resolved and called.
 *
 * Its own file rather than a branch inside the translation unit, for the reason the unit's own docblock
 * gives about DeepL: the facts here are this path's and nobody else's. A request limit of 128 KiB, a
 * concurrency of one and a circuit breaker are DeepL's; a Provider that a build contains, an operator
 * selected and a manifest digest identifies is this one's. Neither set belongs in the other's file.
 *
 * Nothing here decides *whether* to use an Add-on. The mode does, in `translation-unit.ts`, which is
 * also the only caller -- so an installation cannot end up asking two translators for one text.
 */

type TranslationAddonSelection = {
  providerKey: string;
  secretReference: string | null;
};

/**
 * What the operator selected, or nothing.
 *
 * `providerKey` alone, because uniqueness is on `(service kind, provider key)` and the kind is Core's.
 * An empty key is the honest state of an installation that has the mode set and nothing chosen; the
 * operator panel refuses to save that combination, and this answers for a configuration file written by
 * hand as well.
 */
function readTranslationAddonSelection(): TranslationAddonSelection | null {
  const translation = getPhisConfigSync().translation;
  const providerKey = translation?.providerKey?.trim() ?? "";
  if (!providerKey) {
    return null;
  }
  return {
    providerKey,
    secretReference: translation?.secretReference?.trim() || null,
  };
}

/**
 * The Provider's context, and the whole of it.
 *
 * `readSecret` is bound to the one reference the operator's translation configuration names, so there is
 * no argument through which a Provider could ask for another -- the same arrangement a Storage Profile
 * has. Core resolves it as Core, because the configuration that names it is Core-owned state and letting
 * the Add-on resolve its own reference would mean trusting it to ask only for its own.
 *
 * There is no Site in here, by contract: which translator an installation uses is an installation's
 * decision, so a Provider is never handed a Site it could come to treat differently from another.
 */
function buildTranslationServiceContext(
  selection: TranslationAddonSelection,
  providerId: PhisTranslationProviderId,
): PhisTranslationServiceContext {
  return {
    providerId,
    readSecret: () =>
      selection.secretReference
        ? resolvePhiSecret({ kind: "core" }, selection.secretReference)
        : Promise.resolve(null),
  };
}

/**
 * Kept across calls, keyed by everything that would make it the wrong adapter.
 *
 * The resolver behind it caches the *factory* by manifest digest, which an upgraded Add-on invalidates.
 * What it cannot see is the operator changing the selection or the secret reference, because those are
 * configuration and not a build -- so both are in the key here, and a saved change is a different
 * adapter rather than a stale one.
 */
let cachedAdapter: {
  providerKey: string;
  secretReference: string | null;
  adapter: PhisTranslationAdapter;
} | null = null;

/**
 * The selected Provider, instantiated, or null when there is nothing to instantiate.
 *
 * Null is "this installation does not translate" in all its forms: no selection, an Add-on that is
 * disabled, one built against another interface version, one the registry does not match. The resolver
 * throws for each of those with a reason, and the reason is logged rather than returned -- a Site is
 * told that translation is unavailable, never which Add-on an operator misconfigured.
 *
 * A Provider whose factory throws while being constructed is the same answer. It is not an outage: an
 * adapter that cannot be built will not build on the next request either.
 */
export async function resolveTranslationAddonAdapter(): Promise<PhisTranslationAdapter | null> {
  const selection = readTranslationAddonSelection();
  if (!selection) {
    return null;
  }
  if (
    cachedAdapter
    && cachedAdapter.providerKey === selection.providerKey
    && cachedAdapter.secretReference === selection.secretReference
  ) {
    return cachedAdapter.adapter;
  }

  /*
   * Imported here and not at the top, the way the Storage side does it.
   *
   * The Add-on resolver reaches the installed manifest, the registry and the database. Every translation
   * in every mode would pull that into the graph if this import were static, and an installation that
   * translates with DeepL has no business loading the Add-on machinery at all.
   */
  const { resolvePhisServiceProvider } = await import("@/lib/addons/services");
  const { PHIS_SERVICE_KINDS } = await import("@/lib/addons/core-services");

  try {
    const resolved = await resolvePhisServiceProvider(
      PHIS_SERVICE_KINDS.translation,
      selection.providerKey,
    );
    const providerId = resolved.addonId as PhisTranslationProviderId;
    /*
     * `null` where a Storage Profile passes its configuration row.
     *
     * A translation Provider is chosen per installation and has no profile row to be configured in, so
     * today its secret is the only thing an operator can give it. A Provider that needs more than that
     * -- an endpoint, a model name -- has nowhere to read it from yet, and that is a gap to close in the
     * configuration rather than to paper over with a shape invented here.
     */
    const adapter = resolved.factory(
      null,
      buildTranslationServiceContext(selection, providerId),
    ) as PhisTranslationAdapter;
    if (typeof adapter?.translate !== "function" || typeof adapter?.probeCapabilities !== "function") {
      throw new Error(`${resolved.addonId} built something that is not a translation adapter.`);
    }
    cachedAdapter = {
      providerKey: selection.providerKey,
      secretReference: selection.secretReference,
      adapter,
    };
    return adapter;
  } catch (error) {
    logRuntimeEvent("warn", "translation.addon_unavailable", {
      message: "The selected translation add-on could not be used.",
      error: normalizeLogThrowable(error),
      meta: { providerKey: selection.providerKey },
    });
    return null;
  }
}

/**
 * What the selected Provider can do, asked when an installation wants to offer a choice.
 *
 * Null for an installation with nothing resolvable, and null for a probe that throws -- a Provider is
 * supposed to answer `usable: false` with a finding instead, and one that throws has said the same thing
 * less clearly. Nothing is cached here: the caller decides how long an answer stays true, because the
 * answer is about a service somewhere else.
 */
export async function probeTranslationAddon(): Promise<PhisTranslationProbe | null> {
  const adapter = await resolveTranslationAddonAdapter();
  if (!adapter) {
    return null;
  }
  try {
    return await adapter.probeCapabilities();
  } catch (error) {
    logRuntimeEvent("warn", "translation.addon_probe_failed", {
      message: "The selected translation add-on did not answer a capability probe.",
      error: normalizeLogThrowable(error),
    });
    return null;
  }
}

/**
 * One batch, handed to the selected Provider.
 *
 * The two ways of not succeeding are kept apart here as everywhere: nothing selected or nothing
 * resolvable is `unconfigured`, and a Provider that was there and did not answer is `failed`. Only the
 * second will be right again later without anybody changing anything.
 *
 * A Provider answering with a different number of texts than it was given is `failed` and not a partial
 * success. Callers match answers back by position and nothing else, so a list that does not line up is
 * not a translation of anything in particular.
 */
export async function requestTranslationFromAddon(input: {
  texts: string[];
  locale: string;
  sourceLocale: string | null;
  ctx?: string;
  format: PhisTranslationUnitFormat;
}): Promise<PhisTranslationUnitResult> {
  const adapter = await resolveTranslationAddonAdapter();
  if (!adapter) {
    return {
      translations: input.texts,
      succeeded: false,
      outcome: "unconfigured",
      detectedSourceLocales: [],
    };
  }

  try {
    const answer = await adapter.translate({
      texts: input.texts,
      sourceLang: input.sourceLocale,
      targetLang: input.locale,
      format: input.format,
      context: input.ctx?.trim() || undefined,
    });
    if (answer.texts.length !== input.texts.length) {
      throw new Error(
        `The translation add-on answered ${answer.texts.length} texts for ${input.texts.length}.`,
      );
    }
    return {
      translations: answer.texts.map((text) => String(text ?? "")),
      succeeded: true,
      outcome: "translated",
      /*
       * Nothing claimed, because the contract has nowhere to claim it.
       *
       * `PhisTranslationResult` carries texts and no detected language. A Provider that detects one
       * keeps it to itself, so a caller wanting to name the source language gets null here and says so
       * -- which is better than DeepL's field being quietly assumed of everybody.
       */
      detectedSourceLocales: [],
    };
  } catch (error) {
    logRuntimeEvent("warn", "translation.external_fallback", {
      message: "The translation add-on failed. Falling back to source text.",
      error: normalizeLogThrowable(error),
      meta: {
        provider: "add-on",
        locale: input.locale,
        sourceLocale: input.sourceLocale,
        format: input.format,
        msgCount: input.texts.length,
      },
    });
    return {
      translations: input.texts,
      succeeded: false,
      outcome: "failed",
      detectedSourceLocales: [],
    };
  }
}
