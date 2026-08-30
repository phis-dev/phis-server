"use client";

import { useMemo, useState } from "react";

import { saveInitialSites } from "@/app/setup/actions";
import type { BootstrapLocale, BootstrapMessages } from "@/bootstrap/i18n";
import { SelectMenu } from "@/components/ui/select-menu";
import { SubmitButton } from "@/components/ui/submit-button";
import { Switch } from "@/components/ui/switch";

export function SiteCreationForm({
  locale,
  messages,
  nextStepHref,
  allowedLocales,
  error,
}: {
  locale: BootstrapLocale;
  messages: BootstrapMessages;
  nextStepHref: string;
  allowedLocales: string[];
  error: string | null;
}) {
  const localeOptions = useMemo(
    () =>
      allowedLocales.map((code) => ({
        value: code,
        label: code.toUpperCase(),
      })),
    [allowedLocales],
  );
  const [createDemoSite, setCreateDemoSite] = useState(false);
  const [createCustomSite, setCreateCustomSite] = useState(false);
  const [defaultLocale, setDefaultLocale] = useState(allowedLocales[0] ?? "en");

  return (
    <form className="ui_form" action={saveInitialSites.bind(null, locale, nextStepHref)}>
      {error ? (
        <p className="ui_notice_inline_error">
          {messages.siteErrorPrefix} {error}
        </p>
      ) : null}

      <div className="ui_switch_stack">
        <Switch
          name="createDemoSite"
          label={messages.siteDemoToggleLabel}
          hint={messages.siteDemoToggleHint}
          checked={createDemoSite}
          onChange={(event) => setCreateDemoSite(event.target.checked)}
        />
        <Switch
          name="createCustomSite"
          label={messages.siteCreateToggleLabel}
          hint={messages.siteCreateToggleHint}
          checked={createCustomSite}
          onChange={(event) => setCreateCustomSite(event.target.checked)}
        />
      </div>

      {createCustomSite ? (
        <>
          <div className="ui_form_grid">
            <label className="ui_field">
              <span className="ui_field_label">{messages.siteKeyLabel}</span>
              <input
                className="ui_input"
                type="text"
                name="siteKey"
                autoCapitalize="none"
                autoCorrect="off"
                required={createCustomSite}
              />
            </label>

            <label className="ui_field">
              <span className="ui_field_label">{messages.siteNameLabel}</span>
              <input
                className="ui_input"
                type="text"
                name="siteName"
                required={createCustomSite}
              />
            </label>
          </div>

          <div className="ui_form_grid">
            <label className="ui_field">
              <span className="ui_field_label">{messages.siteHostnameLabel}</span>
              <input
                className="ui_input"
                type="text"
                name="siteHostname"
                autoCapitalize="none"
                autoCorrect="off"
                required={createCustomSite}
              />
            </label>

            <label className="ui_field">
              <span className="ui_field_label">{messages.siteSupportEmailLabel}</span>
              <input
                className="ui_input"
                type="email"
                name="siteSupportEmail"
                autoCapitalize="none"
                autoCorrect="off"
                required={createCustomSite}
              />
            </label>
          </div>

          <div className="ui_form_grid">
            <label className="ui_field">
              <span className="ui_field_label">{messages.siteBaseUrlLabel}</span>
              <input
                className="ui_input"
                type="url"
                name="siteBaseUrl"
                autoCapitalize="none"
                autoCorrect="off"
                required={createCustomSite}
              />
            </label>

            <div className="ui_field">
              <input type="hidden" name="siteDefaultLocale" value={defaultLocale} />
              <SelectMenu
                label={messages.siteDefaultLocaleLabel}
                value={defaultLocale}
                options={localeOptions}
                onChange={setDefaultLocale}
              />
            </div>
          </div>
        </>
      ) : null}

      <div className="ui_form_footer">
        <SubmitButton
          idleLabel={messages.siteContinueLabel}
          pendingLabel={messages.siteCreatingLabel}
        />
      </div>
    </form>
  );
}
