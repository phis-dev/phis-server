import Link from "next/link";

import type { BootstrapLocale, BootstrapMessages } from "@/bootstrap/i18n";
import { createPlatformSuperUser } from "@/app/setup/actions";
import { ClearOperatorAccountsButton } from "@/components/bootstrap/clear-operator-accounts-button";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { readPhiRuntimeConfigSync } from "@/lib/config-files";

export function OperatorSetupPanel({
  locale,
  messages,
  nextStepHref,
  saved,
}: {
  locale: BootstrapLocale;
  messages: BootstrapMessages;
  nextStepHref: string;
  saved: boolean;
}) {
  const runtimeConfig = readPhiRuntimeConfigSync();
  const superUsers = runtimeConfig.platformSuperUsers ?? [];
  const hasSuperUsers = superUsers.length > 0;

  return (
    <div className="ui_section_stack">
      <section className="ui_card">
        {hasSuperUsers ? (
          <p className="ui_section_body">{messages.operatorExistingDescription}</p>
        ) : null}

        {hasSuperUsers ? (
          <div className="ui_stack_list">
            {saved ? (
              <p className="ui_text_accent">
                {messages.operatorSavedLabel}
              </p>
            ) : null}
            {superUsers.map((user) => (
              <article key={user.email} className="ui_card_soft ui_meta_card">
                <div className="ui_meta_row">
                  <div className="ui_meta_identity">
                    <p className="ui_meta_title">
                      {user.displayName?.trim() || messages.operatorUnnamedLabel}
                    </p>
                    <p className="ui_meta_subtitle">{user.email}</p>
                  </div>
                  <p className="ui_meta_status">
                    {user.enabled === false
                      ? messages.operatorDisabledLabel
                      : messages.operatorEnabledLabel}
                  </p>
                </div>
              </article>
            ))}
            <ClearOperatorAccountsButton
              label={messages.operatorClearLabel}
              pendingLabel={messages.operatorClearingLabel}
              warning={messages.operatorClearWarning}
              confirmMessage={messages.operatorClearConfirm}
              cancelLabel={messages.cancelLabel}
            />
          </div>
        ) : (
          <form className="ui_form" action={createPlatformSuperUser.bind(null, locale)}>
            <div className="ui_form_grid">
              <label className="ui_field">
                <span className="ui_field_label">
                  {messages.operatorDisplayNameLabel}
                </span>
                <input
                  className="ui_input"
                  type="text"
                  name="displayName"
                  autoComplete="name"
                  required
                />
              </label>

              <label className="ui_field">
                <span className="ui_field_label">
                  {messages.operatorEmailLabel}
                </span>
                <input
                  className="ui_input"
                  type="email"
                  name="email"
                  autoComplete="email"
                  required
                />
              </label>
            </div>

            <label className="ui_field">
              <span className="ui_field_label">
                {messages.operatorPasswordLabel}
              </span>
              <input
                className="ui_input"
                type="password"
                name="password"
                autoComplete="new-password"
                minLength={8}
                pattern={"(?=.*[^A-Za-z0-9]).{8,}"}
                title={messages.operatorPasswordHint}
                required
              />
              <span className="ui_field_hint">
                {messages.operatorPasswordHint}
              </span>
            </label>

            <div className="ui_form_footer">
              <SubmitButton
                idleLabel={messages.operatorCreateLabel}
                pendingLabel={messages.operatorCreatingLabel}
              />
            </div>
          </form>
        )}

        <div className="ui_form_footer">
          {hasSuperUsers ? (
            <Link
              href={nextStepHref}
              className="ui_button ui_control ui_control_pill ui_button-primary"
            >
              <span className="ui_button_label">{messages.operatorContinueLabel}</span>
            </Link>
          ) : (
            <Button type="button" variant="primary" disabled>
              {messages.operatorContinueLabel}
            </Button>
          )}
        </div>
      </section>

      <section className="ui_card ui_card_accent">
        <p className="ui_section_eyebrow">{messages.continueLabel}</p>
        <p className="ui_section_title">{messages.steps.operator.goodToKnowTitle}</p>
        <p className="ui_section_body">
          {messages.steps.operator.goodToKnowBodyBeforeLink}
        </p>
      </section>
    </div>
  );
}
