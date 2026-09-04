import { Client } from "pg";

import { applySchemaBootstrap } from "@/app/(operator)/setup/actions";
import type { BootstrapLocale, BootstrapMessages } from "@/bootstrap/i18n";
import { SubmitButton } from "@/components/ui/submit-button";
import { readPhiRuntimeConfigSync } from "@/lib/config-files";

async function readSchemaStatus(connectionString: string | undefined) {
  if (!connectionString?.trim()) {
    return null;
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    const schemaResult = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'phis') AS exists",
    );
    const schemaExists = schemaResult.rows[0]?.exists === true;

    if (!schemaExists) {
      return {
        schemaExists: false,
        tableCount: 0,
      };
    }

    const tableResult = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM information_schema.tables WHERE table_schema = 'phis'",
    );

    return {
      schemaExists: true,
      tableCount: Number.parseInt(tableResult.rows[0]?.count ?? "0", 10) || 0,
    };
  } finally {
    await client.end();
  }
}

export async function SchemaSetupPanel({
  locale,
  messages,
  nextStepHref,
  error,
}: {
  locale: BootstrapLocale;
  messages: BootstrapMessages;
  nextStepHref: string;
  error: string | null;
}) {
  const runtimeConfig = readPhiRuntimeConfigSync();
  const schemaStatus = await readSchemaStatus(runtimeConfig.database?.uri);

  return (
    <div className="ui_section_stack">
      <section className="ui_card">
        <p className="ui_section_eyebrow">{messages.schemaStatusLabel}</p>
        <div className="ui_card_soft ui_meta_card">
          <div className="ui_meta_row">
            <div className="ui_meta_identity">
              <p className="ui_meta_title">
                {schemaStatus?.schemaExists
                  ? messages.schemaAppliedLabel
                  : messages.schemaMissingLabel}
              </p>
              <p className="ui_meta_subtitle">
                {schemaStatus?.schemaExists
                  ? `${schemaStatus.tableCount} ${messages.schemaTablesLabel}`
                  : "phis"}
              </p>
            </div>
          </div>
        </div>

        {error ? (
          <p className="ui_notice_inline_error">
            {messages.schemaErrorPrefix} {error}
          </p>
        ) : null}

        <form className="ui_form" action={applySchemaBootstrap.bind(null, locale, nextStepHref)}>
          <div className="ui_form_footer">
            <SubmitButton
              idleLabel={messages.schemaCreateLabel}
              pendingLabel={messages.schemaCreatingLabel}
            />
          </div>
        </form>
      </section>

      <section className="ui_card ui_card_accent">
        <p className="ui_section_eyebrow">{messages.continueLabel}</p>
        <p className="ui_section_title">{messages.steps.schema.goodToKnowTitle}</p>
        <p className="ui_section_body">
          {messages.steps.schema.goodToKnowBodyBeforeLink}
        </p>
      </section>
    </div>
  );
}
