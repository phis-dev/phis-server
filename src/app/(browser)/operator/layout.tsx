import type { ReactNode } from "react";

import { cookies, headers } from "next/headers";

import { OPERATOR_LAYOUT_LABELS } from "@/components/operator/label-sets";
import { OperatorShellFrame } from "@/components/operator/operator-shell-frame";
import { requirePhisBrowserSurface } from "@/lib/browser-surfaces";
import { getPhisConfigSync } from "@/lib/config";
import { normalizeLocale } from "@/lib/locale";
import { getOperatorSession } from "@/lib/operator-auth";
import { resolveOperationalMode } from "@/lib/operator-runtime";
import { trGlobalLabelSet } from "@/lib/landing-tr";
import { getConfiguredTranslationSupportedLocalesSync } from "@/lib/translation-locale-options";

const WEB_UI_LABEL_CONTEXT = "Web UI label";

function buildLocaleOptions(allowedLocales: string[]) {
  return allowedLocales.map((code) => {
    try {
      const label = new Intl.DisplayNames([code], { type: "language" }).of(code);
      return {
        value: code,
        label: label ?? code.toUpperCase(),
      };
    } catch {
      return {
        value: code,
        label: code.toUpperCase(),
      };
    }
  });
}

export default async function OperatorLayout({ children }: { children: ReactNode }) {
  requirePhisBrowserSurface("operator");

  const session = await getOperatorSession();
  const cookieStore = await cookies();
  const requestHeaders = await headers();
  const translationMode = getPhisConfigSync().translation?.mode ?? "none";
  const allowedLocales =
    translationMode === "none" ? ["en"] : getConfiguredTranslationSupportedLocalesSync();
  const currentLocale = normalizeLocale(
    cookieStore.get("phis_locale")?.value?.trim() ??
      requestHeaders.get("accept-language"),
  );
  const localeOptions = buildLocaleOptions(allowedLocales);

  const labels = await trGlobalLabelSet(OPERATOR_LAYOUT_LABELS, WEB_UI_LABEL_CONTEXT);

  return (
    <OperatorShellFrame
      operatorName={session?.displayName?.trim() || session?.email?.trim() || "Operator"}
      operationalMode={resolveOperationalMode()}
      logoutLabel={labels.logout}
      currentLocale={allowedLocales.includes(currentLocale) ? currentLocale : "en"}
      localeOptions={localeOptions}
      navLabels={{
        overview: labels.overview,
        sites: labels.sites,
        translations: labels.translations,
        operators: labels.operators,
        infrastructure: labels.infrastructure,
      }}
    >
      {children}
    </OperatorShellFrame>
  );
}
