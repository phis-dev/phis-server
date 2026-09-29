import "server-only";

import { cookies, headers } from "next/headers";

import {
  PHI_CANONICAL_SOURCE_LOCALE,
  normalizeLocale,
} from "@/lib/locale";
import { LOCALE_COOKIE_NAME } from "@/lib/auth";
import { getPhisConfigSync } from "@/lib/config";
import { logRuntimeEvent } from "@/lib/log";
import { translateBatchWithCache } from "@/lib/translations";

type LabelSetDefinition = Record<string, string>;
type TranslatedLabelSet<T extends LabelSetDefinition> = { [K in keyof T]: string };

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
