/**
 * One test email by the path every server message takes (`src/lib/email-transport.ts`), with every
 * target's outcome, and the record of it when one target accepted it.
 *
 * Shared by `phis email test` (src/cli/email-test.mts) and the operator's "Send test email"; each resolves
 * the configuration and the Site's sender its own way and hands them in. Node built-ins, nodemailer and
 * relative imports only.
 */

import os from "node:os";

import {
  buildPhiTestEmail,
  buildPhiEmailTestRecord,
  writePhiEmailTestRecord,
  type PhiEmailTestRecord,
} from "./email-test-record.ts";
import {
  attemptPhiMailDelivery,
  buildPhiMailFromHeader,
  type PhiEmailConfig,
  type PhiMailDeliveryReport,
} from "./email-transport.ts";

export type PhiSiteMailSender = { mailFrom: string; mailFromName: string };

/** A Site's sender as the notification drain writes it (`src/lib/notifications/deliver.ts`). */
export function formatPhiSiteMailSender(sender: PhiSiteMailSender) {
  return `${sender.mailFromName} <${sender.mailFrom}>`;
}

export function assertPhiTestEmailAddress(value: string) {
  const address = value.trim().toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+$/u.test(address)) {
    throw new Error(`"${value}" is no email address to send a test to.`);
  }
  return address;
}

export type PhiEmailTestResult = {
  report: PhiMailDeliveryReport;
  siteKey: string | null;
  /** The record written when a target accepted the message, and where it is. */
  record: PhiEmailTestRecord | null;
  recordPath: string | null;
};

export async function sendPhiTestEmail(input: {
  root: string;
  emailConfig: PhiEmailConfig;
  to: string;
  site: { key: string; sender: PhiSiteMailSender } | null;
  via: PhiEmailTestRecord["via"];
  now?: () => Date;
}): Promise<PhiEmailTestResult> {
  const to = assertPhiTestEmailAddress(input.to);
  const siteKey = input.site?.key ?? null;
  const from = input.site ? formatPhiSiteMailSender(input.site.sender) : buildPhiMailFromHeader(input.emailConfig);
  const report = await attemptPhiMailDelivery(
    buildPhiTestEmail({ to, from, siteKey, via: input.via, host: os.hostname() }),
    input.emailConfig,
  );
  const record = buildPhiEmailTestRecord(report, { siteKey, via: input.via }, input.now?.() ?? new Date());
  const recordPath = record ? writePhiEmailTestRecord(input.root, record) : null;
  return { report, siteKey, record, recordPath };
}

/** The report as lines: the accepted target with its answer, and what failed at each one before it. */
export function describePhiMailDeliveryReport(report: PhiMailDeliveryReport) {
  const lines: string[] = [];
  if (report.attempts.length === 0) {
    lines.push("No SMTP target is configured (email.smtp.targets).");
  }
  for (const attempt of report.attempts) {
    if (attempt.ok) {
      const queue = attempt.queueId ? `, queue id ${attempt.queueId}` : "";
      lines.push(`${attempt.target}: accepted -- ${attempt.response || "(no answer text)"}${queue}`);
    } else {
      lines.push(`${attempt.target}: failed at ${attempt.stage} -- ${attempt.error}`);
    }
  }
  return lines;
}
