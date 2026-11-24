import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "crypto";

import {
  computeExternalSourceHash,
  ensureGlobalExternalTranslationUnit,
  ensureSiteExternalTranslationUnit,
  findGlobalExternalTranslationUnits,
  findGlobalMessageHashes,
  findSiteExternalTranslationUnitsByContext,
  resolveSiteMessageIds,
  getSiteTranslations,
  getTranslations,
  readTranslationChangeMarkers,
  upsertSiteTranslations,
  upsertTranslation,
} from "@/db/translations";
import { getPhisConfigSync } from "@/lib/config";
import {
  getConfiguredTranslationMode,
  normalizeBatchMessages,
  readDeepLFormality,
  requestPhisTranslationUnit,
} from "@/lib/translation-unit";
import { getConfiguredTranslationSupportedLocalesSync } from "@/lib/translation-locale-options";
import type { PhisTranslationWriteMode } from "@/lib/translation-write-mode";
import {
  PHI_CANONICAL_SOURCE_LOCALE,
  requirePhiTranslationLocale,
  resolvePhiLocaleBase,
  resolvePhiLocaleCapability,
} from "@/lib/locale";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
import { readHtmlTranslationAnswerDefect } from "@/lib/translation-markup";
import {
  buildTranslationContext,
  getProviderTranslationContext,
  type TranslationContextFlag,
} from "@/lib/translation-context";

/**
 * How much of a message its catalogue hash covers. Fixed, and deliberately a prefix.
 *
 * Hashing a prefix keeps the cost of a key independent of the length of the text, and 50 characters tell
 * nearly every message apart. Two messages that share their opening are one key; the second is reported
 * as a conflict for that message alone and shown in its source text. The key is the hash together with
 * the context, so a conflict is resolved where it arises: the author changes the wording, or the second
 * message is given a context of its own. That is the intended answer to a collision, and a conflict
 * warning is a notice to an author, not a defect of the hash. Do not widen the hash to remove one: every
 * stored key changes with it and every installation translates its whole catalogue again.
 */
const TR_HASH_PREFIX_LENGTH = 50;
type TranslationFormat = "text" | "html";

type TranslationInput = {
  locale: string;
  sourceLocale?: string;
  msg: string;
  ctx?: string | null;
  hash?: string | null;
  write?: PhisTranslationWriteMode;
  format?: TranslationFormat | null;
};

type SiteTranslationInput = {
  siteId: number;
  locale: string;
  sourceLocale: string;
  msg: string;
  ctx?: string | null;
  format?: TranslationFormat | null;
};

type SiteBatchTranslationInput = {
  siteId: number;
  locale: string;
  sourceLocale: string;
  msgs: string[];
  ctx?: string | null;
  format?: TranslationFormat | null;
};

type BatchTranslationInput = {
  locale: string;
  sourceLocale?: string;
  msgs: string[];
  ctx?: string | null;
  write?: PhisTranslationWriteMode;
  format?: TranslationFormat | null;
};

const SHA256_HEX_LENGTH = 64;

function computeTranslationHash(msg: string) {
  return createHash("sha256")
    .update(msg.slice(0, TR_HASH_PREFIX_LENGTH))
    .digest("hex");
}

function normalizeProvidedHash(hash: string) {
  const normalized = hash.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(normalized) || normalized.length !== SHA256_HEX_LENGTH) {
    throw new Error("hash must be a 64-character hex SHA-256 string.");
  }
  return normalized;
}

function normalizeTranslationFormat(format?: string | null): TranslationFormat {
  return format === "html" ? "html" : "text";
}

function buildTranslationCacheContext(input: {
  ctx: string;
  format: TranslationFormat;
  external?: boolean;
}) {
  const flags: TranslationContextFlag[] = [];
  if (input.format === "html") {
    flags.push("html");
  }
  if (input.external) {
    flags.push("extern");
  }
  return buildTranslationContext({ context: input.ctx, flags });
}

/**
 * Whether an answer is a stand-in: source text handed back in place of a translation, because a provider
 * or a single message failed, or because the request was not allowed to have what it found missing
 * translated. A Site keeps translations without expiry, so it must not keep these -- they would outlive
 * the outage until somebody edited a translation.
 *
 * An installation that translates nothing is not standing in for anything: there is no step after
 * `none`, so its source text is the final answer and marking it would say an outage where there is a
 * configuration. A public read of the global store is the other case. It reads `tr_lang` and may not
 * fill it, so its source text means "not here" to an installation that has DeepL waiting behind this
 * step -- and unmarked it would arrive there as a translation, which is a string that never gets
 * translated again.
 */
const translationStandIns = new AsyncLocalStorage<{ standIn: boolean }>();

function recordTranslationStandIn() {
  const state = translationStandIns.getStore();
  if (state) {
    state.standIn = true;
  }
}

/** Runs one translation request and reports whether any answer in it is a stand-in. */
export async function trackTranslationStandIns<T>(work: () => Promise<T>) {
  const state = { standIn: false };
  const value = await translationStandIns.run(state, work);
  return { value, standIn: state.standIn };
}

/**
 * What decides a source-text answer that is not a stand-in: with no provider, or for a locale that is not
 * offered, the source text is the answer until the configuration changes. Folded into the markers so a
 * changed configuration reaches Sites that kept those answers.
 */
function getTranslationConfigurationFingerprint() {
  const config = getPhisConfigSync();
  return createHash("sha256")
    .update(JSON.stringify({
      mode: getConfiguredTranslationMode(),
      deepl: Boolean(config.deepl?.apiKey?.trim()),
      formality: readDeepLFormality(config.deepl?.formality) ?? null,
      locales: getConfiguredTranslationSupportedLocalesSync(),
    }))
    .digest("hex")
    .slice(0, 12);
}

/**
 * What a Site compares, on every Site config read, to know whether the translations it keeps are still
 * the answer: one marker for the global store, one for its own. Opaque; only equality means anything.
 */
export async function getTranslationChangeMarkers(siteId: number) {
  const stored = await readTranslationChangeMarkers(siteId);
  const configuration = getTranslationConfigurationFingerprint();
  return {
    global: `${stored.global ?? "0"}.${configuration}`,
    site: `${stored.site ?? "0"}.${configuration}`,
  };
}

/**
 * Whether this installation can take text written in that language as a source.
 *
 * For the two DeepL modes the capability table answers it, which is where a locale's DeepL source is
 * recorded. `add-on` would be the selected provider's probe -- `sourceLangs` on
 * `PhisTranslationProbe` -- and until one can be resolved there is nothing to ask, so nothing is
 * supported. `none` supports nothing for the same reason.
 */
function isConfiguredSourceLocaleSupported(locale: string) {
  const mode = getConfiguredTranslationMode();
  return (mode === "deepl" || mode === "cdn+deepl") && resolvePhiLocaleCapability(locale) != null;
}

/**
 * Runs one message's catalogue step and reports failure instead of raising it.
 *
 * Identity in the catalogue can genuinely fail for a single message -- a hash collision with a message
 * that shares its opening, an external source that conflicts with a stored variant -- and that error
 * used to leave the whole batch, so every other string travelling with it fell back to its source
 * language too. A page lost its translations over one paragraph. The message that failed still falls
 * back, on its own; the rest are unaffected.
 */
type MessageIsolationContext = { stage: string; locale: string; ctx: string; siteId?: number; msg: string };

function recordSkippedMessage(error: unknown, context: MessageIsolationContext) {
  recordTranslationStandIn();
  logRuntimeEvent("warn", "translation.message_skipped", {
    message: "A single message could not be resolved in the catalogue. Falling back to source text for it.",
    error: normalizeLogThrowable(error),
    meta: {
      stage: context.stage,
      locale: context.locale,
      ctx: context.ctx,
      siteId: context.siteId ?? null,
      msgLength: context.msg.length,
      msgPrefix: context.msg.slice(0, 80),
    },
  });
}

async function withMessageIsolation<T>(
  step: () => Promise<T>,
  context: MessageIsolationContext,
): Promise<T | null> {
  try {
    return await step();
  } catch (error) {
    recordSkippedMessage(error, context);
    return null;
  }
}

/**
 * The store's way of asking the translation unit, and the one thing it adds.
 *
 * The provider call itself moved to `translation-unit.ts`; what stays here is the flag envelope and
 * the stand-in accounting, because both belong to how a translation is *stored* rather than to how it
 * is obtained. `getProviderTranslationContext` strips `[html]` and `[extern]` so a provider is handed
 * natural language and nothing else.
 *
 * A stand-in is recorded for `failed` and not for `unconfigured`, which is the distinction the old
 * shape carried by having the call sit in the `catch` and not on the early return. An installation
 * that does not translate is not having an outage.
 */
async function requestConfiguredTranslationsOrFallback(input: {
  locale: string;
  msgs: string[];
  ctx?: string;
  sourceLocale: string;
  format: TranslationFormat;
}) {
  const result = await requestPhisTranslationUnit({
    locale: input.locale,
    msgs: input.msgs,
    ctx: getProviderTranslationContext(input.ctx),
    sourceLocale: input.sourceLocale,
    format: input.format,
    /*
     * The store's texts are the platform's own, which is what the CDN step is for.
     *
     * Everything that reaches this function is a keyed message out of `tr_msg` or `tr_site_msg`. A
     * conversation body never does -- it is not stored, keyed or versioned, and it goes to the unit
     * directly as `private`, so no CDN ever sees it.
     */
    audience: "platform",
  });
  if (result.outcome === "failed") {
    recordTranslationStandIn();
  }
  const translations = input.msgs.map((msg, index) => result.translations[index] ?? msg);
  /*
   * Whether each answer may be kept. An `html` answer that cannot be read back -- a `%n` lost or
   * doubled, a tag left open, a link moved to another address -- is a provider failure for that unit
   * alone: its source text stands in and nothing is stored, so the next request asks again instead of
   * every render reading broken markup for good.
   */
  const accepted = translations.map(() => result.succeeded);
  if (result.succeeded && input.format === "html") {
    translations.forEach((answer, index) => {
      const source = input.msgs[index]!;
      const defect = readHtmlTranslationAnswerDefect(source, answer);
      if (!defect) return;
      accepted[index] = false;
      translations[index] = source;
      recordTranslationStandIn();
      logRuntimeEvent("warn", "translation.answer_rejected", {
        message: "A provider's answer to an HTML unit does not keep its tokens or tags. Falling back to source text for it.",
        meta: { defect, locale: input.locale, msgLength: source.length, msgPrefix: source.slice(0, 80) },
      });
    });
  }
  return { translations, succeeded: result.succeeded, accepted };
}

function sameLocale(left: string, right: string) {
  return resolvePhiLocaleBase(left) === resolvePhiLocaleBase(right);
}

export async function translateWithCache(input: TranslationInput) {
  if (input.hash && normalizeProvidedHash(input.hash) !== computeTranslationHash(input.msg.trim())) {
    throw new Error("Provided translation hash does not match the source message.");
  }
  const [translation = input.msg.trim()] = await translateBatchWithCache({
    locale: input.locale,
    sourceLocale: input.sourceLocale,
    msgs: [input.msg],
    ctx: input.ctx,
    write: input.write,
    format: input.format,
  });
  return translation;
}

/**
 * Which of the messages a request missed it may actually have translated.
 *
 * `extend` may have all of them: a message nobody here has seen is created on the way in, which is the
 * point of that right. `fill` may have the ones the catalogue already holds and no others -- and the ones
 * it may not have are not refused, they are simply not here, which is the honest answer to give for them.
 */
async function resolveAskableHashes(
  write: PhisTranslationWriteMode,
  pending: Array<{ msg: string; hash: string }>,
  cacheContext: string,
) {
  if (write === "none") {
    return new Set<string>();
  }
  if (write === "extend") {
    return new Set(pending.map((entry) => entry.hash));
  }
  return await findGlobalMessageHashes(pending, cacheContext);
}

async function translateCanonicalGlobalBatch(input: Required<Pick<BatchTranslationInput, "locale" | "msgs">> & {
  ctx: string;
  write: PhisTranslationWriteMode;
  format: TranslationFormat;
}) {
  const cacheContext = buildTranslationCacheContext({ ctx: input.ctx, format: input.format });
  const uniqueMsgs = Array.from(new Set(input.msgs));
  const result = new Map<string, string>();
  const entries = uniqueMsgs.map((msg) => ({ msg, hash: computeTranslationHash(msg) }));
  const cached = await getTranslations(input.locale, entries, cacheContext);
  const pending = entries.filter((entry) => {
    const value = cached.get(entry.hash);
    // A collision is not asked of the provider: its answer could not be stored and would be paid for on every render.
    if (value instanceof Error) {
      recordSkippedMessage(value, { stage: "getTranslations", locale: input.locale, ctx: cacheContext, msg: entry.msg });
      result.set(entry.msg, entry.msg);
      return false;
    }
    if (value != null) {
      result.set(entry.msg, value);
      return false;
    }
    return true;
  });

  const askableHashes = pending.length > 0
    ? await resolveAskableHashes(input.write, pending, cacheContext)
    : new Set<string>();
  const askable = pending.filter((entry) => askableHashes.has(entry.hash));
  const withheld = pending.filter((entry) => !askableHashes.has(entry.hash));

  /*
   * What was missed and may not be asked for is the absence of a translation, not one.
   *
   * This is the read that may not write at all, and the one that may only fill a message the catalogue
   * holds. In both cases the source text goes back because there is nothing else to send -- and it goes
   * back marked, because the installation behind it has a provider after this step and may only take that
   * turn if it can tell an answer from a miss.
   */
  if (withheld.length > 0) {
    recordTranslationStandIn();
    withheld.forEach((entry) => result.set(entry.msg, entry.msg));
  }

  if (askable.length > 0) {
    const fresh = await requestConfiguredTranslationsOrFallback({
      locale: input.locale,
      msgs: askable.map((entry) => entry.msg),
      ctx: input.ctx,
      sourceLocale: PHI_CANONICAL_SOURCE_LOCALE,
      format: input.format,
    });
    await Promise.all(askable.map(async (entry, index) => {
      const value = fresh.translations[index] ?? entry.msg;
      /*
       * Stored whenever the provider answered, also where the answer reads like the source: "Dashboard"
       * is German for "Dashboard". Leaving those out left them missing for good, and a message the store
       * does not hold is asked of the provider again on every render -- paid for each time, to learn the
       * same thing. A stand-in never gets here: it arrives as not `accepted`.
       */
      if (fresh.accepted[index]) {
        // The translation itself is in hand; failing to cache it is not a reason to withhold it.
        await withMessageIsolation(
          () => upsertTranslation(input.locale, entry.msg, cacheContext, value, entry.hash),
          { stage: "upsertTranslation", locale: input.locale, ctx: cacheContext, msg: entry.msg },
        );
      }
      result.set(entry.msg, value);
    }));
  }
  return input.msgs.map((msg) => result.get(msg) ?? msg);
}

async function translateExternalGlobalBatch(input: Required<Pick<BatchTranslationInput, "locale" | "msgs">> & {
  sourceLocale: string;
  ctx: string;
  write: PhisTranslationWriteMode;
  format: TranslationFormat;
}) {
  /*
   * Three ways out with the source text, and only two of them are answers. Source and target being one
   * language is the translation, and an unsupported source language is rendered unchanged by contract --
   * but a request that may not write never reaches the store at all, so what it returns says nothing
   * about what is in there and must not be read as an answer.
   */
  if (
    sameLocale(input.locale, input.sourceLocale) ||
    !isConfiguredSourceLocaleSupported(input.sourceLocale)
  ) {
    return input.msgs;
  }
  /*
   * An external unit is created, not filled: its `tr_msg` row is owned by a canonical result this
   * installation produces. So the right it needs is the one to extend the catalogue, and a request
   * without it has not looked at anything -- hence the mark.
   */
  if (input.write !== "extend") {
    recordTranslationStandIn();
    return input.msgs;
  }

  const cacheContext = buildTranslationCacheContext({
    ctx: input.ctx,
    format: input.format,
    external: true,
  });
  const uniqueSources = Array.from(new Set(input.msgs));
  const units = new Map<string, { msgId: number; canonicalMsg: string }>();
  const pending: Array<{ source: string; sourceHash: string }> = [];

  const lookups = uniqueSources.map((source) => ({ source, sourceHash: computeExternalSourceHash(source) }));
  const existing = await findGlobalExternalTranslationUnits({
    locale: input.sourceLocale,
    ctx: cacheContext,
    entries: lookups,
  });
  for (const lookup of lookups) {
    const unit = existing.get(lookup.source);
    if (unit instanceof Error) {
      // A hash that names another source: this one falls back, the rest of the batch does not.
      recordSkippedMessage(unit, {
        stage: "findGlobalExternalTranslationUnits", locale: input.locale, ctx: cacheContext, msg: lookup.source,
      });
    } else if (unit) {
      units.set(lookup.source, unit);
    } else {
      pending.push(lookup);
    }
  }

  if (pending.length > 0) {
    const canonical = await requestConfiguredTranslationsOrFallback({
      locale: PHI_CANONICAL_SOURCE_LOCALE,
      msgs: pending.map((entry) => entry.source),
      ctx: input.ctx,
      sourceLocale: input.sourceLocale,
      format: input.format,
    });
    if (canonical.succeeded) {
      await Promise.all(pending.map(async (entry, index) => {
        if (!canonical.accepted[index]) return;
        const canonicalMsg = canonical.translations[index] ?? entry.source;
        const msgId = await withMessageIsolation(
          () => ensureGlobalExternalTranslationUnit({
            sourceLocale: input.sourceLocale,
            source: entry.source,
            sourceHash: entry.sourceHash,
            canonicalMsg,
            canonicalHash: computeTranslationHash(canonicalMsg),
            ctx: cacheContext,
          }),
          { stage: "ensureGlobalExternalTranslationUnit", locale: input.locale, ctx: cacheContext, msg: entry.source },
        );
        // Left out of `units`, the source falls back on its own at the final mapping.
        if (msgId != null) units.set(entry.source, { msgId, canonicalMsg });
      }));
    }
  }

  if (sameLocale(input.locale, PHI_CANONICAL_SOURCE_LOCALE)) {
    return input.msgs.map((source) => units.get(source)?.canonicalMsg ?? source);
  }

  const resolved = new Map<string, string>();
  const canonicalEntries = Array.from(units.entries()).map(([source, unit]) => ({
    source,
    ...unit,
    hash: computeTranslationHash(unit.canonicalMsg),
  }));
  const cached = await getTranslations(
    input.locale,
    canonicalEntries.map(({ canonicalMsg, hash }) => ({ msg: canonicalMsg, hash })),
    cacheContext,
  );
  const targetPending = canonicalEntries.filter((entry) => {
    const value = cached.get(entry.hash);
    if (value instanceof Error) {
      recordSkippedMessage(value, { stage: "getTranslations", locale: input.locale, ctx: cacheContext, msg: entry.canonicalMsg });
      resolved.set(entry.source, entry.source);
      return false;
    }
    if (value != null) {
      resolved.set(entry.source, value);
      return false;
    }
    return true;
  });
  if (targetPending.length > 0) {
    const fresh = await requestConfiguredTranslationsOrFallback({
      locale: input.locale,
      msgs: targetPending.map((entry) => entry.canonicalMsg),
      ctx: input.ctx,
      sourceLocale: PHI_CANONICAL_SOURCE_LOCALE,
      format: input.format,
    });
    await Promise.all(targetPending.map(async (entry, index) => {
      const value = fresh.translations[index] ?? entry.source;
      if (fresh.accepted[index]) {
        await withMessageIsolation(
          () => upsertTranslation(input.locale, entry.canonicalMsg, cacheContext, value, entry.hash),
          { stage: "upsertTranslation", locale: input.locale, ctx: cacheContext, msg: entry.canonicalMsg },
        );
        resolved.set(entry.source, value);
      } else {
        resolved.set(entry.source, entry.source);
      }
    }));
  }
  return input.msgs.map((source) => resolved.get(source) ?? source);
}

export async function translateBatchWithCache({
  locale,
  sourceLocale,
  msgs,
  ctx,
  write,
  format,
}: BatchTranslationInput) {
  if (!locale.trim()) {
    throw new Error("locale is required.");
  }
  const normalizedLocale = requirePhiTranslationLocale(locale);
  const normalizedSourceLocale = sourceLocale?.trim()
    ? requirePhiTranslationLocale(sourceLocale)
    : PHI_CANONICAL_SOURCE_LOCALE;
  const normalizedMsgs = normalizeBatchMessages(msgs);
  const rawCtx = ctx?.trim() ?? "";
  const translationFormat = normalizeTranslationFormat(format);
  if (normalizedMsgs.length === 0 || sameLocale(normalizedLocale, normalizedSourceLocale)) {
    return normalizedMsgs;
  }
  if (!sameLocale(normalizedSourceLocale, PHI_CANONICAL_SOURCE_LOCALE)) {
    return translateExternalGlobalBatch({
      locale: normalizedLocale,
      sourceLocale: normalizedSourceLocale,
      msgs: normalizedMsgs,
      ctx: rawCtx,
      write: write ?? "extend",
      format: translationFormat,
    });
  }
  return translateCanonicalGlobalBatch({
    locale: normalizedLocale,
    msgs: normalizedMsgs,
    ctx: rawCtx,
    write: write ?? "extend",
    format: translationFormat,
  });
}

export async function translateSiteWithCache(input: SiteTranslationInput) {
  const [translation = input.msg.trim()] = await translateSiteBatchWithCache({
    siteId: input.siteId,
    locale: input.locale,
    sourceLocale: input.sourceLocale,
    msgs: [input.msg],
    ctx: input.ctx,
    format: input.format,
  });
  return translation;
}

/**
 * The Site path for a batch of messages, each kept under its stored context (`ctx`, its flags included): the
 * message ids in one go, what `locale` holds, one provider request for the rest -- told `providerCtx` -- and
 * the answers kept. With `create: false` a message the store does not hold is answered as written and nothing
 * is recorded. The answer is per entry, in order.
 */
async function translateCanonicalSiteBatch(input: {
  siteId: number;
  locale: string;
  sourceLocale: string;
  entries: ReadonlyArray<{ msg: string; ctx: string }>;
  providerCtx: string;
  format: TranslationFormat;
  create: boolean;
}): Promise<string[]> {
  const keyOf = (entry: { msg: string; ctx: string }) => `${entry.ctx}\u0000${entry.msg}`;
  const unique = Array.from(new Map(input.entries.map((entry) => [keyOf(entry), entry])).values());
  const isolation = { stage: "ensureSiteMessageIds", locale: input.locale, ctx: unique[0]?.ctx ?? "", siteId: input.siteId };
  // One batch for every message; a message the batch could not place falls back on its own, as before.
  const msgIds = await withMessageIsolation(
    () => resolveSiteMessageIds(input.siteId, unique, { create: input.create }),
    { ...isolation, msg: unique[0]?.msg ?? "" },
  );
  const entries = unique.flatMap((entry, index) => {
    const msgId = msgIds?.[index];
    if (msgId instanceof Error) {
      recordSkippedMessage(msgId, { ...isolation, ctx: entry.ctx, msg: entry.msg });
      return [];
    }
    return msgId == null ? [] : [{ ...entry, msgId }];
  });
  const cached = await getSiteTranslations(entries.map((entry) => entry.msgId), input.locale);
  const result = new Map<string, string>();
  const pending = entries.filter((entry) => {
    const value = cached.get(entry.msgId);
    if (value != null) {
      result.set(keyOf(entry), value);
      return false;
    }
    return true;
  });
  if (pending.length > 0) {
    const fresh = await requestConfiguredTranslationsOrFallback({
      locale: input.locale,
      msgs: pending.map((entry) => entry.msg),
      ctx: input.providerCtx,
      sourceLocale: input.sourceLocale,
      format: input.format,
    });
    const kept = pending.flatMap((entry, index) => fresh.accepted[index]
      ? [{ msgId: entry.msgId, locale: input.locale, translation: fresh.translations[index] ?? entry.msg }]
      : []);
    if (kept.length > 0) {
      // Same rule as everywhere else here: the translations are in hand, and failing to cache them is
      // not a reason to hand back source text instead.
      await withMessageIsolation(
        () => upsertSiteTranslations(kept),
        { stage: "upsertSiteTranslations", locale: input.locale, ctx: pending[0]?.ctx ?? "", siteId: input.siteId, msg: pending[0]?.msg ?? "" },
      );
    }
    pending.forEach((entry, index) => {
      result.set(keyOf(entry), fresh.translations[index] ?? entry.msg);
    });
  }
  return input.entries.map((entry) => result.get(keyOf(entry)) ?? entry.msg);
}

/**
 * The external path (TRANSLATIONS.md, "External and non-canonical sources") for texts that each keep their
 * own stored context, in the fewest statements and provider requests: one lookup for every unit, one request
 * for the canonical renderings missing, one read of what `locale` holds, one request for what it lacks. What
 * the TR route does for a batch under one context (`translateExternalSiteBatchWithCache`), and what a product read does
 * for every product's title under `[extern]product <n> title` at once. `providerCtx` is what the provider is
 * told; each entry's `ctx` is the stored context, its `[extern]` flag included. The answer is per entry, in
 * order: the text in `locale`, or the text as written where it could not be had.
 */
async function translateExternalSiteEntries(input: {
  siteId: number;
  locale: string;
  sourceLocale: string;
  canonicalLocale: string;
  providerCtx: string;
  format: TranslationFormat;
  entries: ReadonlyArray<{ msg: string; ctx: string }>;
}): Promise<string[]> {
  if (
    input.entries.length === 0 ||
    sameLocale(input.locale, input.sourceLocale) ||
    !isConfiguredSourceLocaleSupported(input.sourceLocale)
  ) {
    return input.entries.map((entry) => entry.msg);
  }
  const keyOf = (entry: { msg: string; ctx: string }) => `${entry.ctx}\u0000${entry.msg}`;
  const lookups = Array.from(new Map(input.entries.map((entry) => [keyOf(entry), entry])).values())
    .map((entry) => ({ source: entry.msg, ctx: entry.ctx, sourceHash: computeExternalSourceHash(entry.msg) }));
  const units = new Map<string, { msgId: number; canonicalMsg: string }>();
  const pending: typeof lookups = [];
  const existing = await findSiteExternalTranslationUnitsByContext({
    siteId: input.siteId,
    locale: input.sourceLocale,
    entries: lookups,
  });
  lookups.forEach((lookup, index) => {
    const unit = existing[index];
    if (unit instanceof Error) {
      // A hash that names another source: this one falls back, the rest of the batch does not.
      recordSkippedMessage(unit, {
        stage: "findSiteExternalTranslationUnits", locale: input.locale, ctx: lookup.ctx, siteId: input.siteId, msg: lookup.source,
      });
    } else if (unit) {
      units.set(keyOf({ msg: lookup.source, ctx: lookup.ctx }), unit);
    } else {
      pending.push(lookup);
    }
  });
  if (pending.length > 0) {
    const canonical = await requestConfiguredTranslationsOrFallback({
      locale: input.canonicalLocale,
      msgs: pending.map((entry) => entry.source),
      ctx: input.providerCtx,
      sourceLocale: input.sourceLocale,
      format: input.format,
    });
    if (canonical.succeeded) {
      await Promise.all(pending.map(async (entry, index) => {
        if (!canonical.accepted[index]) return;
        const canonicalMsg = canonical.translations[index] ?? entry.source;
        const msgId = await withMessageIsolation(
          () => ensureSiteExternalTranslationUnit({
            siteId: input.siteId,
            sourceLocale: input.sourceLocale,
            source: entry.source,
            sourceHash: entry.sourceHash,
            canonicalMsg,
            ctx: entry.ctx,
          }),
          { stage: "ensureSiteExternalTranslationUnit", locale: input.locale, ctx: entry.ctx, siteId: input.siteId, msg: entry.source },
        );
        if (msgId != null) units.set(keyOf({ msg: entry.source, ctx: entry.ctx }), { msgId, canonicalMsg });
      }));
    }
  }
  if (sameLocale(input.locale, input.canonicalLocale)) {
    return input.entries.map((entry) => units.get(keyOf(entry))?.canonicalMsg ?? entry.msg);
  }
  const resolved = new Map<string, string>();
  const unitEntries = Array.from(units.entries()).map(([key, unit]) => ({ key, ...unit }));
  const cached = await getSiteTranslations(unitEntries.map((entry) => entry.msgId), input.locale);
  const targetPending = unitEntries.filter((entry) => {
    const value = cached.get(entry.msgId);
    if (value != null) {
      resolved.set(entry.key, value);
      return false;
    }
    return true;
  });
  if (targetPending.length > 0) {
    const fresh = await requestConfiguredTranslationsOrFallback({
      locale: input.locale,
      msgs: targetPending.map((entry) => entry.canonicalMsg),
      ctx: input.providerCtx,
      sourceLocale: input.canonicalLocale,
      format: input.format,
    });
    const kept = targetPending.flatMap((entry, index) => fresh.accepted[index]
      ? [{ msgId: entry.msgId, locale: input.locale, translation: fresh.translations[index] ?? entry.canonicalMsg }]
      : []);
    if (kept.length > 0) {
      await upsertSiteTranslations(kept);
    }
    targetPending.forEach((entry, index) => {
      if (fresh.accepted[index]) resolved.set(entry.key, fresh.translations[index] ?? entry.canonicalMsg);
    });
  }
  return input.entries.map((entry) => resolved.get(keyOf(entry)) ?? entry.msg);
}

/**
 * A batch's messages with the context each is kept under: `ctx` for all of them, or, where `storedContexts`
 * is given, each its own (`product 12 title`) while the provider is still told `ctx` (`product title`). With
 * `storedContexts` the answer stays aligned with `msgs` -- an empty message is answered empty -- and without
 * it the batch is normalized as it always was (trimmed, empty ones dropped).
 */
function readSiteBatchEntries(input: { msgs: string[]; ctx?: string | null; storedContexts?: readonly string[] }) {
  const providerCtx = input.ctx?.trim() ?? "";
  if (input.storedContexts === undefined) {
    return { providerCtx, entries: normalizeBatchMessages(input.msgs).map((msg) => ({ msg, ctx: providerCtx })) };
  }
  if (input.storedContexts.length !== input.msgs.length) {
    throw new Error("storedContexts names one context per message.");
  }
  return {
    providerCtx,
    entries: input.msgs.map((msg, index) => ({ msg: msg.trim(), ctx: input.storedContexts![index]!.trim() })),
  };
}

/** Each entry's answer where `translate` gave one, the empty ones answered as they are. */
async function translateNonEmptyEntries(
  entries: ReadonlyArray<{ msg: string; ctx: string }>,
  translate: (entries: Array<{ msg: string; ctx: string }>) => Promise<string[]>,
) {
  const asked = entries.flatMap((entry, index) => (entry.msg ? [{ ...entry, index }] : []));
  const answers = asked.length > 0 ? await translate(asked) : [];
  const result = entries.map((entry) => entry.msg);
  asked.forEach((entry, position) => {
    result[entry.index] = answers[position] ?? entry.msg;
  });
  return result;
}

/**
 * The Site path of `/api/v1/tr`: messages of the Site's store in its canonical `sourceLocale`, answered in
 * `locale` -- what is held, else the provider's, kept.
 *
 * `storedContexts` keeps each message under a context of its own while the provider is told `ctx` -- the
 * words Core records itself under one context per row (a product's `product <n> title`, told `product
 * title`) -- in the same statements for all of them. `create: false` answers a message the store does not
 * hold as written and records nothing (`translations:v1`'s `translate`, which reads what `record` wrote).
 */
export async function translateSiteBatchWithCache({
  siteId,
  locale,
  sourceLocale,
  msgs,
  ctx,
  format,
  storedContexts,
  create = true,
}: SiteBatchTranslationInput & { storedContexts?: readonly string[]; create?: boolean }) {
  if (!siteId || !locale.trim() || !sourceLocale.trim()) {
    throw new Error("siteId, locale, and sourceLocale are required.");
  }
  const normalizedLocale = requirePhiTranslationLocale(locale);
  const canonicalLocale = requirePhiTranslationLocale(sourceLocale);
  const translationFormat = normalizeTranslationFormat(format);
  const { providerCtx, entries } = readSiteBatchEntries({ msgs, ctx, storedContexts });
  if (entries.length === 0 || sameLocale(normalizedLocale, canonicalLocale)) {
    return entries.map((entry) => entry.msg);
  }
  return translateNonEmptyEntries(entries, (asked) => translateCanonicalSiteBatch({
    siteId,
    locale: normalizedLocale,
    sourceLocale: canonicalLocale,
    entries: asked.map((entry) => ({ msg: entry.msg, ctx: buildTranslationCacheContext({ ctx: entry.ctx, format: translationFormat }) })),
    providerCtx,
    format: translationFormat,
    create,
  }));
}

/**
 * The external path of `/api/v1/tr` (TRANSLATIONS.md, "External and non-canonical sources"): texts written in
 * `sourceLocale`, another language than the Site's `canonicalLocale`, answered in `locale`. `storedContexts`
 * as for `translateSiteBatchWithCache`: each text's unit is kept under `[extern]` and its own context, the
 * provider told `ctx`.
 */
export async function translateExternalSiteBatchWithCache(input: SiteBatchTranslationInput & {
  canonicalLocale: string;
  storedContexts?: readonly string[];
}) {
  const locale = requirePhiTranslationLocale(input.locale);
  const sourceLocale = requirePhiTranslationLocale(input.sourceLocale);
  const canonicalLocale = requirePhiTranslationLocale(input.canonicalLocale);
  const format = normalizeTranslationFormat(input.format);
  const { providerCtx, entries } = readSiteBatchEntries(input);
  if (entries.length === 0 || sameLocale(locale, sourceLocale) || !isConfiguredSourceLocaleSupported(sourceLocale)) {
    return entries.map((entry) => entry.msg);
  }
  return translateNonEmptyEntries(entries, (asked) => translateExternalSiteEntries({
    siteId: input.siteId,
    locale,
    sourceLocale,
    canonicalLocale,
    providerCtx,
    format,
    entries: asked.map((entry) => ({ msg: entry.msg, ctx: buildTranslationCacheContext({ ctx: entry.ctx, format, external: true }) })),
  }));
}
