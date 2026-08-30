import "server-only";

import { createHash } from "crypto";

import {
  computeExternalSourceHash,
  ensureGlobalExternalTranslationUnit,
  ensureSiteMessageId,
  ensureSiteExternalTranslationUnit,
  findGlobalExternalTranslationUnit,
  findSiteExternalTranslationUnit,
  getSiteTranslations,
  getTranslations,
  upsertSiteTranslations,
  upsertTranslation,
} from "@/db/translations";
import { getPhiServerConfigSync } from "@/lib/config";
import {
  DEFAULT_LOCALE,
  resolveDeepLSourceLang,
  resolveDeepLTargetLang,
  resolvePhiLocaleCapability,
} from "@/lib/locale";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
import {
  buildTranslationContext,
  getProviderTranslationContext,
  type TranslationContextFlag,
} from "@/lib/translation-context";

const DEFAULT_DEEPL_URL = "https://api-free.deepl.com/v2/translate";
const TR_HASH_PREFIX_LENGTH = 50;
const DEEPL_MAX_CONCURRENT_REQUESTS = 1;
const DEEPL_CIRCUIT_BREAKER_MS = 30_000;
const DEEPL_MAX_REQUEST_BYTES = 128 * 1024;
const DEEPL_MAX_TEXTS_PER_REQUEST = 50;
type TranslationFormat = "text" | "html";

type TranslationInput = {
  locale: string;
  sourceLocale?: string;
  msg: string;
  ctx?: string | null;
  hash?: string | null;
  allowWrite?: boolean;
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
  allowWrite?: boolean;
  format?: TranslationFormat | null;
};

const SHA256_HEX_LENGTH = 64;
let activeDeepLRequests = 0;
let deepLCircuitOpenUntil = 0;
const deepLQueue: Array<() => void> = [];
const inFlightDeepLRequests = new Map<string, Promise<string[]>>();

function normalizeLocaleKey(locale: string) {
  return locale.trim().toLowerCase().split(/[-_]/)[0] ?? "";
}

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

function normalizeBatchMessages(msgs: string[]) {
  return msgs.map((msg) => msg.trim()).filter(Boolean);
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

function getConfiguredTranslationMode() {
  return getPhiServerConfigSync().translation?.mode ?? "none";
}

function isConfiguredSourceLocaleSupported(locale: string) {
  const mode = getConfiguredTranslationMode();
  if (mode === "custom") {
    return true;
  }
  return mode === "deepl" && resolvePhiLocaleCapability(locale) != null;
}

function buildExternalTranslationCacheKey(input: {
  provider: "custom" | "deepl";
  locale: string;
  sourceLocale?: string;
  ctx?: string;
  format: TranslationFormat;
  msgs: string[];
}) {
  return JSON.stringify({
    provider: input.provider,
    locale: input.locale,
    sourceLocale: input.sourceLocale ?? "",
    ctx: input.ctx ?? "",
    format: input.format,
    msgs: input.msgs,
  });
}

function logExternalTranslationFallback(input: {
  provider: "custom" | "deepl";
  locale: string;
  sourceLocale?: string;
  ctx?: string;
  format: TranslationFormat;
  msgCount: number;
  error: unknown;
}) {
  logRuntimeEvent("warn", "translation.external_fallback", {
    message: "External translation failed. Falling back to source text.",
    error: normalizeLogThrowable(input.error),
    meta: {
      provider: input.provider,
      locale: input.locale,
      sourceLocale: input.sourceLocale ?? null,
      ctx: input.ctx ?? null,
      format: input.format,
      msgCount: input.msgCount,
    },
  });
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
async function withMessageIsolation<T>(
  step: () => Promise<T>,
  context: { stage: string; locale: string; ctx: string; siteId?: number; msg: string },
): Promise<T | null> {
  try {
    return await step();
  } catch (error) {
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
    return null;
  }
}

function openDeepLCircuitBreaker() {
  deepLCircuitOpenUntil = Date.now() + DEEPL_CIRCUIT_BREAKER_MS;
}

async function acquireDeepLSlot() {
  if (activeDeepLRequests < DEEPL_MAX_CONCURRENT_REQUESTS) {
    activeDeepLRequests += 1;
    return;
  }

  await new Promise<void>((resolve) => {
    deepLQueue.push(resolve);
  });
  activeDeepLRequests += 1;
}

function releaseDeepLSlot() {
  activeDeepLRequests = Math.max(0, activeDeepLRequests - 1);
  const next = deepLQueue.shift();
  if (next) {
    next();
  }
}

async function runDeepLRequest(
  cacheKey: string,
  request: () => Promise<string[]>,
) {
  if (Date.now() < deepLCircuitOpenUntil) {
    throw new Error("DeepL circuit breaker is open.");
  }

  const inFlight = inFlightDeepLRequests.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const promise = (async () => {
    await acquireDeepLSlot();
    try {
      return await request();
    } finally {
      releaseDeepLSlot();
    }
  })();

  inFlightDeepLRequests.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inFlightDeepLRequests.delete(cacheKey);
  }
}

async function requestConfiguredTranslationsOrFallback(input: {
  locale: string;
  msgs: string[];
  ctx?: string;
  sourceLocale: string;
  format: TranslationFormat;
}) {
  const normalizedTexts = normalizeBatchMessages(input.msgs);
  if (normalizedTexts.length === 0) {
    return { translations: [] as string[], succeeded: true };
  }

  const translationMode = getConfiguredTranslationMode();
  const hasDeepLKey = Boolean(getPhiServerConfigSync().deepl?.apiKey?.trim());

  if (translationMode !== "custom" && (translationMode !== "deepl" || !hasDeepLKey)) {
    return { translations: normalizedTexts, succeeded: false };
  }

  const provider = translationMode === "custom" ? "custom" : "deepl";
  const providerContext = getProviderTranslationContext(input.ctx);
  const cacheKey = buildExternalTranslationCacheKey({
    provider,
    locale: input.locale,
    sourceLocale: input.sourceLocale,
    ctx: providerContext,
    format: input.format,
    msgs: normalizedTexts,
  });

  try {
    const translations = provider === "custom"
      ? await requestCustomTranslations({
          locale: input.locale,
          msgs: normalizedTexts,
          ctx: providerContext,
          sourceLocale: input.sourceLocale,
          format: input.format,
        })
      : await requestDeepL(
          normalizedTexts,
          input.locale,
          providerContext,
          input.sourceLocale,
          input.format,
          cacheKey,
        );
    return { translations, succeeded: true };
  } catch (error) {
    logExternalTranslationFallback({
      provider,
      locale: input.locale,
      sourceLocale: input.sourceLocale,
      ctx: providerContext,
      format: input.format,
      msgCount: normalizedTexts.length,
      error,
    });
    return { translations: normalizedTexts, succeeded: false };
  }
}

async function requestCustomTranslations(input: {
  locale: string;
  msgs: string[];
  ctx?: string;
  sourceLocale?: string;
  format?: TranslationFormat;
}) {
  const endpoint = getPhiServerConfigSync().translation?.customEndpoint?.trim();
  if (!endpoint) {
    throw new Error("Missing translation.customEndpoint in runtime config.");
  }

  const normalizedTexts = normalizeBatchMessages(input.msgs);
  if (normalizedTexts.length === 0) {
    return [];
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      locale: input.locale,
      msgs: normalizedTexts,
      ctx: input.ctx?.trim() || undefined,
      sourceLocale: input.sourceLocale?.trim() || undefined,
      ...(input.format && input.format !== "text" ? { format: input.format } : {}),
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Custom translation request failed: ${response.status} ${details}`);
  }

  const data = (await response.json()) as {
    translation?: string;
    translations?: string[];
  };

  if (normalizedTexts.length === 1 && typeof data.translation === "string") {
    return [data.translation];
  }

  if (Array.isArray(data.translations) && data.translations.length === normalizedTexts.length) {
    return data.translations.map((entry) => String(entry ?? ""));
  }

  throw new Error("Custom translation response did not include matching translations.");
}

async function requestDeepL(
  texts: string[],
  locale: string,
  context?: string,
  sourceLocale?: string,
  format: TranslationFormat = "text",
  cacheKeyPrefix = "deepl",
) {
  const apiKey = getPhiServerConfigSync().deepl?.apiKey?.trim();
  if (!apiKey) {
    throw new Error("Missing deepl.apiKey in config/phis-runtime.json.");
  }

  const normalizedTexts = normalizeBatchMessages(texts);
  if (normalizedTexts.length === 0) {
    return [];
  }

  const url = getPhiServerConfigSync().deepl?.apiUrl?.trim() ?? DEFAULT_DEEPL_URL;
  const createParams = (batch: readonly string[]) => {
    const params = new URLSearchParams({
      target_lang: resolveDeepLTargetLang(locale),
    });
    const normalizedSourceLocale = sourceLocale?.trim() ? resolveDeepLSourceLang(sourceLocale) : "";
    if (normalizedSourceLocale && normalizedSourceLocale !== resolveDeepLSourceLang(locale)) {
      params.set("source_lang", normalizedSourceLocale);
    }
    for (const text of batch) {
      params.append("text", text);
    }
    if (context?.trim()) {
      params.set("context", context.trim());
    }
    if (format === "html") {
      params.set("tag_handling", "html");
      params.set("tag_handling_version", "v2");
    }
    return params;
  };

  const batches: string[][] = [];
  let currentBatch: string[] = [];
  for (const text of normalizedTexts) {
    const candidate = [...currentBatch, text];
    const candidateBytes = Buffer.byteLength(createParams(candidate).toString(), "utf8");
    if (candidate.length > DEEPL_MAX_TEXTS_PER_REQUEST || candidateBytes > DEEPL_MAX_REQUEST_BYTES) {
      if (currentBatch.length === 0) {
        throw new Error("One DeepL translation unit exceeds the 128 KiB request limit.");
      }
      batches.push(currentBatch);
      currentBatch = [text];
      if (Buffer.byteLength(createParams(currentBatch).toString(), "utf8") > DEEPL_MAX_REQUEST_BYTES) {
        throw new Error("One DeepL translation unit exceeds the 128 KiB request limit.");
      }
    } else {
      currentBatch = candidate;
    }
  }
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  // Batches are fired concurrently and bounded by the global DeepL slot semaphore, so
  // DEEPL_MAX_CONCURRENT_REQUESTS is the single knob for provider concurrency. At the current limit
  // of 1 this behaves exactly like the previous sequential loop.
  const translatedBatches = await Promise.all(batches.map((batch, batchIndex) => {
    const params = createParams(batch);
    return runDeepLRequest(`${cacheKeyPrefix}:${batchIndex}`, async () => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `DeepL-Auth-Key ${apiKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
        cache: "no-store",
      });

      if (!response.ok) {
        const details = await response.text();
        if (response.status === 429 || response.status === 500 || response.status === 503) {
          openDeepLCircuitBreaker();
        }
        throw new Error(`DeepL request failed: ${response.status} ${details}`);
      }

      const data = (await response.json()) as {
        translations?: Array<{ text?: string }>;
      };
      const values = data.translations?.map((item) => item.text ?? "") ?? [];
      if (values.length !== batch.length) {
        throw new Error("DeepL response missing translation text.");
      }
      return values;
    });
  }));

  return translatedBatches.flat();
}

function sameLocale(left: string, right: string) {
  return normalizeLocaleKey(left) === normalizeLocaleKey(right);
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
    allowWrite: input.allowWrite,
    format: input.format,
  });
  return translation;
}

async function translateCanonicalGlobalBatch(input: Required<Pick<BatchTranslationInput, "locale" | "msgs">> & {
  ctx: string;
  allowWrite: boolean;
  format: TranslationFormat;
}) {
  const cacheContext = buildTranslationCacheContext({ ctx: input.ctx, format: input.format });
  const uniqueMsgs = Array.from(new Set(input.msgs));
  const result = new Map<string, string>();
  const entries = uniqueMsgs.map((msg) => ({ msg, hash: computeTranslationHash(msg) }));
  const cached = await getTranslations(input.locale, entries, cacheContext);
  const pending = entries.filter((entry) => {
    const value = cached.get(entry.hash);
    if (value != null) {
      result.set(entry.msg, value);
      return false;
    }
    return true;
  });

  if (input.allowWrite && pending.length > 0) {
    const fresh = await requestConfiguredTranslationsOrFallback({
      locale: input.locale,
      msgs: pending.map((entry) => entry.msg),
      ctx: input.ctx,
      sourceLocale: DEFAULT_LOCALE,
      format: input.format,
    });
    await Promise.all(pending.map(async (entry, index) => {
      const value = fresh.translations[index] ?? entry.msg;
      if (fresh.succeeded && value !== entry.msg) {
        // The translation itself is in hand; failing to cache it is not a reason to withhold it.
        await withMessageIsolation(
          () => upsertTranslation(input.locale, entry.msg, cacheContext, value, entry.hash),
          { stage: "upsertTranslation", locale: input.locale, ctx: cacheContext, msg: entry.msg },
        );
      }
      result.set(entry.msg, value);
    }));
  } else {
    pending.forEach((entry) => result.set(entry.msg, entry.msg));
  }
  return input.msgs.map((msg) => result.get(msg) ?? msg);
}

async function translateExternalGlobalBatch(input: Required<Pick<BatchTranslationInput, "locale" | "msgs">> & {
  sourceLocale: string;
  ctx: string;
  allowWrite: boolean;
  format: TranslationFormat;
}) {
  if (
    sameLocale(input.locale, input.sourceLocale) ||
    !input.allowWrite ||
    !isConfiguredSourceLocaleSupported(input.sourceLocale)
  ) {
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

  for (const source of uniqueSources) {
    const sourceHash = computeExternalSourceHash(source);
    const existing = await findGlobalExternalTranslationUnit({
      locale: input.sourceLocale,
      source,
      ctx: cacheContext,
      sourceHash,
    });
    if (existing) {
      units.set(source, existing);
    } else {
      pending.push({ source, sourceHash });
    }
  }

  if (pending.length > 0) {
    const canonical = await requestConfiguredTranslationsOrFallback({
      locale: DEFAULT_LOCALE,
      msgs: pending.map((entry) => entry.source),
      ctx: input.ctx,
      sourceLocale: input.sourceLocale,
      format: input.format,
    });
    if (canonical.succeeded) {
      await Promise.all(pending.map(async (entry, index) => {
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

  if (sameLocale(input.locale, DEFAULT_LOCALE)) {
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
      sourceLocale: DEFAULT_LOCALE,
      format: input.format,
    });
    await Promise.all(targetPending.map(async (entry, index) => {
      const value = fresh.translations[index] ?? entry.source;
      if (fresh.succeeded) {
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
  allowWrite,
  format,
}: BatchTranslationInput) {
  const normalizedLocale = locale.trim();
  const normalizedSourceLocale = sourceLocale?.trim() || DEFAULT_LOCALE;
  const normalizedMsgs = normalizeBatchMessages(msgs);
  const rawCtx = ctx?.trim() ?? "";
  const translationFormat = normalizeTranslationFormat(format);
  if (!normalizedLocale) {
    throw new Error("locale is required.");
  }
  if (normalizedMsgs.length === 0 || sameLocale(normalizedLocale, normalizedSourceLocale)) {
    return normalizedMsgs;
  }
  if (!sameLocale(normalizedSourceLocale, DEFAULT_LOCALE)) {
    return translateExternalGlobalBatch({
      locale: normalizedLocale,
      sourceLocale: normalizedSourceLocale,
      msgs: normalizedMsgs,
      ctx: rawCtx,
      allowWrite: allowWrite ?? true,
      format: translationFormat,
    });
  }
  return translateCanonicalGlobalBatch({
    locale: normalizedLocale,
    msgs: normalizedMsgs,
    ctx: rawCtx,
    allowWrite: allowWrite ?? true,
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

async function translateCanonicalSiteBatch(input: Required<Pick<SiteBatchTranslationInput, "siteId" | "locale" | "sourceLocale" | "msgs">> & {
  ctx: string;
  format: TranslationFormat;
}) {
  const cacheContext = buildTranslationCacheContext({ ctx: input.ctx, format: input.format });
  const uniqueMsgs = Array.from(new Set(input.msgs));
  const entries = (await Promise.all(uniqueMsgs.map(async (msg) => {
    const msgId = await withMessageIsolation(
      () => ensureSiteMessageId(input.siteId, msg, cacheContext),
      { stage: "ensureSiteMessageId", locale: input.locale, ctx: cacheContext, siteId: input.siteId, msg },
    );
    return msgId == null ? null : { msg, msgId };
  }))).filter((entry) => entry != null);
  const cached = await getSiteTranslations(entries.map((entry) => entry.msgId), input.locale);
  const result = new Map<string, string>();
  const pending = entries.filter((entry) => {
    const value = cached.get(entry.msgId);
    if (value != null) {
      result.set(entry.msg, value);
      return false;
    }
    return true;
  });
  if (pending.length > 0) {
    const fresh = await requestConfiguredTranslationsOrFallback({
      locale: input.locale,
      msgs: pending.map((entry) => entry.msg),
      ctx: input.ctx,
      sourceLocale: input.sourceLocale,
      format: input.format,
    });
    if (fresh.succeeded) {
      // Same rule as everywhere else here: the translations are in hand, and failing to cache them is
      // not a reason to hand back source text instead.
      await withMessageIsolation(
        () => upsertSiteTranslations(pending.map((entry, index) => ({
          msgId: entry.msgId,
          locale: input.locale,
          translation: fresh.translations[index] ?? entry.msg,
        }))),
        { stage: "upsertSiteTranslations", locale: input.locale, ctx: cacheContext, siteId: input.siteId, msg: pending[0]?.msg ?? "" },
      );
    }
    pending.forEach((entry, index) => {
      result.set(entry.msg, fresh.translations[index] ?? entry.msg);
    });
  }
  return input.msgs.map((msg) => result.get(msg) ?? msg);
}

async function translateExternalSiteBatch(input: Required<Pick<SiteBatchTranslationInput, "siteId" | "locale" | "sourceLocale" | "msgs">> & {
  canonicalLocale: string;
  ctx: string;
  format: TranslationFormat;
}) {
  if (
    sameLocale(input.locale, input.sourceLocale) ||
    !isConfiguredSourceLocaleSupported(input.sourceLocale)
  ) {
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
  for (const source of uniqueSources) {
    const sourceHash = computeExternalSourceHash(source);
    const existing = await findSiteExternalTranslationUnit({
      siteId: input.siteId,
      locale: input.sourceLocale,
      source,
      ctx: cacheContext,
      sourceHash,
    });
    if (existing) {
      units.set(source, existing);
    } else {
      pending.push({ source, sourceHash });
    }
  }
  if (pending.length > 0) {
    const canonical = await requestConfiguredTranslationsOrFallback({
      locale: input.canonicalLocale,
      msgs: pending.map((entry) => entry.source),
      ctx: input.ctx,
      sourceLocale: input.sourceLocale,
      format: input.format,
    });
    if (canonical.succeeded) {
      await Promise.all(pending.map(async (entry, index) => {
        const canonicalMsg = canonical.translations[index] ?? entry.source;
        const msgId = await withMessageIsolation(
          () => ensureSiteExternalTranslationUnit({
            siteId: input.siteId,
            sourceLocale: input.sourceLocale,
            source: entry.source,
            sourceHash: entry.sourceHash,
            canonicalMsg,
            ctx: cacheContext,
          }),
          { stage: "ensureSiteExternalTranslationUnit", locale: input.locale, ctx: cacheContext, siteId: input.siteId, msg: entry.source },
        );
        if (msgId != null) units.set(entry.source, { msgId, canonicalMsg });
      }));
    }
  }
  if (sameLocale(input.locale, input.canonicalLocale)) {
    return input.msgs.map((source) => units.get(source)?.canonicalMsg ?? source);
  }
  const resolved = new Map<string, string>();
  const unitEntries = Array.from(units.entries()).map(([source, unit]) => ({ source, ...unit }));
  const cached = await getSiteTranslations(unitEntries.map((entry) => entry.msgId), input.locale);
  const targetPending = unitEntries.filter((entry) => {
    const value = cached.get(entry.msgId);
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
      sourceLocale: input.canonicalLocale,
      format: input.format,
    });
    if (fresh.succeeded) {
      await upsertSiteTranslations(targetPending.map((entry, index) => ({
        msgId: entry.msgId,
        locale: input.locale,
        translation: fresh.translations[index] ?? entry.canonicalMsg,
      })));
    }
    targetPending.forEach((entry, index) => {
      resolved.set(entry.source, fresh.succeeded
        ? fresh.translations[index] ?? entry.canonicalMsg
        : entry.source);
    });
  }
  return input.msgs.map((source) => resolved.get(source) ?? source);
}

export async function translateSiteBatchWithCache({
  siteId,
  locale,
  sourceLocale,
  msgs,
  ctx,
  format,
}: SiteBatchTranslationInput) {
  const normalizedLocale = locale.trim();
  const canonicalLocale = sourceLocale.trim();
  const normalizedMsgs = normalizeBatchMessages(msgs);
  const rawCtx = ctx?.trim() ?? "";
  const translationFormat = normalizeTranslationFormat(format);
  if (!siteId || !normalizedLocale || !canonicalLocale) {
    throw new Error("siteId, locale, and sourceLocale are required.");
  }
  if (normalizedMsgs.length === 0 || sameLocale(normalizedLocale, canonicalLocale)) {
    return normalizedMsgs;
  }
  return translateCanonicalSiteBatch({
    siteId,
    locale: normalizedLocale,
    sourceLocale: canonicalLocale,
    msgs: normalizedMsgs,
    ctx: rawCtx,
    format: translationFormat,
  });
}

export async function translateExternalSiteBatchWithCache(input: SiteBatchTranslationInput & {
  canonicalLocale: string;
}) {
  const normalizedMsgs = normalizeBatchMessages(input.msgs);
  if (normalizedMsgs.length === 0) {
    return [];
  }
  return translateExternalSiteBatch({
    siteId: input.siteId,
    locale: input.locale.trim(),
    sourceLocale: input.sourceLocale.trim(),
    canonicalLocale: input.canonicalLocale.trim(),
    msgs: normalizedMsgs,
    ctx: input.ctx?.trim() ?? "",
    format: normalizeTranslationFormat(input.format),
  });
}

export async function detectTranslationSourceLocale(input: {
  text: string;
  targetLocale: string;
}) {
  const sample = input.text.trim().slice(0, 16_000);
  if (!sample || getConfiguredTranslationMode() !== "deepl") {
    return null;
  }
  const apiKey = getPhiServerConfigSync().deepl?.apiKey?.trim();
  if (!apiKey) {
    return null;
  }

  const params = new URLSearchParams({
    target_lang: resolveDeepLTargetLang(input.targetLocale),
    text: sample,
  });
  const url = getPhiServerConfigSync().deepl?.apiUrl?.trim() ?? DEFAULT_DEEPL_URL;
  const cacheKey = buildExternalTranslationCacheKey({
    provider: "deepl",
    locale: input.targetLocale,
    format: "text",
    msgs: [sample],
  });
  const [detected = ""] = await runDeepLRequest(`detect:${cacheKey}`, async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${apiKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
      cache: "no-store",
    });
    if (!response.ok) {
      const details = await response.text();
      throw new Error(`DeepL language detection failed: ${response.status} ${details}`);
    }
    const data = (await response.json()) as {
      translations?: Array<{ detected_source_language?: string }>;
    };
    return [data.translations?.[0]?.detected_source_language ?? ""];
  });
  return resolvePhiLocaleCapability(detected)?.locale ?? null;
}
