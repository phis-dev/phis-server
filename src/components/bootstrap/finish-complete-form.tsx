"use client";

import { useState } from "react";

import { completeBootstrapSetup } from "@/app/setup/actions";
import type { BootstrapLocale, BootstrapMessages } from "@/bootstrap/i18n";
import { Checkbox } from "@/components/ui/checkbox";
import { SubmitButton } from "@/components/ui/submit-button";

export function FinishCompleteForm({
  locale,
  messages,
}: {
  locale: BootstrapLocale;
  messages: BootstrapMessages;
}) {
  const [acceptedTerms, setAcceptedTerms] = useState(false);

  return (
    <form className="ui_form" action={completeBootstrapSetup.bind(null, locale)}>
      <div className="ui_field">
        <span className="ui_text_title">{messages.finishTermsLabel}</span>
        <span className="ui_text_body ui_text_muted">{messages.finishTermsBody}</span>
      </div>

      <Checkbox
        name="acceptedTerms"
        checked={acceptedTerms}
        onChange={(event) => setAcceptedTerms(event.target.checked)}
        label={messages.finishTermsAcceptLabel}
      />

      <div className="ui_form_footer">
        <SubmitButton
          idleLabel={messages.finishCompleteLabel}
          pendingLabel={messages.finishCompletingLabel}
          disabled={!acceptedTerms}
        />
      </div>
    </form>
  );
}
