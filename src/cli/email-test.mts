import { readMergedPhiConfigSync } from "../lib/config-files-cli.ts";
import {
  describePhiMailDeliveryReport,
  sendPhiTestEmail,
  type PhiEmailTestResult,
  type PhiSiteMailSender,
} from "../lib/email-test.ts";

/**
 * `phis email test --to <address> [--site <key>]`: one message through the configured SMTP targets, by
 * the same transport the server sends with (`src/lib/email-transport.ts`), read from this stage's merged
 * configuration. With a Site, its own sender (`mail_from`, `mail_from_name`) replaces `email.from`, as it
 * does for every message of that Site.
 *
 * The Site lookup comes in as a function, so `phis install` can send one before the CLI has a pool.
 */
export async function runPhiEmailTest(
  configRoot: string,
  input: { to: string; siteKey: string | null },
  readSiteSender: (siteKey: string) => Promise<PhiSiteMailSender | null>,
): Promise<PhiEmailTestResult> {
  let site: { key: string; sender: PhiSiteMailSender } | null = null;
  if (input.siteKey) {
    const sender = await readSiteSender(input.siteKey);
    if (!sender) throw new Error(`No Site ${input.siteKey}.`);
    site = { key: input.siteKey, sender };
  }
  return sendPhiTestEmail({
    root: configRoot,
    emailConfig: readMergedPhiConfigSync(configRoot).email,
    to: input.to,
    site,
    via: "cli",
  });
}

export function printPhiEmailTestResult(result: PhiEmailTestResult, indent = "") {
  const { report } = result;
  console.log(`${indent}From ${report.from} to ${report.to}:`);
  for (const line of describePhiMailDeliveryReport(report)) console.log(`${indent}  ${line}`);
  console.log(report.accepted
    ? `${indent}Accepted by ${report.accepted.target}; recorded in ${result.recordPath}.`
    : `${indent}No target accepted the message.`);
}
