import {
  getBootstrapLocale,
  getBootstrapMessages,
} from "@/bootstrap/i18n";
import { bootstrapStepOrder, getBootstrapStep } from "@/bootstrap/setup-flow";
import {
  SetupChecklist,
  SetupGoodToKnow,
  SetupShell,
} from "@/components/bootstrap/setup-shell";
import { OperatorSetupPanel } from "@/components/bootstrap/operator-setup-panel";
import { RuntimeCheckRunner } from "@/components/bootstrap/runtime-check-runner";
import { DatabaseSetupPanel } from "@/components/bootstrap/database-setup-panel";
import { SchemaSetupPanel } from "@/components/bootstrap/schema-setup-panel";
import { SiteSetupPanel } from "@/components/bootstrap/site-setup-panel";
import { FinishSetupPanel } from "@/components/bootstrap/finish-setup-panel";
import { TranslationSetupPanel } from "@/components/bootstrap/translation-setup-panel";
import { readMergedPhiConfigSync } from "@/lib/config-files";

export default async function SetupPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const langParam = Array.isArray(resolvedSearchParams.lang)
    ? resolvedSearchParams.lang[0]
    : resolvedSearchParams.lang;
  const stepParam = Array.isArray(resolvedSearchParams.step)
    ? resolvedSearchParams.step[0]
    : resolvedSearchParams.step;
  const savedParam = Array.isArray(resolvedSearchParams.saved)
    ? resolvedSearchParams.saved[0]
    : resolvedSearchParams.saved;
  const dbErrorParam = Array.isArray(resolvedSearchParams.dbError)
    ? resolvedSearchParams.dbError[0]
    : resolvedSearchParams.dbError;
  const translationErrorParam = Array.isArray(resolvedSearchParams.translationError)
    ? resolvedSearchParams.translationError[0]
    : resolvedSearchParams.translationError;
  const schemaErrorParam = Array.isArray(resolvedSearchParams.schemaError)
    ? resolvedSearchParams.schemaError[0]
    : resolvedSearchParams.schemaError;
  const siteErrorParam = Array.isArray(resolvedSearchParams.siteError)
    ? resolvedSearchParams.siteError[0]
    : resolvedSearchParams.siteError;
  const finishErrorParam = Array.isArray(resolvedSearchParams.finishError)
    ? resolvedSearchParams.finishError[0]
    : resolvedSearchParams.finishError;

  const locale = getBootstrapLocale(langParam);
  const step = getBootstrapStep(stepParam);
  const messages = getBootstrapMessages(locale);
  const currentIndex = bootstrapStepOrder.indexOf(step);
  const nextStep =
    bootstrapStepOrder[Math.min(currentIndex + 1, bootstrapStepOrder.length - 1)];
  const mergedConfig = readMergedPhiConfigSync();
  const initialDeeplKey = mergedConfig.deepl?.apiKey?.trim() ?? "";
  const initialDeeplEndpoint =
    mergedConfig.deepl?.apiUrl?.trim() || "https://api-free.deepl.com/v2/translate";
  const initialTranslationMode =
    mergedConfig.translation?.mode === "deepl" ||
    mergedConfig.translation?.mode === "cdn+deepl" ||
    mergedConfig.translation?.mode === "add-on" ||
    mergedConfig.translation?.mode === "none"
      ? mergedConfig.translation.mode
      : initialDeeplKey || mergedConfig.deepl?.apiUrl?.trim()
        ? "deepl"
        : null;

  return (
    <SetupShell locale={locale} currentStep={step}>
      {step === "runtime" ? (
        <div className="ui_section_stack">
          <RuntimeCheckRunner
            messages={messages}
            nextStepHref={`/setup?lang=${locale}&step=${nextStep}`}
          />
          <SetupGoodToKnow messages={messages} step={step} />
        </div>
      ) : step === "operator" ? (
        <OperatorSetupPanel
          locale={locale}
          messages={messages}
          nextStepHref={`/setup?lang=${locale}&step=${nextStep}`}
          saved={savedParam === "1"}
        />
      ) : step === "translations" ? (
        <TranslationSetupPanel
          locale={locale}
          messages={messages}
          nextStepHref={`/setup?lang=${locale}&step=${nextStep}`}
          initialMode={initialTranslationMode}
          initialDeeplKey={initialDeeplKey}
          initialDeeplEndpoint={initialDeeplEndpoint}
          error={translationErrorParam ?? null}
        />
      ) : step === "database" ? (
        <DatabaseSetupPanel
          locale={locale}
          messages={messages}
          nextStepHref={`/setup?lang=${locale}&step=${nextStep}`}
          error={dbErrorParam ?? null}
        />
      ) : step === "schema" ? (
        <SchemaSetupPanel
          locale={locale}
          messages={messages}
          nextStepHref={`/setup?lang=${locale}&step=${nextStep}`}
          error={schemaErrorParam ?? null}
        />
      ) : step === "site" ? (
        <SiteSetupPanel
          locale={locale}
          messages={messages}
          nextStepHref={`/setup?lang=${locale}&step=${nextStep}`}
          error={siteErrorParam ?? null}
        />
      ) : step === "finish" ? (
        <FinishSetupPanel
          locale={locale}
          messages={messages}
          error={finishErrorParam ?? null}
        />
      ) : (
        <SetupChecklist messages={messages} step={step} />
      )}
    </SetupShell>
  );
}
