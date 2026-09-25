"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { updateOperatorSupportedLocales } from "@/app/(operator)/operator/actions";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { MultiSelectMenu } from "@/components/ui/multi-select-menu";
import { NotificationCenter } from "@/components/ui/notification-center";
import { SubmitButton } from "@/components/ui/submit-button";
import { Switch } from "@/components/ui/switch";
import type { TranslationMode } from "@/lib/translation-locale-options";

const DEFAULT_DEEPL_ENDPOINT = "https://api-free.deepl.com/v2/translate";

type LocaleOption = {
  code: string;
  label: string;
};

type OperatorTranslationsLabels = {
  title: string;
  intro: string;
  mode: string;
  modeHelp: string;
  source: string;
  supportedLocales: string;
  supportedLocalesHelp: string;
  publicReads: string;
  publicReadsHint: string;
  publicToken: string;
  publicTokenHelp: string;
  publicWrites: string;
  publicWritesHint: string;
  publicWritesWarningTitle: string;
  publicWritesWarningDescription: string;
  publicWritesEnable: string;
  cancel: string;
  localeSelectionPlaceholder: string;
  modeDeepl: string;
  modeDeeplDescription: string;
  deeplKey: string;
  deeplKeyHelp: string;
  deeplEndpoint: string;
  deeplEndpointHelp: string;
  modeCdn: string;
  modeCdnDescription: string;
  cdnEndpoint: string;
  cdnEndpointHelp: string;
  modeAddon: string;
  modeAddonDescription: string;
  addonProvider: string;
  addonProviderHelp: string;
  addonProviderEmpty: string;
  addonProviderUnset: string;
  addonSecret: string;
  addonSecretHelp: string;
  customSchema: string;
  customSchemaTitle: string;
  customSchemaIntro: string;
  customSchemaForwardedHeaders: string;
  customSchemaSingleRequest: string;
  customSchemaBatchRequest: string;
  customSchemaSingleResponse: string;
  customSchemaBatchResponse: string;
  close: string;
  modeNone: string;
  modeNoneDescription: string;
  localeInUse: string;
  save: string;
  savePending: string;
  success: string;
  sourceError: string;
  validationError: string;
};

function FieldHelpBadge({ helpText }: { helpText: string }) {
  return (
    <span className="operator-help" tabIndex={0} aria-label={helpText}>
      <span className="operator-help_badge" aria-hidden="true">
        ?
      </span>
      <span className="ui_menu_popover ui_surface_popover operator-help_popover" role="tooltip">
        {helpText}
      </span>
    </span>
  );
}

export function OperatorTranslationsPanel({
  labels,
  mode,
  sourceOptions,
  configuredLocales,
  sourceError,
  lockedLocales,
  validationError,
  successMessage,
  successNotificationId,
  cdnBaseUrl,
  deeplApiKey,
  deeplApiUrl,
  initialAllowPublicReads,
  initialAllowPublicWrites,
  initialPublicToken,
  addonProviders,
  initialAddonProviderKey,
  initialAddonSecretReference,
}: {
  labels: OperatorTranslationsLabels;
  mode: TranslationMode;
  sourceOptions: LocaleOption[];
  configuredLocales: string[];
  sourceError: string | null;
  lockedLocales: string[];
  validationError: string | null;
  successMessage: string | null;
  successNotificationId: string | null;
  cdnBaseUrl: string;
  deeplApiKey: string;
  deeplApiUrl: string;
  initialAllowPublicReads: boolean;
  initialAllowPublicWrites: boolean;
  initialPublicToken: string;
  addonProviders: ReadonlyArray<{
    addonId: string;
    providerKey: string;
    enabled: boolean;
    interfaceCurrent: boolean;
  }>;
  initialAddonProviderKey: string;
  initialAddonSecretReference: string;
}) {
  const router = useRouter();
  const [selectedLocales, setSelectedLocales] = useState<string[]>(configuredLocales);
  const [editableDeeplApiKey, setEditableDeeplApiKey] = useState(deeplApiKey);
  const [editableDeeplApiUrl, setEditableDeeplApiUrl] = useState(
    deeplApiUrl || DEFAULT_DEEPL_ENDPOINT,
  );
  const [allowPublicReads, setAllowPublicReads] = useState(initialAllowPublicReads);
  const [allowPublicWrites, setAllowPublicWrites] = useState(initialAllowPublicWrites);
  const [confirmEnablePublicWrites, setConfirmEnablePublicWrites] = useState(false);
  const [publicToken, setPublicToken] = useState(initialPublicToken);
  const [addonProviderKey, setAddonProviderKey] = useState(initialAddonProviderKey);
  const [addonSecretReference, setAddonSecretReference] = useState(initialAddonSecretReference);
  const [showCustomSchema, setShowCustomSchema] = useState(false);
  const lockedLocaleSet = new Set(lockedLocales);
  const notifications = [
    ...(sourceError && !validationError
      ? [
          {
            id: `translations-source-${mode}-${sourceError}`,
            mode: "warning" as const,
            message: `${labels.sourceError} ${sourceError}`,
          },
        ]
      : []),
    ...(validationError
      ? [
          {
            id: `translations-error-${validationError}`,
            mode: "error" as const,
            message: validationError,
          },
        ]
      : []),
    ...(successMessage && successNotificationId
      ? [
          {
            id: `translations-success-${successNotificationId}`,
            mode: "success" as const,
            message: successMessage,
          },
        ]
      : []),
  ];

  return (
    <div className="operator-overview">
      <NotificationCenter items={notifications} />
      <section className="ui_card">
        <p className="ui_section_title">{labels.title}</p>
        <p className="ui_section_body">{labels.intro}</p>

        <form className="ui_form" action={updateOperatorSupportedLocales}>
          <input type="hidden" name="translationMode" value={mode} />
          <input type="hidden" name="translationDeeplKey" value={editableDeeplApiKey} />
          <input type="hidden" name="translationDeeplEndpoint" value={editableDeeplApiUrl} />
          <input
            type="hidden"
            name="translationAllowPublicReads"
            value={String(allowPublicReads)}
          />
          <input
            type="hidden"
            name="translationAllowPublicWrites"
            value={String(allowPublicWrites)}
          />
          <input type="hidden" name="translationPublicToken" value={publicToken} />
          {selectedLocales.map((locale) => (
            <input key={locale} type="hidden" name="translationSupportedLocales" value={locale} />
          ))}

          <div className="operator-translations_stack">
            <div className="ui_field operator-translations_mode_card">
              <span className="operator-field_label_row">
                <span className="ui_field_label">{labels.mode}</span>
                <FieldHelpBadge helpText={labels.modeHelp} />
              </span>

              <div className="ui_choice_list">
                {[
                  {
                    value: "deepl",
                    label: labels.modeDeepl,
                    description: labels.modeDeeplDescription,
                  },
                  {
                    value: "cdn+deepl",
                    label: labels.modeCdn,
                    description: labels.modeCdnDescription,
                  },
                  {
                    value: "add-on",
                    label: labels.modeAddon,
                    description: labels.modeAddonDescription,
                  },
                  {
                    value: "none",
                    label: labels.modeNone,
                    description: labels.modeNoneDescription,
                  },
                ].map((option) => (
                  <div
                    key={option.value}
                    className="ui_card_selectable ui_choice ui_choice_group"
                    data-selected={mode === option.value ? "true" : "false"}
                  >
                    <label className="ui_choice_header">
                      <input
                        className="ui_choice_input"
                        type="radio"
                        name="translationModeChoice"
                        value={option.value}
                        checked={mode === option.value}
                        onChange={() => {
                          router.replace(
                            `/operator?section=translations&translationMode=${option.value}`,
                          );
                        }}
                      />
                      <span className="ui_choice_content">
                        <span className="ui_choice_title">{option.label}</span>
                        <span className="ui_choice_description">
                          {option.description}
                        </span>
                      </span>
                    </label>

                    {mode === "add-on" && option.value === "add-on" ? (
                      <div className="ui_choice_fields ui_choice_fields_inline">
                        <div className="ui_field">
                          <span className="operator-field_label_row">
                            <span className="ui_field_label">{labels.addonProvider}</span>
                            <FieldHelpBadge helpText={labels.addonProviderHelp} />
                          </span>
                          {/*
                            Nothing installed means nothing to choose, and the control says which of the
                            two it is: an operator has to be able to tell "none offered" from "none
                            picked yet". A disabled or interface-mismatched provider is listed and not
                            selectable, so an Add-on that is present but unusable does not look absent.
                          */}
                          <select
                            className="ui_input"
                            name="translationAddonProviderKey"
                            value={addonProviderKey}
                            disabled={addonProviders.length === 0}
                            onChange={(event) => setAddonProviderKey(event.target.value)}
                          >
                            <option value="">
                              {addonProviders.length === 0
                                ? labels.addonProviderEmpty
                                : labels.addonProviderUnset}
                            </option>
                            {addonProviders.map((provider) => (
                              <option
                                key={provider.providerKey}
                                value={provider.providerKey}
                                disabled={!provider.enabled || !provider.interfaceCurrent}
                              >
                                {`${provider.addonId} -- ${provider.providerKey}`}
                                {provider.enabled ? "" : " (disabled)"}
                                {provider.interfaceCurrent ? "" : " (interface mismatch)"}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="ui_field">
                          <span className="operator-field_label_row">
                            <span className="ui_field_label">{labels.addonSecret}</span>
                            <FieldHelpBadge helpText={labels.addonSecretHelp} />
                          </span>
                          {/*
                            A reference and not a key, so this is an ordinary text input. What it names
                            is stored encrypted elsewhere; masking the name would hide the one part an
                            operator has to be able to read back.
                          */}
                          <input
                            className="ui_input"
                            type="text"
                            name="translationAddonSecretReference"
                            value={addonSecretReference}
                            placeholder="addon:@scope/name:api-key"
                            onChange={(event) => setAddonSecretReference(event.target.value)}
                          />
                        </div>
                      </div>
                    ) : null}

                    {mode === "cdn+deepl" && option.value === "cdn+deepl" ? (
                      <div className="ui_choice_fields ui_choice_fields_inline">
                        <div className="ui_field">
                          <span className="operator-field_label_row">
                            <span className="ui_field_label">{labels.cdnEndpoint}</span>
                            <FieldHelpBadge helpText={labels.cdnEndpointHelp} />
                          </span>
                          <input
                            className="ui_input"
                            type="url"
                            value={cdnBaseUrl}
                            readOnly
                          />
                        </div>
                      </div>
                    ) : null}

                    {mode === "deepl" && option.value === "deepl" ? (
                      <div className="ui_choice_fields ui_choice_fields_inline">
                        <div className="ui_field">
                          <span className="operator-field_label_row">
                            <span className="ui_field_label">{labels.deeplKey}</span>
                            <FieldHelpBadge helpText={labels.deeplKeyHelp} />
                          </span>
                          <input
                            className="ui_input"
                            type="text"
                            value={editableDeeplApiKey}
                            onChange={(event) => setEditableDeeplApiKey(event.target.value)}
                          />
                        </div>
                        <div className="ui_field">
                          <span className="operator-field_label_row">
                            <span className="ui_field_label">{labels.deeplEndpoint}</span>
                            <FieldHelpBadge helpText={labels.deeplEndpointHelp} />
                          </span>
                          <input
                            className="ui_input"
                            type="url"
                            value={editableDeeplApiUrl}
                            onChange={(event) => setEditableDeeplApiUrl(event.target.value)}
                          />
                        </div>
                      </div>
                    ) : null}

                                      </div>
                ))}
              </div>
            </div>

            <div className="ui_field">
              <MultiSelectMenu
                label={labels.supportedLocales}
                labelAddon={<FieldHelpBadge helpText={labels.supportedLocalesHelp} />}
                value={selectedLocales}
                options={sourceOptions.map((option) => ({
                  value: option.code,
                  label: lockedLocaleSet.has(option.code)
                    ? `${option.label} · ${labels.localeInUse}`
                    : option.label,
                  disabled: lockedLocaleSet.has(option.code),
                }))}
                placeholder={labels.localeSelectionPlaceholder}
                onChange={(nextLocales) =>
                  setSelectedLocales(
                    Array.from(new Set(["en", ...lockedLocales, ...nextLocales])),
                  )
                }
              />
            </div>

            <div className="ui_settings_switch_stack">
              <div className="ui_card_selectable ui_settings_switch_card">
                <Switch
                  checked={allowPublicReads}
                  className="ui_settings_switch"
                  label={labels.publicReads}
                  hint={labels.publicReadsHint}
                  onChange={(event) => {
                    const nextChecked = event.target.checked;
                    setAllowPublicReads(nextChecked);
                    if (!nextChecked) {
                      setConfirmEnablePublicWrites(false);
                      setAllowPublicWrites(false);
                    }
                  }}
                />
                {allowPublicReads ? (
                  <div className="ui_field ui_settings_switch_field">
                    <span className="operator-field_label_row">
                      <span className="ui_field_label">{labels.publicToken}</span>
                      <FieldHelpBadge helpText={labels.publicTokenHelp} />
                    </span>
                    <input
                      className="ui_input"
                      type="text"
                      value={publicToken}
                      onChange={(event) => setPublicToken(event.target.value)}
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                  </div>
                ) : null}
              </div>

              <div className="ui_card_selectable ui_settings_switch_card" data-disabled={!allowPublicReads ? "true" : "false"}>
                <Switch
                  checked={allowPublicWrites}
                  disabled={!allowPublicReads}
                  className="ui_settings_switch"
                  label={labels.publicWrites}
                  hint={labels.publicWritesHint}
                  onChange={(event) => {
                    if (!allowPublicReads) {
                      return;
                    }
                    if (!event.target.checked) {
                      setConfirmEnablePublicWrites(false);
                      setAllowPublicWrites(false);
                      return;
                    }

                    setConfirmEnablePublicWrites(true);
                  }}
                />
              </div>
            </div>
          </div>

          <div className="ui_form_footer">
            <SubmitButton idleLabel={labels.save} pendingLabel={labels.savePending} />
          </div>
        </form>
      </section>

      {confirmEnablePublicWrites ? (
        <ConfirmDialog
          title={labels.publicWritesWarningTitle}
          description={labels.publicWritesWarningDescription}
          cancelLabel={labels.cancel}
          confirmLabel={labels.publicWritesEnable}
          cancelVariant="primary"
          confirmVariant="secondary"
          defaultAction="cancel"
          onClose={() => setConfirmEnablePublicWrites(false)}
          action={async () => {
            setAllowPublicWrites(true);
            setConfirmEnablePublicWrites(false);
          }}
        />
      ) : null}

      {showCustomSchema ? (
        <div className="ui_overlay" role="presentation" onClick={() => setShowCustomSchema(false)}>
          <div
            className="ui_dialog ui_dialog_panel ui_dialog_panel--wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="operator-custom-schema-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="ui_dialog_header">
              <div className="ui_dialog_heading">
                <p className="ui_section_title" id="operator-custom-schema-title">
                  {labels.customSchemaTitle}
                </p>
              </div>
              <Button
                variant="ghost"
                type="button"
                className="ui_icon_button operator-icon_button ui_dialog_close"
                aria-label={labels.close}
                title={labels.close}
                onClick={() => setShowCustomSchema(false)}
              >
                ×
              </Button>
            </div>

            <p className="ui_section_body ui_dialog_subtitle">{labels.customSchemaIntro}</p>

            <div className="operator-deployment-grid">
              <article className="ui_card ui_card_fill">
                <p className="ui_section_eyebrow">{labels.customSchemaForwardedHeaders}</p>
                <pre className="ui_code_block">
                  <code>{`Content-Type: application/json`}</code>
                </pre>
              </article>

              <article className="ui_card ui_card_fill">
                <p className="ui_section_eyebrow">{labels.customSchemaSingleRequest}</p>
                <pre className="ui_code_block">
                  <code>{`{
  "locale": "de",
  "msg": "Welcome back",
  "ctx": "Web UI label",
  "format": "text",
  "hash": "optional-sha256-hash",
  "sourceLocale": "en"
}`}</code>
                </pre>
              </article>

              <article className="ui_card ui_card_fill">
                <p className="ui_section_eyebrow">{labels.customSchemaBatchRequest}</p>
                <pre className="ui_code_block">
                  <code>{`{
  "locale": "de",
  "msgs": [
    "Welcome back",
    "System overview"
  ],
  "ctx": "Web UI label",
  "format": "text",
  "sourceLocale": "en"
}`}</code>
                </pre>
              </article>

              <article className="ui_card ui_card_fill">
                <p className="ui_section_eyebrow">{labels.customSchemaSingleResponse}</p>
                <pre className="ui_code_block">
                  <code>{`{
  "translation": "Willkommen zurück"
}`}</code>
                </pre>
              </article>

              <article className="ui_card ui_card_fill">
                <p className="ui_section_eyebrow">{labels.customSchemaBatchResponse}</p>
                <pre className="ui_code_block">
                  <code>{`{
  "translations": [
    "Willkommen zurück",
    "Systemübersicht"
  ]
}`}</code>
                </pre>
              </article>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
