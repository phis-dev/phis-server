import { saveDatabaseConnection } from "@/app/(operator)/setup/actions";
import type { BootstrapLocale, BootstrapMessages } from "@/bootstrap/i18n";
import { SubmitButton } from "@/components/ui/submit-button";
import { Switch } from "@/components/ui/switch";
import { readPhiRuntimeConfigSync } from "@/lib/config-files";

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
      // Whether one is stored, never the password itself: this page is rendered into HTML.
      hasPassword: url.password.length > 0,
      sslMode: url.searchParams.get("sslmode") === "require" ? "require" : "disable",
    };
  } catch {
    return null;
  }
}

export function DatabaseSetupPanel({
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
  const parsedDatabase = parseDatabaseUri(runtimeConfig.database?.uri);

  return (
    <div className="ui_section_stack">
      <section className="ui_card">
        {parsedDatabase ? (
          <>
            <p className="ui_section_eyebrow">{messages.databaseCurrentLabel}</p>
            <div className="ui_card_soft ui_meta_card">
              <div className="ui_meta_row">
                <div className="ui_meta_identity">
                  <p className="ui_meta_title">
                    {parsedDatabase.database}
                  </p>
                  <p className="ui_meta_subtitle">
                    {parsedDatabase.user}@{parsedDatabase.host}:{parsedDatabase.port}
                  </p>
                </div>
              </div>
            </div>
          </>
        ) : null}

        <p className="ui_section_body">{messages.databaseConnectionDescription}</p>

        {error ? (
          <p className="ui_notice_inline_error">
            {messages.databaseErrorPrefix} {error}
          </p>
        ) : null}

        <form className="ui_form" action={saveDatabaseConnection.bind(null, locale, nextStepHref)}>
          <div className="ui_form_grid">
            <label className="ui_field">
              <span className="ui_field_label">{messages.databaseHostLabel}</span>
              <input
                className="ui_input"
                type="text"
                name="host"
                defaultValue={parsedDatabase?.host ?? ""}
                required
              />
            </label>

            <label className="ui_field">
              <span className="ui_field_label">{messages.databasePortLabel}</span>
              <input
                className="ui_input"
                type="text"
                name="port"
                defaultValue={parsedDatabase?.port ?? "5432"}
                required
              />
            </label>
          </div>

          <div className="ui_form_grid">
            <label className="ui_field">
              <span className="ui_field_label">{messages.databaseNameLabel}</span>
              <input
                className="ui_input"
                type="text"
                name="database"
                defaultValue={parsedDatabase?.database ?? ""}
                required
              />
            </label>

            <label className="ui_field">
              <span className="ui_field_label">{messages.databaseUserLabel}</span>
              <input
                className="ui_input"
                type="text"
                name="user"
                defaultValue={parsedDatabase?.user ?? ""}
                required
              />
            </label>
          </div>

          <label className="ui_field">
            <span className="ui_field_label">{messages.databasePasswordLabel}</span>
            <input
              className="ui_input"
              type="password"
              name="password"
              autoComplete="new-password"
              placeholder={parsedDatabase?.hasPassword ? messages.databasePasswordKeptHint : undefined}
              required={!parsedDatabase?.hasPassword}
            />
          </label>

          <div className="ui_form_grid">
            <Switch
              name="sslMode"
              label={messages.databaseSslLabel}
              defaultChecked={parsedDatabase?.sslMode === "require"}
            />
          </div>

          <div className="ui_form_footer">
            <SubmitButton
              idleLabel={messages.databaseContinueLabel}
              pendingLabel={messages.databaseTestingLabel}
            />
          </div>
        </form>
      </section>

      <section className="ui_card ui_card_accent">
        <p className="ui_section_eyebrow">{messages.continueLabel}</p>
        <p className="ui_section_title">{messages.steps.database.goodToKnowTitle}</p>
        <p className="ui_section_body">
          {messages.steps.database.goodToKnowBodyBeforeLink}
        </p>
      </section>
    </div>
  );
}
