import "server-only";

import { cookies, headers } from "next/headers";

import {
  PHI_CANONICAL_SOURCE_LOCALE,
  SUPPORTED_LOCALES,
  normalizeLocale,
} from "@/lib/locale";
import { LOCALE_COOKIE_NAME } from "@/lib/auth";
import { getPhisConfigSync } from "@/lib/config";
import { logRuntimeEvent } from "@/lib/log";
import { resolveSiteFromHeaders } from "@/lib/site-context";
import { translateBatchWithCache, translateSiteWithCache, translateWithCache } from "@/lib/translations";

type TranslationParams =
  | Record<string, string | number>
  | Array<string | number>
  | string
  | number
  | 0;

type LabelSetDefinition = Record<string, string>;
type TranslatedLabelSet<T extends LabelSetDefinition> = { [K in keyof T]: string };

const GLOBAL_TRANSLATION_TIMEOUT_MS = 600;
const GLOBAL_TRANSLATION_BATCH_TIMEOUT_MS = 1500;

async function resolveLocale() {
  const requestHeaders = await headers();
  const explicit = requestHeaders.get("x-locale");
  if (explicit) {
    return normalizeLocale(explicit);
  }

  const cookieStore = await cookies();
  const operatorLocale = cookieStore.get(LOCALE_COOKIE_NAME)?.value?.trim();
  if (operatorLocale) {
    return normalizeLocale(operatorLocale);
  }

  return normalizeLocale(requestHeaders.get("accept-language"));
}

function shouldSkipGlobalTranslation(locale: string) {
  const translationMode = getPhisConfigSync().translation?.mode ?? "none";
  return translationMode === "none" || locale === PHI_CANONICAL_SOURCE_LOCALE;
}

async function withTranslationTimeout<T>(promise: Promise<T>, ms: number) {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error("Global translation timeout.")), ms);
    }),
  ]);
}

function applyParams(msg: string, params: TranslationParams) {
  if (!params) {
    return msg;
  }

  const text = String(msg);

  if (Array.isArray(params)) {
    return params.reduce<string>((current, value, index) => {
      const tokenIndex = index + 1;
      return current
        .replaceAll(`{${index}}`, String(value))
        .replaceAll(`%${tokenIndex}`, String(value));
    }, text);
  }

  if (typeof params === "object") {
    return Object.entries(params).reduce(
      (current, [key, value]) => current.replaceAll(`{${key}}`, String(value)),
      text,
    );
  }

  return text.replaceAll("{0}", String(params)).replaceAll("%1", String(params));
}

async function translateSiteAwareCached(locale: string, msg: string, ctx: string) {
  if (!msg.trim()) {
    return msg;
  }

  try {
    const requestHeaders = await headers();
    const site = await resolveSiteFromHeaders(requestHeaders);

    if (site) {
      if (locale === normalizeLocale(site.sourceLocale)) {
        return msg;
      }

      return await translateSiteWithCache({
        siteId: site.id,
        locale,
        sourceLocale: site.sourceLocale,
        msg,
        ctx,
      });
    }

    if (shouldSkipGlobalTranslation(locale)) {
      return msg;
    }

    return await withTranslationTimeout(
      translateWithCache({ locale, msg, ctx }),
      GLOBAL_TRANSLATION_TIMEOUT_MS,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logRuntimeEvent("warn", "translation.fallback", {
      message: "Landing translation fallback.",
      meta: {
        locale,
        ctx,
        msg: msg.slice(0, 120),
        error: message,
      },
    });
    return msg;
  }
}

async function translateGlobalBatchCached(locale: string, msgs: string[], ctx: string) {
  const normalizedMsgs = msgs.map((msg) => msg.trim());
  if (normalizedMsgs.length === 0 || shouldSkipGlobalTranslation(locale)) {
    return normalizedMsgs;
  }

  try {
    return await withTranslationTimeout(
      translateBatchWithCache({
        locale,
        msgs: normalizedMsgs,
        ctx,
        write: "extend",
      }),
      GLOBAL_TRANSLATION_BATCH_TIMEOUT_MS,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logRuntimeEvent("warn", "translation.batch_fallback", {
      message: "Global translation batch fallback.",
      meta: {
        locale,
        ctx,
        msgCount: normalizedMsgs.length,
        error: message,
      },
    });
    return normalizedMsgs;
  }
}

export async function tr(msg: string, params: TranslationParams = 0, ctx: string | number = 0) {
  const locale = await resolveLocale();
  const normalizedMsg = msg.trim();
  const context = ctx ? String(ctx) : "";
  const translated = await translateSiteAwareCached(locale, normalizedMsg, context);
  return applyParams(translated, params);
}

export const supportedLocales = SUPPORTED_LOCALES;

export async function trGlobalLabelSet<T extends LabelSetDefinition>(
  labels: T,
  ctx: string | number = 0,
): Promise<TranslatedLabelSet<T>> {
  const locale = await resolveLocale();
  return trGlobalLabelSetForLocale(locale, labels, ctx);
}

export async function trGlobalLabelSetForLocale<T extends LabelSetDefinition>(
  localeInput: string,
  labels: T,
  ctx: string | number = 0,
): Promise<TranslatedLabelSet<T>> {
  const locale = normalizeLocale(localeInput);
  const context = ctx ? String(ctx) : "";
  const entries = Object.entries(labels) as Array<[keyof T, string]>;
  const translated = await translateGlobalBatchCached(
    locale,
    entries.map(([, msg]) => msg),
    context,
  );
  const result = {} as TranslatedLabelSet<T>;

  entries.forEach(([key], index) => {
    result[key] = translated[index] ?? labels[key];
  });

  return result;
}
