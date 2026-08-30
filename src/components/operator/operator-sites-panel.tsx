"use client";

import { useMemo, useState } from "react";

import {
  createOperatorSite,
  deleteOperatorSite,
  deleteOperatorSiteTranslations,
  updateOperatorSite,
} from "@/app/operator/actions";
import type { SiteListRecord } from "@/db/sites";
import type { OperationalMode } from "@/lib/operator-runtime";
import {
  buildApacheConfig,
  buildCustomRuntimeNote,
  buildDockerCompose,
  buildNginxConfig,
  buildSystemdUnit,
  type SiteDeploymentSettings,
} from "@/lib/site-deployment-config";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { MultiSelectMenu } from "@/components/ui/multi-select-menu";
import { NotificationCenter } from "@/components/ui/notification-center";
import { SelectMenu } from "@/components/ui/select-menu";
import { SubmitButton } from "@/components/ui/submit-button";

type OperatorSitesLabels = {
  title: string;
  intro: string;
  createTitle: string;
  createDescription: string;
  settingsTitle: string;
  settingsDescription: string;
  key: string;
  keyHelp: string;
  immutableKeyHint: string;
  name: string;
  nameHelp: string;
  hostname: string;
  hostnameHelp: string;
  publicBaseUrl: string;
  publicBaseUrlHelp: string;
  supportEmail: string;
  supportEmailHelp: string;
  defaultLocale: string;
  defaultLocaleHelp: string;
  availableLocales: string;
  availableLocalesHelp: string;
  localeSelectionPlaceholder: string;
  tableSite: string;
  createSubmit: string;
  createPending: string;
  updateSubmit: string;
  updatePending: string;
  existingTitle: string;
  emptyTitle: string;
  emptyBody: string;
  locales: string;
  deploymentTitle: string;
  dockerCompose: string;
  systemdUnit: string;
  nginxConfig: string;
  apacheConfig: string;
  customRuntime: string;
  actions: string;
  addSite: string;
  deploymentAction: string;
  settingsAction: string;
  deleteTranslationsAction: string;
  deleteTranslationsDescription: string;
  deleteTranslationsLocale: string;
  deleteTranslationsConfirmTitle: string;
  deleteTranslationsNoLocales: string;
  deleteTranslationsPending: string;
  deleteTranslationsSuccess: string;
  deleteTranslationsTitle: string;
  deleteTranslationsConfirm: string;
  cancel: string;
  deleteAction: string;
  deletePending: string;
  deleteTitle: string;
  deleteConfirm: string;
  close: string;
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

function FieldLabelWithHelp({
  label,
  helpText,
}: {
  label: string;
  helpText: string;
}) {
  return (
    <span className="operator-field_label_row">
      <span className="ui_field_label">{label}</span>
      <FieldHelpBadge helpText={helpText} />
    </span>
  );
}

function formatLocales(site: SiteListRecord) {
  return site.availableLocales.map((entry) => entry.code.toUpperCase()).join(", ");
}

function buildDeploymentBlocks(
  site: SiteListRecord,
  mode: OperationalMode,
  labels: OperatorSitesLabels,
  siteSettings: SiteDeploymentSettings,
) {
  if (mode === "docker") {
    return [
      { title: labels.dockerCompose, code: buildDockerCompose(site, siteSettings) },
      { title: labels.nginxConfig, code: buildNginxConfig(site, siteSettings) },
    ];
  }

  if (mode === "systemd") {
    return [
      { title: labels.systemdUnit, code: buildSystemdUnit(site, siteSettings) },
      { title: labels.nginxConfig, code: buildNginxConfig(site, siteSettings) },
    ];
  }

  return [
    { title: labels.customRuntime, code: buildCustomRuntimeNote(site, siteSettings) },
    { title: labels.nginxConfig, code: buildNginxConfig(site, siteSettings) },
    { title: labels.apacheConfig, code: buildApacheConfig(site, siteSettings) },
  ];
}

function SiteEditorModal({
  mode,
  site,
  labels,
  allowedLocales,
  error,
  onClose,
}: {
  mode: "create" | "settings";
  site?: SiteListRecord | null;
  labels: OperatorSitesLabels;
  allowedLocales: string[];
  error: string | null;
  onClose: () => void;
}) {
  const isSettings = mode === "settings" && Boolean(site);
  const [defaultLocale, setDefaultLocale] = useState(
    site?.defaultLocale ?? allowedLocales[0] ?? "en",
  );
  const [selectedLocales, setSelectedLocales] = useState<string[]>(
    site?.availableLocales.map((entry) => entry.code) ??
      Array.from(new Set([site?.defaultLocale ?? allowedLocales[0] ?? "en", ...allowedLocales])),
  );
  const title = isSettings ? labels.settingsTitle : labels.createTitle;
  const description = isSettings ? labels.settingsDescription : labels.createDescription;
  const formAction = isSettings ? updateOperatorSite : createOperatorSite;
  const idleLabel = isSettings ? labels.updateSubmit : labels.createSubmit;
  const pendingLabel = isSettings ? labels.updatePending : labels.createPending;
  const dialogId = isSettings
    ? `operator-site-settings-title-${site!.id}`
    : "operator-create-site-title";

  return (
    <div className="ui_overlay" role="presentation" onClick={onClose}>
      <div
        className="ui_dialog ui_dialog_panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={dialogId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ui_dialog_header">
          <div className="ui_dialog_heading">
            <p className="ui_section_title" id={dialogId}>
              {title}
            </p>
          </div>
          <Button
            variant="ghost"
            type="button"
            className="ui_icon_button operator-icon_button ui_dialog_close"
            aria-label={labels.close}
            title={labels.close}
            onClick={onClose}
          >
            ×
          </Button>
        </div>

        <p className="ui_section_body ui_dialog_subtitle">{description}</p>
        {error ? <p className="ui_notice_inline_error">{error}</p> : null}

        <form className="ui_form" action={formAction}>
          {isSettings ? <input type="hidden" name="siteId" value={site!.id} /> : null}
          {Array.from(new Set([defaultLocale, ...selectedLocales])).map((locale) => (
            <input key={locale} type="hidden" name="siteAvailableLocales" value={locale} />
          ))}

          <div className="ui_form_grid">
            <label className="ui_field">
              <FieldLabelWithHelp label={labels.key} helpText={labels.keyHelp} />
              <input
                className="ui_input"
                type="text"
                name="siteKey"
                defaultValue={site?.key ?? ""}
                required
                readOnly={isSettings}
                disabled={isSettings}
              />
            </label>
            <label className="ui_field">
              <FieldLabelWithHelp label={labels.name} helpText={labels.nameHelp} />
              <input
                className="ui_input"
                type="text"
                name="siteName"
                defaultValue={site?.name ?? ""}
                required
              />
            </label>
          </div>

          <div className="ui_form_grid">
            <div className="ui_field">
              <input type="hidden" name="siteDefaultLocale" value={defaultLocale} />
              {isSettings ? (
                <>
                  <FieldLabelWithHelp
                    label={labels.defaultLocale}
                    helpText={labels.defaultLocaleHelp}
                  />
                  <input
                    className="ui_input"
                    type="text"
                    value={defaultLocale.toUpperCase()}
                    readOnly
                    disabled
                  />
                </>
              ) : (
                <SelectMenu
                  label={labels.defaultLocale}
                  labelAddon={<FieldHelpBadge helpText={labels.defaultLocaleHelp} />}
                  value={defaultLocale}
                  options={allowedLocales.map((locale) => ({
                    value: locale,
                    label: locale.toUpperCase(),
                  }))}
                  onChange={(nextLocale) => {
                    setDefaultLocale(nextLocale);
                    setSelectedLocales((current) =>
                      Array.from(new Set([nextLocale, ...current])),
                    );
                  }}
                />
              )}
            </div>
            <div className="ui_field">
              <MultiSelectMenu
                label={labels.availableLocales}
                labelAddon={<FieldHelpBadge helpText={labels.availableLocalesHelp} />}
                value={Array.from(new Set([defaultLocale, ...selectedLocales]))}
                options={allowedLocales.map((locale) => ({
                  value: locale,
                  label: locale.toUpperCase(),
                }))}
                placeholder={labels.localeSelectionPlaceholder}
                onChange={(nextLocales) => {
                  setSelectedLocales(Array.from(new Set([defaultLocale, ...nextLocales])));
                }}
              />
            </div>
          </div>

          <div className="ui_form_grid">
            <label className="ui_field">
              <FieldLabelWithHelp label={labels.hostname} helpText={labels.hostnameHelp} />
              <input
                className="ui_input"
                type="text"
                name="siteHostname"
                defaultValue={site?.hostname ?? ""}
                required
              />
            </label>
            <label className="ui_field">
              <FieldLabelWithHelp
                label={labels.publicBaseUrl}
                helpText={labels.publicBaseUrlHelp}
              />
              <input
                className="ui_input"
                type="url"
                name="siteBaseUrl"
                defaultValue={site?.publicBaseUrl ?? ""}
                required
              />
            </label>
          </div>

          <div className="ui_form_grid">
            <label className="ui_field">
              <FieldLabelWithHelp
                label={labels.supportEmail}
                helpText={labels.supportEmailHelp}
              />
              <input
                className="ui_input"
                type="email"
                name="siteSupportEmail"
                defaultValue={site?.supportEmail ?? ""}
                required
              />
            </label>
          </div>

          <div className="ui_form_footer">
            <SubmitButton idleLabel={idleLabel} pendingLabel={pendingLabel} />
          </div>
        </form>
      </div>
    </div>
  );
}

function DeploymentModal({
  site,
  labels,
  mode,
  siteSettings,
  onClose,
}: {
  site: SiteListRecord;
  labels: OperatorSitesLabels;
  mode: OperationalMode;
  siteSettings: SiteDeploymentSettings;
  onClose: () => void;
}) {
  const blocks = buildDeploymentBlocks(site, mode, labels, siteSettings);

  return (
    <div className="ui_overlay" role="presentation" onClick={onClose}>
      <div
        className="ui_dialog ui_dialog_panel ui_dialog_panel--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`operator-site-deployment-${site.id}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ui_dialog_header">
          <div className="ui_dialog_heading">
            <p className="ui_section_title" id={`operator-site-deployment-${site.id}`}>
              {site.name}
            </p>
          </div>
          <Button
            variant="ghost"
            type="button"
            className="ui_icon_button operator-icon_button ui_dialog_close"
            aria-label={labels.close}
            title={labels.close}
            onClick={onClose}
          >
            ×
          </Button>
        </div>

        <p className="ui_section_body ui_dialog_subtitle">{site.publicBaseUrl}</p>
        <div className="operator-deployment-grid">
          {blocks.map((block) => (
            <article key={block.title} className="ui_card ui_card_fill">
              <p className="ui_section_eyebrow">{block.title}</p>
              <pre className="ui_code_block">
                <code>{block.code}</code>
              </pre>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

function DeleteSiteTranslationsModal({
  site,
  labels,
  onClose,
}: {
  site: SiteListRecord;
  labels: OperatorSitesLabels;
  onClose: () => void;
}) {
  const localeOptions = site.availableLocales
    .filter((entry) => entry.code !== site.defaultLocale)
    .map((entry) => ({
      value: entry.code,
      label: entry.label,
    }));
  const [selectedLocale, setSelectedLocale] = useState(localeOptions[0]?.value ?? "");
  const [showConfirm, setShowConfirm] = useState(false);

  return (
    <>
      <div className="ui_overlay" role="presentation" onClick={onClose}>
        <div
          className="ui_dialog ui_dialog_panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`operator-site-delete-translations-${site.id}`}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="ui_dialog_header">
            <div className="ui_dialog_heading">
              <p className="ui_section_title" id={`operator-site-delete-translations-${site.id}`}>
                {labels.deleteTranslationsTitle}
              </p>
            </div>
            <Button
              variant="ghost"
              type="button"
              className="ui_icon_button operator-icon_button ui_dialog_close"
              aria-label={labels.close}
              title={labels.close}
              onClick={onClose}
            >
              ×
            </Button>
          </div>

          <p className="ui_section_body ui_dialog_subtitle">{site.name}</p>

          {localeOptions.length > 0 ? (
            <div className="ui_form">
              <div className="ui_field">
                <SelectMenu
                  label={labels.deleteTranslationsLocale}
                  value={selectedLocale}
                  options={localeOptions}
                  onChange={setSelectedLocale}
                />
              </div>
            </div>
          ) : (
            <p className="ui_notice_inline_error">{labels.deleteTranslationsNoLocales}</p>
          )}

          <p className="ui_section_body">{labels.deleteTranslationsDescription}</p>

          <div className="ui_dialog_footer">
            <Button variant="secondary" type="button" onClick={onClose}>
              {labels.cancel}
            </Button>
            <Button
              variant="secondary"
              type="button"
              onClick={() => setShowConfirm(true)}
              disabled={!selectedLocale}
            >
              {labels.deleteTranslationsAction}
            </Button>
          </div>
        </div>
      </div>

      {showConfirm && selectedLocale ? (
        <ConfirmDialog
          title={labels.deleteTranslationsConfirmTitle}
          description={`${site.name} · ${selectedLocale.toUpperCase()}: ${labels.deleteTranslationsConfirm}`}
          cancelLabel={labels.cancel}
          confirmLabel={labels.deleteTranslationsAction}
          confirmPendingLabel={labels.deleteTranslationsPending}
          defaultAction="cancel"
          action={deleteOperatorSiteTranslations}
          fields={{ siteId: site.id, locale: selectedLocale }}
          onClose={() => setShowConfirm(false)}
        />
      ) : null}
    </>
  );
}

export function OperatorSitesPanel({
  labels,
  sites,
  mode,
  allowedLocales,
  siteSettings,
  error,
  initialAction,
  initialSiteId,
  notificationMessage,
  notificationMode,
  notificationId,
  deletedTranslationsLocale,
}: {
  labels: OperatorSitesLabels;
  sites: SiteListRecord[];
  mode: OperationalMode;
  allowedLocales: string[];
  siteSettings: SiteDeploymentSettings;
  error: string | null;
  initialAction: "create" | "settings" | null;
  initialSiteId: number;
  notificationMessage: string | null;
  notificationMode: "success" | "warning" | "error" | null;
  notificationId: string | null;
  deletedTranslationsLocale: string | null;
}) {
  const [showCreateModal, setShowCreateModal] = useState(initialAction === "create");
  const [deploymentSiteId, setDeploymentSiteId] = useState<number | null>(null);
  const [settingsSiteId, setSettingsSiteId] = useState<number | null>(
    initialAction === "settings" && initialSiteId > 0 ? initialSiteId : null,
  );
  const [deleteTranslationsSiteId, setDeleteTranslationsSiteId] = useState<number | null>(null);
  const [deleteSiteId, setDeleteSiteId] = useState<number | null>(null);

  const selectedSite = useMemo(
    () => sites.find((site) => site.id === deploymentSiteId) ?? null,
    [deploymentSiteId, sites],
  );
  const settingsSite = useMemo(
    () => sites.find((site) => site.id === settingsSiteId) ?? null,
    [settingsSiteId, sites],
  );
  const deleteSiteRecord = useMemo(
    () => sites.find((site) => site.id === deleteSiteId) ?? null,
    [deleteSiteId, sites],
  );
  const deleteTranslationsSiteRecord = useMemo(
    () => sites.find((site) => site.id === deleteTranslationsSiteId) ?? null,
    [deleteTranslationsSiteId, sites],
  );
  const notifications = [
    ...(notificationMessage && notificationMode && notificationId
      ? [
          {
            id: `sites-${notificationMode}-${notificationId}`,
            mode: notificationMode,
            message: notificationMessage,
          },
        ]
      : []),
    ...(deletedTranslationsLocale && notificationId
      ? [
          {
            id: `sites-delete-translations-success-${notificationId}`,
            mode: "success" as const,
            message: `${labels.deleteTranslationsSuccess} ${deletedTranslationsLocale.toUpperCase()}.`,
          },
        ]
      : []),
  ];

  return (
    <div className="operator-overview">
      <NotificationCenter items={notifications} />
      <section className="ui_card">
        <div className="ui_section_header_inline">
          <div>
            <p className="ui_section_title">{labels.title}</p>
          </div>
          <Button variant="secondary" type="button" onClick={() => setShowCreateModal(true)}>
            {labels.addSite}
          </Button>
        </div>
        <p className="ui_section_body">{labels.intro}</p>
        {error && !showCreateModal && !settingsSite ? (
          <p className="ui_notice_inline_error">{error}</p>
        ) : null}

        {sites.length === 0 ? (
          <p className="ui_section_body">{labels.emptyBody}</p>
        ) : (
          <div className="ui_table_wrap">
            <table className="ui_table">
              <thead>
                <tr>
                  <th>{labels.tableSite}</th>
                  <th>{labels.publicBaseUrl}</th>
                  <th>{labels.locales}</th>
                  <th>{labels.actions}</th>
                </tr>
              </thead>
              <tbody>
                {sites.map((site) => (
                  <tr key={site.id}>
                    <td>
                      <div className="ui_table_cell_stack">
                        <span className="ui_table_primary">{site.name}</span>
                        <span className="ui_table_secondary">{site.key}</span>
                      </div>
                    </td>
                    <td>
                      <div className="ui_table_cell_stack">
                        <span className="ui_table_primary">{site.hostname}</span>
                        <span className="ui_table_secondary">{site.publicBaseUrl}</span>
                      </div>
                    </td>
                    <td>{formatLocales(site)}</td>
                    <td className="ui_table_actions">
                      <div className="ui_table_action_row">
                        <Button
                          variant="secondary"
                          type="button"
                          className="ui_icon_button operator-icon_button"
                          aria-label={labels.settingsAction}
                          title={labels.settingsAction}
                          onClick={() => setSettingsSiteId(site.id)}
                        >
                          ⚙
                        </Button>
                        <Button
                          variant="secondary"
                          type="button"
                          className="ui_icon_button operator-icon_button"
                          aria-label={labels.deploymentAction}
                          title={labels.deploymentAction}
                          onClick={() => setDeploymentSiteId(site.id)}
                        >
                          ☰
                        </Button>
                        <Button
                          variant="secondary"
                          type="button"
                          className="ui_icon_button operator-icon_button operator-icon_button--locale"
                          aria-label={labels.deleteTranslationsAction}
                          title={labels.deleteTranslationsAction}
                          onClick={() => setDeleteTranslationsSiteId(site.id)}
                        >
                          文
                        </Button>
                        <Button
                          variant="secondary"
                          type="button"
                          className="ui_icon_button operator-icon_button operator-icon_button--danger operator-icon_button--danger-compact"
                          aria-label={labels.deleteAction}
                          title={labels.deleteAction}
                          onClick={() => setDeleteSiteId(site.id)}
                        >
                          🗑
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {showCreateModal ? (
        <SiteEditorModal
          mode="create"
          labels={labels}
          allowedLocales={allowedLocales}
          error={error}
          onClose={() => setShowCreateModal(false)}
        />
      ) : null}

      {selectedSite ? (
        <DeploymentModal
          site={selectedSite}
          labels={labels}
          mode={mode}
          siteSettings={siteSettings}
          onClose={() => setDeploymentSiteId(null)}
        />
      ) : null}

      {deleteSiteRecord ? (
        <ConfirmDialog
          title={labels.deleteTitle}
          description={`${deleteSiteRecord.name}: ${labels.deleteConfirm}`}
          cancelLabel={labels.cancel}
          confirmLabel={labels.deleteAction}
          confirmPendingLabel={labels.deletePending}
          defaultAction="cancel"
          action={deleteOperatorSite}
          fields={{ siteId: deleteSiteRecord.id }}
          onClose={() => setDeleteSiteId(null)}
        />
      ) : null}

      {deleteTranslationsSiteRecord ? (
        <DeleteSiteTranslationsModal
          site={deleteTranslationsSiteRecord}
          labels={labels}
          onClose={() => setDeleteTranslationsSiteId(null)}
        />
      ) : null}

      {settingsSite ? (
        <SiteEditorModal
          mode="settings"
          site={settingsSite}
          labels={labels}
          allowedLocales={allowedLocales}
          error={initialAction === "settings" ? error : null}
          onClose={() => setSettingsSiteId(null)}
        />
      ) : null}
    </div>
  );
}
