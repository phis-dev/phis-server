import Link from "next/link";

import type { BootstrapLocale, BootstrapMessages } from "@/bootstrap/i18n";
import { SiteCreationForm } from "@/components/bootstrap/site-creation-form";
import { readPhiBootstrapSites } from "@/db/bootstrap";
import { readMergedPhiConfigSync, readPhiRuntimeConfigSync } from "@/lib/config-files";

export async function SiteSetupPanel({
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
  const mergedConfig = readMergedPhiConfigSync();
  const sites = await readPhiBootstrapSites(runtimeConfig.database?.uri);
  const hasSites = sites.length > 0;
  const allowedLocales =
    (
      mergedConfig.translation?.supportedLocales ??
      mergedConfig.translation?.allowedLocales ??
      ["en"]
    ).filter((value) => value.trim());

  return (
    <div className="ui_section_stack">
      <section className="ui_card">
        {hasSites ? (
          <>
            <p className="ui_section_body">{messages.siteExistingDescription}</p>
            <p className="ui_section_title">{messages.siteCurrentLabel}</p>
            <div className="ui_stack_list">
              {sites.map((site) => (
                <article key={site.key} className="ui_card_soft ui_meta_card">
                  <div className="ui_meta_row">
                    <div className="ui_meta_identity">
                      <p className="ui_meta_title">{site.name}</p>
                      <p className="ui_meta_subtitle">{site.publicBaseUrl}</p>
                    </div>
                    <p className="ui_meta_status">{site.hostname}</p>
                  </div>
                </article>
              ))}
            </div>

            <div className="ui_form_footer">
              <Link
                href={nextStepHref}
                className="ui_button ui_control ui_control_pill ui_button-primary"
              >
                <span className="ui_button_label">{messages.siteContinueLabel}</span>
              </Link>
            </div>
          </>
        ) : (
          <SiteCreationForm
            locale={locale}
            messages={messages}
            nextStepHref={nextStepHref}
            allowedLocales={allowedLocales}
            error={error}
          />
        )}
      </section>

      <section className="ui_card ui_card_accent">
        <p className="ui_section_eyebrow">{messages.continueLabel}</p>
        <p className="ui_section_title">{messages.steps.site.goodToKnowTitle}</p>
        <p className="ui_section_body">
          {messages.steps.site.goodToKnowBodyBeforeLink}
        </p>
      </section>
    </div>
  );
}
