import { NextResponse } from "next/server";
import { getApiV1TokenMode, guardApiV1 } from "@/lib/api-v1-guard";
import { getPhisConfig } from "@/lib/config";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
import { PHI_CANONICAL_SOURCE_LOCALE } from "@/lib/locale";
import { resolveSiteFromHeaders } from "@/lib/site-context";
import { getConfiguredTranslationSupportedLocalesSync } from "@/lib/translation-locale-options";
import { parseTranslationContext } from "@/lib/translation-context";
import {
  buildPhisTranslationAppContext,
  readPhisTranslationAppName,
} from "@/lib/translation-app-context";
import { resolvePhisTranslationWriteMode } from "@/lib/translation-write-mode";
import { PHIS_APP_HEADER, PHIS_SITE_KEY_HEADER } from "@/lib/constants/http-headers";
import {
  trackTranslationStandIns,
  translateBatchWithCache,
  translateExternalSiteBatchWithCache,
  translateSiteBatchWithCache,
  translateSiteWithCache,
  translateWithCache,
} from "@/lib/translations";

function normalizeLocale(value: string) {
  return value.toLowerCase().split(/[-_]/)[0] ?? "";
}

type TranslationPayload = {
  locale?: string;
  msg?: string;
  msgs?: string[];
  ctx?: string | null;
  hash?: string | null;
  sourceLocale?: string | null;
  format?: "text" | "html" | null;
};

function validatePayload(payload: TranslationPayload) {
  const locale = payload?.locale;
  const msg = payload?.msg;
  const ctx = payload?.ctx ?? "";
  const hash = payload?.hash;
  const sourceLocale = payload?.sourceLocale ?? null;
  const format = payload?.format ?? "text";

  if (
    typeof locale !== "string" ||
    typeof msg !== "string" ||
    typeof ctx !== "string" ||
    (format !== "text" && format !== "html") ||
    (hash !== undefined && hash !== null && typeof hash !== "string") ||
    (sourceLocale !== undefined && sourceLocale !== null && typeof sourceLocale !== "string")
  ) {
    logRuntimeEvent("warn", "translation.invalid_payload", {
      area: "tr",
      message: "Invalid translation payload types.",
      meta: {
        localeType: typeof locale,
        msgType: typeof msg,
        hashType: typeof hash,
      },
    });
    return NextResponse.json(
      { error: "locale, msg, and ctx must be strings. format must be text or html. hash is optional and must be a string." },
      { status: 400 },
    );
  }

  try {
    parseTranslationContext(ctx);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid translation context." },
      { status: 400 },
    );
  }

  return { locale, msg, ctx, hash, sourceLocale, format };
}

function validateBatchPayload(payload: TranslationPayload) {
  const locale = payload?.locale;
  const msgs = payload?.msgs;
  const ctx = payload?.ctx ?? "";
  const sourceLocale = payload?.sourceLocale ?? null;
  const format = payload?.format ?? "text";

  if (
    typeof locale !== "string" ||
    !Array.isArray(msgs) ||
    msgs.some((msg) => typeof msg !== "string") ||
    typeof ctx !== "string" ||
    (format !== "text" && format !== "html") ||
    (sourceLocale !== undefined && sourceLocale !== null && typeof sourceLocale !== "string")
  ) {
    return NextResponse.json(
      { error: "locale must be a string, msgs must be a string array, and format must be text or html." },
      { status: 400 },
    );
  }

  try {
    parseTranslationContext(ctx);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid translation context." },
      { status: 400 },
    );
  }

  return { locale, msgs, ctx, sourceLocale, format };
}

/**
 * The key space this request writes and reads in, which the server builds rather than the caller.
 *
 * An application outside the platform names itself in `PHIS_APP_HEADER`, and its name goes in front of
 * the context it sent, so its messages cannot share a key with a Label Set of ours (TRANSLATIONS.md,
 * "Somebody else's strings in the global store"). The same header on a read is what finds them again:
 * identity is `(msg_hash, ctx)`, so prefixing writes alone would store under one key and look under
 * another -- nothing found, nothing wrong, and the rows correct in the table all along.
 *
 * A name that cannot be part of a key is refused rather than repaired. Truncating an overlong one would
 * merge two spaces into one silently, which is the collision the namespace exists to prevent.
 */
function resolveTranslationNamespace(request: Request, ctx: string) {
  const named = readPhisTranslationAppName(request.headers.get(PHIS_APP_HEADER));
  if (named.kind === "invalid") {
    return { error: NextResponse.json({ error: named.reason }, { status: 400 }) };
  }
  if (named.kind === "absent") {
    return { named: false, ctx };
  }

  /*
   * An application's space is the global store's. A request that names a Site is asking for that Site's
   * own catalogue, and partitioning that by an application would divide text belonging to somebody who
   * never asked for it.
   */
  if (request.headers.get(PHIS_SITE_KEY_HEADER)?.trim()) {
    return {
      error: NextResponse.json(
        {
          error:
            "An application namespace belongs to the global store, and this request names a Site.",
        },
        { status: 400 },
      ),
    };
  }

  const built = buildPhisTranslationAppContext(named.app, ctx);
  if (built.kind === "invalid") {
    return { error: NextResponse.json({ error: built.reason }, { status: 400 }) };
  }
  return { named: true, ctx: built.context };
}

async function handleTranslation(request: Request, payload: TranslationPayload) {
  const guardError = guardApiV1(request);
  if (guardError) {
    return guardError;
  }

  const tokenMode = getApiV1TokenMode(request);
  const explicitSiteKey = request.headers.get(PHIS_SITE_KEY_HEADER)?.trim() ?? "";
  if (tokenMode === "public" && explicitSiteKey) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const validated = validatePayload(payload);
  if (validated instanceof NextResponse) {
    return validated;
  }

  const { locale, msg, hash, sourceLocale, format } = validated;
  const namespace = resolveTranslationNamespace(request, validated.ctx);
  if (namespace.error) {
    return namespace.error;
  }
  const ctx = namespace.ctx ?? validated.ctx;
  const normalizedLocale = normalizeLocale(locale);
  const config = await getPhisConfig();
  const allowedLocales = new Set(getConfiguredTranslationSupportedLocalesSync());
  const allowPublicReads = config.translation?.allowPublicReads === true;
  if (tokenMode === "public" && !allowPublicReads) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  const write = resolvePhisTranslationWriteMode({ tokenMode, named: namespace.named === true });
  if (!allowedLocales.has(normalizedLocale)) {
    logRuntimeEvent("warn", "translation.locale_not_allowed", {
      area: "tr",
      message: "Translation locale is not allowed.",
      meta: {
        locale: normalizedLocale,
        tokenMode,
      },
    });
    return NextResponse.json({ translation: msg });
  }

  try {
    const site =
      tokenMode === "internal" && explicitSiteKey
        ? await resolveSiteFromHeaders(request.headers)
        : null;
    const effectiveSourceLocale = sourceLocale?.trim() || site?.sourceLocale || PHI_CANONICAL_SOURCE_LOCALE;
    const { value: translation, standIn } = await trackTranslationStandIns(async () => site
      ? normalizeLocale(effectiveSourceLocale) === normalizeLocale(site.sourceLocale)
        ? await translateSiteWithCache({
          siteId: site.id,
          locale,
          sourceLocale: site.sourceLocale,
          msg,
          ctx,
          format,
        })
        : (await translateExternalSiteBatchWithCache({
            siteId: site.id,
            locale,
            sourceLocale: effectiveSourceLocale,
            canonicalLocale: site.sourceLocale,
            msgs: [msg],
            ctx,
            format,
          }))[0] ?? msg
      : await translateWithCache({
          locale,
          sourceLocale: effectiveSourceLocale,
          msg,
          ctx,
          hash,
          write,
          format,
        }));

    // `provisional`: at least one answer is source text standing in for a failure; do not keep it.
    return NextResponse.json({ translation, ...(standIn ? { provisional: true } : {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Translation failed.";
    logRuntimeEvent("error", "translation.failed", {
      area: "tr",
      message: "Translation request failed.",
      siteKey: explicitSiteKey || null,
      error: normalizeLogThrowable(error),
      meta: {
        locale: normalizedLocale,
        ctx,
        hash: hash ?? null,
        format,
        tokenMode,
      },
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function handleBatchTranslation(request: Request, payload: TranslationPayload) {
  const guardError = guardApiV1(request);
  if (guardError) {
    return guardError;
  }

  const tokenMode = getApiV1TokenMode(request);
  const explicitSiteKey = request.headers.get(PHIS_SITE_KEY_HEADER)?.trim() ?? "";
  if (tokenMode === "public" && explicitSiteKey) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const validated = validateBatchPayload(payload);
  if (validated instanceof NextResponse) {
    return validated;
  }

  const { locale, msgs, sourceLocale, format } = validated;
  const namespace = resolveTranslationNamespace(request, validated.ctx);
  if (namespace.error) {
    return namespace.error;
  }
  const ctx = namespace.ctx ?? validated.ctx;
  const normalizedLocale = normalizeLocale(locale);
  const config = await getPhisConfig();
  const allowedLocales = new Set(getConfiguredTranslationSupportedLocalesSync());
  const allowPublicReads = config.translation?.allowPublicReads === true;
  if (tokenMode === "public" && !allowPublicReads) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  const write = resolvePhisTranslationWriteMode({ tokenMode, named: namespace.named === true });
  if (!allowedLocales.has(normalizedLocale)) {
    logRuntimeEvent("warn", "translation.locale_not_allowed", {
      area: "tr",
      message: "Translation locale is not allowed.",
      meta: {
        locale: normalizedLocale,
        tokenMode,
      },
    });
    return NextResponse.json(
      { translations: msgs.map((msg) => (typeof msg === "string" ? msg : "")) },
    );
  }

  try {
    const site =
      tokenMode === "internal" && explicitSiteKey
        ? await resolveSiteFromHeaders(request.headers)
        : null;
    const effectiveSourceLocale = sourceLocale?.trim() || site?.sourceLocale || PHI_CANONICAL_SOURCE_LOCALE;
    const { value: translations, standIn } = await trackTranslationStandIns(async () => site
      ? normalizeLocale(effectiveSourceLocale) === normalizeLocale(site.sourceLocale)
        ? await translateSiteBatchWithCache({
          siteId: site.id,
          locale,
          sourceLocale: site.sourceLocale,
          msgs,
          ctx,
          format,
        })
        : await translateExternalSiteBatchWithCache({
            siteId: site.id,
            locale,
            sourceLocale: effectiveSourceLocale,
            canonicalLocale: site.sourceLocale,
            msgs,
            ctx,
            format,
          })
      : await translateBatchWithCache({
          locale,
          sourceLocale: effectiveSourceLocale,
          msgs,
          ctx,
          write,
          format,
        }));

    return NextResponse.json({ translations, ...(standIn ? { provisional: true } : {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Translation failed.";
    logRuntimeEvent("error", "translation.batch_failed", {
      area: "tr",
      message: "Translation batch request failed.",
      siteKey: explicitSiteKey || null,
      error: normalizeLogThrowable(error),
      meta: {
        locale: normalizedLocale,
        ctx,
        msgCount: msgs.length,
        format,
        tokenMode,
      },
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  return handleTranslation(request, {
    locale: url.searchParams.get("locale") ?? undefined,
    sourceLocale: url.searchParams.get("sourceLocale"),
    msg: url.searchParams.get("msg") ?? undefined,
    ctx: url.searchParams.get("ctx"),
    hash: url.searchParams.get("hash"),
    format:
      url.searchParams.get("format") === "html"
        ? "html"
        : url.searchParams.get("format") === "text"
          ? "text"
          : undefined,
  });
}

export async function POST(request: Request) {
  let payload: TranslationPayload;
  try {
    payload = (await request.json()) as TranslationPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (Array.isArray(payload.msgs)) {
    return handleBatchTranslation(request, payload);
  }

  return handleTranslation(request, payload);
}
