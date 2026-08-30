import type { RuntimeCheckKey } from "../runtime-checks";
import { bootstrapDe } from "./de";
import { bootstrapEn } from "./en";

export const bootstrapLocales = ["en", "de"] as const;

export type BootstrapLocale = (typeof bootstrapLocales)[number];

export type BootstrapStepMessages = {
  title: string;
  summary: string;
  description: string;
  actions: readonly string[];
  goodToKnowTitle?: string;
  goodToKnowBodyBeforeLink?: string;
  goodToKnowLinkLabel?: string;
  goodToKnowBodyAfterLink?: string;
  goodToKnowLinkHref?: string;
};

export type BootstrapMessages = {
  languageLabel: string;
  title: string;
  subtitle: string;
  introEyebrow: string;
  stepLabel: string;
  statusComplete: string;
  statusCurrent: string;
  statusUpcoming: string;
  continueLabel: string;
  runtimeCheckRunLabel: string;
  runtimeCheckRerunLabel: string;
  runtimeCheckRunningLabel: string;
  runtimeCheckContinueLabel: string;
  runtimeCheckVerifiedLabel: string;
  runtimeCheckWarningLabel: string;
  runtimeCheckFailedLabel: string;
  operatorDisplayNameLabel: string;
  operatorEmailLabel: string;
  operatorPasswordLabel: string;
  operatorPasswordHint: string;
  operatorCreateLabel: string;
  operatorCreatingLabel: string;
  operatorContinueLabel: string;
  operatorSavedLabel: string;
  operatorExistingDescription: string;
  operatorUnnamedLabel: string;
  operatorEnabledLabel: string;
  operatorDisabledLabel: string;
  operatorClearLabel: string;
  operatorClearingLabel: string;
  operatorClearWarning: string;
  operatorClearConfirm: string;
  cancelLabel: string;
  translationChooseLabel: string;
  translationAiLabel: string;
  translationAiDescription: string;
  translationAiKeyLabel: string;
  translationAiEndpointLabel: string;
  translationAiLinkBefore: string;
  translationAiLinkLabel: string;
  translationAiLinkAfter: string;
  translationAiLinkHref: string;
  translationCdnLabel: string;
  translationCdnDescription: string;
  translationCustomLabel: string;
  translationCustomDescription: string;
  translationCustomEndpointLabel: string;
  translationEnglishLabel: string;
  translationEnglishDescription: string;
  translationContinueLabel: string;
  databaseHostLabel: string;
  databasePortLabel: string;
  databaseNameLabel: string;
  databaseUserLabel: string;
  databasePasswordLabel: string;
  databaseSslLabel: string;
  databaseSslDisableLabel: string;
  databaseSslRequireLabel: string;
  databaseCurrentLabel: string;
  databaseConnectionLabel: string;
  databaseConnectionDescription: string;
  databaseTestingLabel: string;
  databaseContinueLabel: string;
  databaseErrorPrefix: string;
  schemaStatusLabel: string;
  schemaAppliedLabel: string;
  schemaTablesLabel: string;
  schemaMissingLabel: string;
  schemaCreateLabel: string;
  schemaCreatingLabel: string;
  schemaContinueLabel: string;
  schemaErrorPrefix: string;
  siteCurrentLabel: string;
  siteExistingDescription: string;
  siteDemoToggleLabel: string;
  siteDemoToggleHint: string;
  siteCreateToggleLabel: string;
  siteCreateToggleHint: string;
  siteKeyLabel: string;
  siteNameLabel: string;
  siteHostnameLabel: string;
  siteBaseUrlLabel: string;
  siteDefaultLocaleLabel: string;
  siteSupportEmailLabel: string;
  siteContinueLabel: string;
  siteCreatingLabel: string;
  siteErrorPrefix: string;
  finishReviewLabel: string;
  finishOperatorsLabel: string;
  finishSitesLabel: string;
  finishTranslationLabel: string;
  finishDatabaseLabel: string;
  finishInfrastructureHint: string;
  finishTermsLabel: string;
  finishTermsAcceptLabel: string;
  finishTermsBody: string;
  finishCompleteLabel: string;
  finishCompletingLabel: string;
  finishErrorPrefix: string;
  languages: Record<BootstrapLocale, string>;
  runtimeChecks: Record<
    RuntimeCheckKey,
    {
      title: string;
      description: string;
    }
  >;
  steps: Record<string, BootstrapStepMessages>;
};

const bootstrapDictionary = {
  en: bootstrapEn,
  de: bootstrapDe,
} satisfies Record<BootstrapLocale, BootstrapMessages>;

export function getBootstrapLocale(value: string | undefined): BootstrapLocale {
  return value === "de" ? "de" : "en";
}

export function getBootstrapMessages(
  locale: BootstrapLocale,
): BootstrapMessages {
  return bootstrapDictionary[locale];
}
