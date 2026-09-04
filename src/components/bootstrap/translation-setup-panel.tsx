"use client";

import { useMemo, useState } from "react";

import type { BootstrapMessages } from "@/bootstrap/i18n";
import { saveTranslationSettings } from "@/app/(operator)/setup/actions";
import { SubmitButton } from "@/components/ui/submit-button";

type TranslationMode = "deepl" | "cdn" | "custom" | "none";

const DEFAULT_DEEPL_FREE_ENDPOINT = "https://api-free.deepl.com/v2/translate";
const CUSTOM_ENDPOINT_PLACEHOLDER = "https://localhost:8080/api/v1/translate";

export function TranslationSetupPanel({
  locale,
  messages,
  nextStepHref,
  initialMode,
  initialDeeplKey,
  initialDeeplEndpoint,
  initialCustomEndpoint,
  error,
}: {
  locale: "en" | "de";
  messages: BootstrapMessages;
  nextStepHref: string;
  initialMode?: TranslationMode | null;
  initialDeeplKey?: string | null;
  initialDeeplEndpoint?: string | null;
  initialCustomEndpoint?: string | null;
  error?: string | null;
}) {
  const [mode, setMode] = useState<TranslationMode | null>(initialMode ?? null);
  const [deeplKey, setDeeplKey] = useState(initialDeeplKey ?? "");
  const [deeplEndpoint, setDeeplEndpoint] = useState(
    initialDeeplEndpoint ?? DEFAULT_DEEPL_FREE_ENDPOINT,
  );
  const [customEndpoint, setCustomEndpoint] = useState(initialCustomEndpoint ?? "");

  const canContinue = useMemo(() => {
    const normalizedDeeplKey = typeof deeplKey === "string" ? deeplKey : "";
    const normalizedDeeplEndpoint =
      typeof deeplEndpoint === "string" ? deeplEndpoint : "";

    if (mode === "deepl") {
      return (
        normalizedDeeplKey.trim().length > 0 &&
        normalizedDeeplEndpoint.trim().length > 0
      );
    }

    if (mode === "custom") {
      return customEndpoint.trim().length > 0;
    }

    return mode === "cdn" || mode === "none";
  }, [customEndpoint, deeplEndpoint, deeplKey, mode]);

  return (
    <div className="ui_section_stack">
      <section className="ui_card">
        <p className="ui_section_body">{messages.translationChooseLabel}</p>

        {error ? <p className="ui_notice_inline_error">{error}</p> : null}

        <form className="ui_form" action={saveTranslationSettings.bind(null, locale, nextStepHref)}>
          <input type="hidden" name="translationMode" value={mode ?? ""} />
          <input type="hidden" name="deeplKey" value={deeplKey} />
          <input type="hidden" name="deeplEndpoint" value={deeplEndpoint} />
          <input type="hidden" name="customEndpoint" value={customEndpoint} />

          <div className="ui_choice_list">
            <div
              className="ui_card_selectable ui_choice ui_choice_group"
              data-selected={mode === "deepl" ? "true" : "false"}
            >
              <label className="ui_choice_header">
                <input
                  className="ui_choice_input"
                  type="radio"
                  name="translationMode"
                  value="deepl"
                  checked={mode === "deepl"}
                  onChange={() => setMode("deepl")}
                />
                <span className="ui_choice_content">
                  <span className="ui_choice_title">
                    {messages.translationAiLabel}
                  </span>
                  <span className="ui_choice_description">
                    {messages.translationAiDescription}
                  </span>
                </span>
              </label>

              {mode === "deepl" ? (
                <div className="ui_choice_fields ui_choice_fields_inline">
                  <label className="ui_field">
                    <span className="ui_field_label">
                      {messages.translationAiKeyLabel}
                    </span>
                    <input
                      className="ui_input"
                      type="text"
                      value={deeplKey}
                      onChange={(event) => setDeeplKey(event.target.value)}
                    />
                  </label>

                  <label className="ui_field">
                    <span className="ui_field_label">
                      {messages.translationAiEndpointLabel}
                    </span>
                    <input
                      className="ui_input"
                      type="url"
                      value={deeplEndpoint}
                      onChange={(event) => setDeeplEndpoint(event.target.value)}
                      placeholder={DEFAULT_DEEPL_FREE_ENDPOINT}
                    />
                  </label>

                  <p className="ui_section_body">
                    {messages.translationAiLinkBefore}
                    <a
                      className="ui_text_link"
                      href={messages.translationAiLinkHref}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {messages.translationAiLinkLabel}
                    </a>
                    {messages.translationAiLinkAfter}
                  </p>
                </div>
              ) : null}
            </div>

            <label className="ui_card_selectable ui_choice">
              <input
                className="ui_choice_input"
                type="radio"
                name="translationMode"
                value="cdn"
                checked={mode === "cdn"}
                onChange={() => setMode("cdn")}
              />
              <span className="ui_choice_content">
                <span className="ui_choice_title">
                  {messages.translationCdnLabel}
                </span>
                <span className="ui_choice_description">
                  {messages.translationCdnDescription}
                </span>
              </span>
            </label>

            <div
              className="ui_card_selectable ui_choice ui_choice_group"
              data-selected={mode === "custom" ? "true" : "false"}
            >
              <label className="ui_choice_header">
                <input
                  className="ui_choice_input"
                  type="radio"
                  name="translationMode"
                  value="custom"
                  checked={mode === "custom"}
                  onChange={() => setMode("custom")}
                />
                <span className="ui_choice_content">
                  <span className="ui_choice_title">
                    {messages.translationCustomLabel}
                  </span>
                  <span className="ui_choice_description">
                    {messages.translationCustomDescription}
                  </span>
                </span>
              </label>

              {mode === "custom" ? (
                <div className="ui_choice_fields ui_choice_fields_inline">
                  <label className="ui_field">
                    <span className="ui_field_label">
                      {messages.translationCustomEndpointLabel}
                    </span>
                    <input
                      className="ui_input"
                      type="url"
                      value={customEndpoint}
                      onChange={(event) => setCustomEndpoint(event.target.value)}
                      placeholder={CUSTOM_ENDPOINT_PLACEHOLDER}
                    />
                  </label>
                </div>
              ) : null}
            </div>

            <label className="ui_card_selectable ui_choice">
              <input
                className="ui_choice_input"
                type="radio"
                name="translationMode"
                value="none"
                checked={mode === "none"}
                onChange={() => setMode("none")}
              />
              <span className="ui_choice_content">
                <span className="ui_choice_title">
                  {messages.translationEnglishLabel}
                </span>
                <span className="ui_choice_description">
                  {messages.translationEnglishDescription}
                </span>
              </span>
            </label>
          </div>

          <div className="ui_form_footer">
            <SubmitButton
              idleLabel={messages.translationContinueLabel}
              pendingLabel={messages.translationContinueLabel}
              disabled={!canContinue}
            />
          </div>
        </form>
      </section>

      <section className="ui_card ui_card_accent">
        <p className="ui_section_eyebrow">{messages.continueLabel}</p>
        <p className="ui_section_title">{messages.steps.translations.goodToKnowTitle}</p>
        <p className="ui_section_body">
          {messages.steps.translations.goodToKnowBodyBeforeLink}
        </p>
      </section>
    </div>
  );
}
