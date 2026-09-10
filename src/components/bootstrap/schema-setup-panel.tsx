import { applySchemaBootstrap } from "@/app/(operator)/setup/actions";
import type { BootstrapLocale, BootstrapMessages } from "@/bootstrap/i18n";
import { SubmitButton } from "@/components/ui/submit-button";
import { readPhiBootstrapSchemaStatus } from "@/db/bootstrap";
import { readPhiRuntimeConfigSync } from "@/lib/config-files";

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
  const schemaStatus = await readPhiBootstrapSchemaStatus(runtimeConfig.database?.uri);

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
