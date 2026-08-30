import { Client } from "pg";

import type { BootstrapLocale, BootstrapMessages } from "@/bootstrap/i18n";
import { FinishCompleteForm } from "@/components/bootstrap/finish-complete-form";
import { readMergedPhiConfigSync, readPhiRuntimeConfigSync } from "@/lib/config-files";

type BootstrapSiteRecord = {
  key: string;
  name: string;
  publicBaseUrl: string;
};

function parseDatabaseUri(databaseUri: string | undefined) {
  if (!databaseUri?.trim()) {
    return null;
  }

  try {
    const url = new URL(databaseUri);
    return {
      host: decodeURIComponent(url.hostname),
      port: url.port || "5432",
      database: decodeURIComponent(url.pathname.replace(/^\//, "")),
      user: decodeURIComponent(url.username),
    };
  } catch {
    return null;
  }
}

async function readBootstrapSites(connectionString: string | undefined) {
  if (!connectionString?.trim()) {
    return [];
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    const { rows } = await client.query<{
      key: string;
      name: string;
      public_base_url: string;
    }>(
      `SELECT key, name, public_base_url
       FROM phis.sites
       ORDER BY id`,
    );

    return rows.map(
      (row): BootstrapSiteRecord => ({
        key: row.key,
        name: row.name,
        publicBaseUrl: row.public_base_url,
      }),
    );
  } finally {
    await client.end();
  }
}

function resolveTranslationModeLabel(messages: BootstrapMessages, mode: string | undefined) {
  if (mode === "deepl") {
    return messages.translationAiLabel;
  }

  if (mode === "cdn") {
    return messages.translationCdnLabel;
  }

  if (mode === "custom") {
    return messages.translationCustomLabel;
  }

  return messages.translationEnglishLabel;
}

export async function FinishSetupPanel({
  locale,
  messages,
  error,
}: {
  locale: BootstrapLocale;
  messages: BootstrapMessages;
  error: string | null;
}) {
  const runtimeConfig = readPhiRuntimeConfigSync();
  const mergedConfig = readMergedPhiConfigSync();
  const sites = await readBootstrapSites(runtimeConfig.database?.uri);
  const parsedDatabase = parseDatabaseUri(runtimeConfig.database?.uri);
  const operatorSummary =
    runtimeConfig.platformSuperUsers?.length
      ? runtimeConfig.platformSuperUsers
          .map((user) => user.displayName?.trim() || user.email)
          .join(", ")
      : "None configured";
  const translationModeLabel = resolveTranslationModeLabel(
    messages,
    runtimeConfig.translation?.mode ?? mergedConfig.translation?.mode,
  );

  return (
    <div className="ui_section_stack">
      <section className="ui_card">
        <p className="ui_section_eyebrow">{messages.finishReviewLabel}</p>
        <div className="ui_stack_list">
          <article className="ui_card_soft ui_meta_card">
            <div className="ui_meta_row">
              <div className="ui_meta_identity">
                <p className="ui_meta_title">{messages.finishDatabaseLabel}</p>
                <p className="ui_meta_subtitle">
                  {parsedDatabase
                    ? `${parsedDatabase.user}@${parsedDatabase.host}:${parsedDatabase.port}/${parsedDatabase.database}`
                    : "Not configured"}
                </p>
              </div>
            </div>
          </article>

          <article className="ui_card_soft ui_meta_card">
            <div className="ui_meta_row">
              <div className="ui_meta_identity">
                <p className="ui_meta_title">{messages.finishTranslationLabel}</p>
                <p className="ui_meta_subtitle">{translationModeLabel}</p>
              </div>
            </div>
          </article>

          <article className="ui_card_soft ui_meta_card">
            <div className="ui_meta_row">
              <div className="ui_meta_identity">
                <p className="ui_meta_title">{messages.finishOperatorsLabel}</p>
                <p className="ui_meta_subtitle">{operatorSummary}</p>
              </div>
            </div>
          </article>

          <article className="ui_card_soft ui_meta_card">
            <div className="ui_meta_row">
              <div className="ui_meta_identity">
                <p className="ui_meta_title">{messages.finishSitesLabel}</p>
                <p className="ui_meta_subtitle">
                  {sites.length > 0
                    ? sites.map((site) => `${site.name} (${site.publicBaseUrl})`).join(", ")
                    : "No sites configured"}
                </p>
              </div>
            </div>
          </article>
        </div>

        <p className="ui_section_body ui_section_body--top-gap">
          {messages.finishInfrastructureHint}
        </p>
        {error ? (
          <p className="ui_notice_inline_error">
            {messages.finishErrorPrefix} {error}
          </p>
        ) : null}

        <FinishCompleteForm locale={locale} messages={messages} />
      </section>

      <section className="ui_card ui_card_accent">
        <p className="ui_section_eyebrow">{messages.continueLabel}</p>
        <p className="ui_section_title">{messages.steps.finish.goodToKnowTitle}</p>
        <p className="ui_section_body">
          {messages.steps.finish.goodToKnowBodyBeforeLink}
        </p>
      </section>
    </div>
  );
}
