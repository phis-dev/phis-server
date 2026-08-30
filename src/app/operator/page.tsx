import { redirect } from "next/navigation";

import {
  OPERATOR_INFRASTRUCTURE_LABELS,
  OPERATOR_OVERVIEW_LABELS,
  OPERATOR_SITES_LABELS,
  OPERATOR_TRANSLATIONS_LABELS,
} from "@/components/operator/label-sets";
import { OperatorInfrastructurePanel } from "@/components/operator/operator-infrastructure-panel";
import { OperatorSitesPanel } from "@/components/operator/operator-sites-panel";
import { OperatorTranslationsPanel } from "@/components/operator/operator-translations-panel";
import { getPhiServerConfigSync, isBootstrapEnabled } from "@/lib/config";
import { listSites } from "@/db/sites";
import { trGlobalLabelSet } from "@/lib/landing-tr";
import { getOperatorSession } from "@/lib/operator-auth";
import { readOperatorOverviewSnapshot, resolveOperationalMode } from "@/lib/operator-runtime";
import {
  getConfiguredCdnBaseUrlSync,
  getConfiguredTranslationSupportedLocalesSync,
  normalizeTranslationMode,
  resolveTranslationLocaleSourceState,
} from "@/lib/translation-locale-options";
import { OperatorOverviewDashboard } from "@/components/operator/operator-overview-dashboard";
import { readOperatorInfrastructureSnapshot } from "@/lib/operator-infrastructure";

const WEB_UI_LABEL_CONTEXT = "Web UI label";

function buildLocaleLabel(code: string) {
  try {
    const label = new Intl.DisplayNames([code], { type: "language" }).of(code);
    return label ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

function normalizeSection(value?: string | string[]) {
  const raw = Array.isArray(value) ? value[0] : value;
  const normalized = raw?.trim().toLowerCase() ?? "overview";
  return ["overview", "sites", "translations", "operators", "infrastructure"].includes(normalized)
    ? normalized
    : "overview";
}

export default async function OperatorPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (isBootstrapEnabled()) {
    redirect("/setup");
  }

  const session = await getOperatorSession();
  if (!session) {
    redirect("/operator/login");
  }

  const resolvedSearchParams = (await searchParams) ?? {};
  const section = normalizeSection(resolvedSearchParams.section);
  const siteError = Array.isArray(resolvedSearchParams.siteError)
    ? resolvedSearchParams.siteError[0] ?? null
    : resolvedSearchParams.siteError ?? null;
  const siteAction = Array.isArray(resolvedSearchParams.siteAction)
    ? resolvedSearchParams.siteAction[0] ?? null
    : resolvedSearchParams.siteAction ?? null;
  const translationError = Array.isArray(resolvedSearchParams.translationError)
    ? resolvedSearchParams.translationError[0] ?? null
    : resolvedSearchParams.translationError ?? null;
  const translationMode = Array.isArray(resolvedSearchParams.translationMode)
    ? resolvedSearchParams.translationMode[0] ?? null
    : resolvedSearchParams.translationMode ?? null;
  const translationSuccess = Array.isArray(resolvedSearchParams.translationSuccess)
    ? resolvedSearchParams.translationSuccess[0] ?? null
    : resolvedSearchParams.translationSuccess ?? null;
  const initialSiteId = Array.isArray(resolvedSearchParams.siteId)
    ? Number(resolvedSearchParams.siteId[0] ?? 0)
    : Number(resolvedSearchParams.siteId ?? 0);
  const siteNotice = Array.isArray(resolvedSearchParams.siteNotice)
    ? resolvedSearchParams.siteNotice[0] ?? null
    : resolvedSearchParams.siteNotice ?? null;
  const siteNoticeMode = Array.isArray(resolvedSearchParams.siteNoticeMode)
    ? resolvedSearchParams.siteNoticeMode[0] ?? null
    : resolvedSearchParams.siteNoticeMode ?? null;
  const siteNoticeId = Array.isArray(resolvedSearchParams.siteNoticeId)
    ? resolvedSearchParams.siteNoticeId[0] ?? null
    : resolvedSearchParams.siteNoticeId ?? null;
  const siteDeleteTranslationsSuccessLocale = Array.isArray(
    resolvedSearchParams.siteDeleteTranslationsSuccessLocale,
  )
    ? resolvedSearchParams.siteDeleteTranslationsSuccessLocale[0] ?? null
    : resolvedSearchParams.siteDeleteTranslationsSuccessLocale ?? null;

  const overviewLabels = await trGlobalLabelSet(OPERATOR_OVERVIEW_LABELS, WEB_UI_LABEL_CONTEXT);

  if (section === "overview") {
    return (
      <OperatorOverviewDashboard
        initialSnapshot={readOperatorOverviewSnapshot()}
        labels={{
          title: overviewLabels.title,
          os: "OS",
          node: "Node.js",
          next: "Next.js",
          react: "React",
          cpuCard: overviewLabels.cpuCard,
          memoryCard: overviewLabels.memoryCard,
          diskCard: overviewLabels.diskCard,
          uptimeCard: overviewLabels.uptimeCard,
          cpuGraph: overviewLabels.cpuGraph,
          memoryGraph: overviewLabels.memoryGraph,
          diskGraph: overviewLabels.diskGraph,
          loadDetail: overviewLabels.loadDetail,
          usedDetail: overviewLabels.usedDetail,
          freeDetail: overviewLabels.freeDetail,
        }}
      />
    );
  }

  if (section === "sites") {
    const config = getPhiServerConfigSync();
    const [sitesLabels, sites] = await Promise.all([
      trGlobalLabelSet(OPERATOR_SITES_LABELS, WEB_UI_LABEL_CONTEXT),
      listSites(),
    ]);

    return (
      <OperatorSitesPanel
        labels={sitesLabels}
        sites={sites}
        mode={resolveOperationalMode()}
        allowedLocales={getConfiguredTranslationSupportedLocalesSync()}
        siteSettings={config.sites ?? {}}
        error={siteError}
        initialAction={siteAction === "create" || siteAction === "settings" ? siteAction : null}
        initialSiteId={Number.isInteger(initialSiteId) ? initialSiteId : 0}
        notificationMessage={siteNotice}
        notificationMode={
          siteNoticeMode === "success" || siteNoticeMode === "warning" || siteNoticeMode === "error"
            ? siteNoticeMode
            : null
        }
        notificationId={siteNoticeId}
        deletedTranslationsLocale={siteDeleteTranslationsSuccessLocale}
      />
    );
  }

  if (section === "translations") {
    const config = getPhiServerConfigSync();
    const [translationsLabels, sourceState, sites] = await Promise.all([
      trGlobalLabelSet(OPERATOR_TRANSLATIONS_LABELS, WEB_UI_LABEL_CONTEXT),
      resolveTranslationLocaleSourceState(translationMode ? normalizeTranslationMode(translationMode) : null),
      listSites(),
    ]);
    const lockedLocales = Array.from(
      new Set(
        sites.flatMap((site) => [
          site.defaultLocale,
          ...site.availableLocales.map((locale) => locale.code),
        ]),
      ),
    ).sort();
    const sourceOptions = Array.from(
      new Map(
        [
          ...sourceState.options,
          ...lockedLocales.map((code) => ({
            code,
            label: buildLocaleLabel(code),
          })),
        ].map((option) => [option.code, option]),
      ).values(),
    ).sort((left, right) => left.label.localeCompare(right.label));

    return (
      <OperatorTranslationsPanel
        labels={translationsLabels}
        mode={sourceState.mode}
        sourceOptions={sourceOptions}
        configuredLocales={sourceState.configuredLocales}
        sourceError={sourceState.sourceError}
        lockedLocales={lockedLocales}
        validationError={translationError}
        successMessage={translationSuccess ? translationsLabels.success : null}
        successNotificationId={translationSuccess}
        initialCustomEndpoint={config.translation?.customEndpoint?.trim() ?? ""}
        cdnBaseUrl={getConfiguredCdnBaseUrlSync()}
        deeplApiKey={config.deepl?.apiKey?.trim() ?? ""}
        deeplApiUrl={config.deepl?.apiUrl?.trim() ?? ""}
        initialAllowPublicReads={config.translation?.allowPublicReads === true}
        initialAllowPublicWrites={config.translation?.allowPublicWrites === true}
        initialPublicToken={config.api?.publicToken?.trim() ?? ""}
      />
    );
  }

  if (section === "infrastructure") {
    const infrastructureLabels = await trGlobalLabelSet(
      OPERATOR_INFRASTRUCTURE_LABELS,
      WEB_UI_LABEL_CONTEXT,
    );

    return (
      <OperatorInfrastructurePanel
        labels={infrastructureLabels}
        snapshot={readOperatorInfrastructureSnapshot()}
      />
    );
  }

  const sectionTitleMap = {
    operators: overviewLabels.operatorsTitle,
  } as const;

  const title = sectionTitleMap[section as keyof typeof sectionTitleMap];

  return (
    <div className="operator-overview">
      <section className="ui_card">
        <p className="ui_section_eyebrow">{title}</p>
        <p className="ui_section_title">{title}</p>
        <p className="ui_section_body">{overviewLabels.comingSoon}</p>
      </section>
    </div>
  );
}
