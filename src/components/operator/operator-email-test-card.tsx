"use client";

import { useActionState } from "react";

import {
  sendOperatorTestEmail,
  type OperatorTestEmailState,
} from "@/app/(operator)/operator/email-actions";
import { SubmitButton } from "@/components/ui/submit-button";
import type { PhiEmailTestRecord } from "@/lib/email-test-record";

export type OperatorEmailTestLabels = {
  emailTitle: string;
  emailIntro: string;
  emailFrom: string;
  emailTargets: string;
  emailTargetsNone: string;
  emailTls: string;
  emailTestRecipient: string;
  emailTestSite: string;
  emailTestSiteNone: string;
  emailTestSend: string;
  emailTestPending: string;
  emailTestAccepted: string;
  emailTestFailed: string;
  emailTestNoneAccepted: string;
  emailTestLast: string;
  emailTestNever: string;
};

type OperatorEmailTestCardProps = {
  labels: OperatorEmailTestLabels;
  email: {
    from: string;
    targets: string[];
    secure: boolean;
    ignoreTls: boolean;
  };
  operatorEmail: string;
  sites: Array<{ key: string; name: string }>;
  lastTest: PhiEmailTestRecord | null;
};

const INITIAL_STATE: OperatorTestEmailState = { error: null, report: null, record: null };

function describeRecord(record: PhiEmailTestRecord) {
  const site = record.siteKey ? ` (${record.siteKey})` : "";
  const queue = record.queueId ? ` · ${record.queueId}` : "";
  return `${record.sentAt} → ${record.to}${site} · ${record.target}${queue}`;
}

/**
 * The stage's mail settings as the server sends with them, and "Send test email" through exactly that
 * path. Each target's outcome is listed: the one that accepted with its answer and queue id, and before
 * it, what failed where.
 */
export function OperatorEmailTestCard({ labels, email, operatorEmail, sites, lastTest }: OperatorEmailTestCardProps) {
  const [state, formAction] = useActionState(sendOperatorTestEmail, INITIAL_STATE);
  const last = state.record ?? lastTest;

  return (
    <section className="ui_card">
      <p className="ui_section_eyebrow">{labels.emailTitle}</p>
      <p className="ui_section_body">{labels.emailIntro}</p>
      <ul className="ui_list">
        <li>
          <strong>{labels.emailFrom}:</strong> {email.from}
        </li>
        <li>
          <strong>{labels.emailTargets}:</strong>{" "}
          {email.targets.length > 0 ? email.targets.join(", ") : labels.emailTargetsNone}
        </li>
        <li>
          <strong>{labels.emailTls}:</strong> secure={String(email.secure)} · ignoreTls={String(email.ignoreTls)}
        </li>
        <li>
          <strong>{labels.emailTestLast}:</strong> {last ? describeRecord(last) : labels.emailTestNever}
        </li>
      </ul>

      <form className="ui_form" action={formAction}>
        <label className="ui_field">
          <span className="ui_field_label">{labels.emailTestRecipient}</span>
          <input className="ui_input" type="email" name="to" defaultValue={operatorEmail} required />
        </label>
        {sites.length > 0 ? (
          <label className="ui_field">
            <span className="ui_field_label">{labels.emailTestSite}</span>
            <select className="ui_input" name="siteKey" defaultValue="">
              <option value="">{labels.emailTestSiteNone}</option>
              {sites.map((site) => (
                <option key={site.key} value={site.key}>
                  {`${site.name} (${site.key})`}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="ui_form_footer">
          <SubmitButton idleLabel={labels.emailTestSend} pendingLabel={labels.emailTestPending} />
        </div>
      </form>

      {state.error ? <p className="ui_notice_inline_error">{state.error}</p> : null}
      {state.report ? (
        <>
          <ul className="ui_list" aria-live="polite">
            {state.report.attempts.map((attempt, index) => (
              <li key={`${index}-${attempt.target}`}>
                <strong>{attempt.target}:</strong>{" "}
                {attempt.ok
                  ? `${labels.emailTestAccepted} -- ${attempt.response}${attempt.queueId ? ` (${attempt.queueId})` : ""}`
                  : `${labels.emailTestFailed} (${attempt.stage}) -- ${attempt.error}`}
              </li>
            ))}
          </ul>
          {state.report.accepted ? null : (
            <p className="ui_notice_inline_error">{labels.emailTestNoneAccepted}</p>
          )}
        </>
      ) : null}
    </section>
  );
}
