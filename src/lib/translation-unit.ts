import "server-only";

import { getPhisConfigSync } from "@/lib/config";
import {
  resolveDeepLSourceLang,
  resolveDeepLTargetLang,
  resolvePhiLocaleCapability,
} from "@/lib/locale";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";

/**
 * Turning text into text in another language, and nothing else.
 *
 * This is the layer the translation store stands on: texts in, texts out, told which language they are
 * in and which one they are wanted in. It knows nothing about `tr_msg`, hashes, canonical units,
 * protected external variants or change markers, and nothing above it needs to know which provider
 * answered.
 *
 * It was inside `translations.ts`, where the store's four batch paths could see DeepL's request limit
 * and its circuit breaker. That is what made the limit structural: a concurrency of one and a 128 KiB
 * body are DeepL's facts, and every other way of translating text was going to inherit them. They live
 * here now, against the provider that has them.
 *
 * What does not live here: the stand-in accounting. This layer reports that it did not succeed, and the
 * store decides what that means for what it may keep -- which is the whole reason the answer is two
 * values and not a thrown error.
 */

const DEFAULT_DEEPL_URL = "https://api-free.deepl.com/v2/translate";

/*
 * DeepL's own limits, and the reason they are named here rather than where translations are stored.
 *
 * One request at a time is not a general truth about translating; it is what this account tolerates.
 * The byte and text ceilings are the documented request limit. A provider without an HTTP request has
 * none of the three.
 */
const DEEPL_MAX_CONCURRENT_REQUESTS = 1;
const DEEPL_CIRCUIT_BREAKER_MS = 30_000;
const DEEPL_MAX_REQUEST_BYTES = 128 * 1024;
const DEEPL_MAX_TEXTS_PER_REQUEST = 50;

export type PhisTranslationUnitFormat = "text" | "html";

export type PhisTranslationUnitRequest = {
  locale: string;
  msgs: string[];
  /** Natural-language context for the provider; the storage flag envelope never reaches here. */
  ctx?: string;
  sourceLocale: string;
  format: PhisTranslationUnitFormat;
};

/**
 * The answer, and whether it is one.
 *
 * `succeeded: false` with the source text returned unchanged is the last link of every chain: no
 * provider configured, no key, or the provider failed. The store must be able to tell that apart from
 * a translation, because an unchanged source text kept as a translation would outlive the outage.
 */
export type PhisTranslationUnitResult = {
  translations: string[];
  succeeded: boolean;
  /**
   * Why it is not a translation, when it is not one.
   *
   * `unconfigured` is an installation that does not translate; `failed` is one that does and could not
   * this time. The store treats them differently -- only the second is a stand-in, because only the
   * second will be right again later without anybody changing anything. That difference used to be
   * carried by which of two return paths a line of accounting sat on, which is a hard thing to see and
   * an easy one to move.
   */
  outcome: "translated" | "unconfigured" | "failed";
};

let activeDeepLRequests = 0;
let deepLCircuitOpenUntil = 0;
const deepLQueue: Array<() => void> = [];
const inFlightDeepLRequests = new Map<string, Promise<string[]>>();

export function normalizeBatchMessages(msgs: string[]) {
  return msgs.map((msg) => msg.trim()).filter(Boolean);
}

export function getConfiguredTranslationMode() {
  return getPhisConfigSync().translation?.mode ?? "none";
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

function buildProviderRequestKey(input: {
  provider: "custom" | "deepl";
  locale: string;
  sourceLocale?: string;
  ctx?: string;
  format: PhisTranslationUnitFormat;
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

function logProviderFallback(input: {
  provider: "custom" | "deepl";
  locale: string;
  sourceLocale?: string;
  ctx?: string;
  format: PhisTranslationUnitFormat;
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

async function requestCustomTranslations(input: {
  locale: string;
  msgs: string[];
  ctx?: string;
  sourceLocale?: string;
  format?: PhisTranslationUnitFormat;
}) {
  const endpoint = getPhisConfigSync().translation?.customEndpoint?.trim();
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
  format: PhisTranslationUnitFormat = "text",
  cacheKeyPrefix = "deepl",
) {
  const apiKey = getPhisConfigSync().deepl?.apiKey?.trim();
  if (!apiKey) {
    throw new Error("Missing deepl.apiKey in config/phis-runtime.json.");
  }

  const normalizedTexts = normalizeBatchMessages(texts);
  if (normalizedTexts.length === 0) {
    return [];
  }

  const url = getPhisConfigSync().deepl?.apiUrl?.trim() ?? DEFAULT_DEEPL_URL;
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

/**
 * Ask whoever this installation translates with, and say whether it worked.
 *
 * The one entry point above the providers. A failure is an answer here rather than an exception,
 * because the caller has something to do with it that the provider cannot know: hand back the source
 * text without storing it as a translation.
 */
export async function requestPhisTranslationUnit(
  input: PhisTranslationUnitRequest,
): Promise<PhisTranslationUnitResult> {
  const normalizedTexts = normalizeBatchMessages(input.msgs);
  if (normalizedTexts.length === 0) {
    return { translations: [], succeeded: true, outcome: "translated" };
  }

  const translationMode = getConfiguredTranslationMode();
  const hasDeepLKey = Boolean(getPhisConfigSync().deepl?.apiKey?.trim());

  if (translationMode !== "custom" && (translationMode !== "deepl" || !hasDeepLKey)) {
    return { translations: normalizedTexts, succeeded: false, outcome: "unconfigured" };
  }

  const provider = translationMode === "custom" ? "custom" : "deepl";
  const requestKey = buildProviderRequestKey({
    provider,
    locale: input.locale,
    sourceLocale: input.sourceLocale,
    ctx: input.ctx,
    format: input.format,
    msgs: normalizedTexts,
  });

  try {
    const translations = provider === "custom"
      ? await requestCustomTranslations({
          locale: input.locale,
          msgs: normalizedTexts,
          ctx: input.ctx,
          sourceLocale: input.sourceLocale,
          format: input.format,
        })
      : await requestDeepL(
          normalizedTexts,
          input.locale,
          input.ctx,
          input.sourceLocale,
          input.format,
          requestKey,
        );
    return { translations, succeeded: true, outcome: "translated" };
  } catch (error) {
    logProviderFallback({
      provider,
      locale: input.locale,
      sourceLocale: input.sourceLocale,
      ctx: input.ctx,
      format: input.format,
      msgCount: normalizedTexts.length,
      error,
    });
    return { translations: normalizedTexts, succeeded: false, outcome: "failed" };
  }
}

/**
 * Which language a sample is in, when only the provider can say.
 *
 * DeepL's own answer, taken from a translation it was going to perform anyway, which is why this is
 * here and not in the store: it is a provider call with the provider's queue, its circuit breaker and
 * its key. `null` for every other mode, and for a provider that cannot detect -- not knowing is an
 * answer the caller already has to handle.
 */
export async function detectTranslationSourceLocale(input: {
  text: string;
  targetLocale: string;
}) {
  const sample = input.text.trim().slice(0, 16_000);
  if (!sample || getConfiguredTranslationMode() !== "deepl") {
    return null;
  }
  const apiKey = getPhisConfigSync().deepl?.apiKey?.trim();
  if (!apiKey) {
    return null;
  }

  const params = new URLSearchParams({
    target_lang: resolveDeepLTargetLang(input.targetLocale),
    text: sample,
  });
  const url = getPhisConfigSync().deepl?.apiUrl?.trim() ?? DEFAULT_DEEPL_URL;
  const cacheKey = buildProviderRequestKey({
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
