/**
 * The stage's last successful test email, `config/phis-email-test.json`.
 *
 * `phis email test` and the operator's "Send test email" write it when a target accepted the message;
 * `phis setup status` reads it. Node built-ins and relative imports only, so the CLI bundle and the Next
 * server can both load it.
 */

import { chownSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { PhiMailDeliveryReport } from "./email-transport.ts";

export type PhiEmailTestRecord = {
  version: 1;
  sentAt: string;
  to: string;
  from: string;
  /** The Site whose sender was used, or null for `email.from`. */
  siteKey: string | null;
  /** `host:port` of the target that accepted the message. */
  target: string;
  response: string;
  queueId: string | null;
  /** Who sent it: the CLI, or the operator UI. */
  via: "cli" | "operator";
};

export function resolvePhiEmailTestRecordPath(root: string) {
  return path.join(/* turbopackIgnore: true */ root, "config", "phis-email-test.json");
}

export function readPhiEmailTestRecord(root: string): PhiEmailTestRecord | null {
  const file = resolvePhiEmailTestRecordPath(root);
  if (!existsSync(file)) return null;
  const value = JSON.parse(readFileSync(file, "utf8")) as Partial<PhiEmailTestRecord>;
  if (value.version !== 1 || typeof value.sentAt !== "string" || typeof value.to !== "string" || typeof value.target !== "string") {
    throw new Error(`${file} is not an email test record this release reads.`);
  }
  return value as PhiEmailTestRecord;
}

export function buildPhiEmailTestRecord(
  report: PhiMailDeliveryReport,
  input: { siteKey: string | null; via: PhiEmailTestRecord["via"] },
  now = new Date(),
): PhiEmailTestRecord | null {
  if (!report.accepted) return null;
  return {
    version: 1,
    sentAt: now.toISOString(),
    to: report.to,
    from: report.from,
    siteKey: input.siteKey,
    target: report.accepted.target,
    response: report.accepted.response,
    queueId: report.accepted.queueId,
    via: input.via,
  };
}

/**
 * Written as the runtime configuration is: a temporary file beside it, handed to the owner of `config/`
 * when root writes it, then renamed over the old one.
 */
export function writePhiEmailTestRecord(root: string, record: PhiEmailTestRecord) {
  const file = resolvePhiEmailTestRecordPath(root);
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true });
  const tempPath = `${file}.tmp`;
  rmSync(tempPath, { force: true });
  writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf-8", mode: 0o644 });
  if (process.getuid?.() === 0) {
    const owner = statSync(directory);
    chownSync(tempPath, owner.uid, owner.gid);
  }
  renameSync(tempPath, file);
  return file;
}

/** One line for `phis setup status` and the operator panel. */
export function describePhiEmailTestRecord(record: PhiEmailTestRecord | null) {
  if (!record) return "no test email sent yet (phis email test --to <address>)";
  const site = record.siteKey ? ` as Site ${record.siteKey}` : "";
  const queue = record.queueId ? `, queued as ${record.queueId}` : "";
  return `last test ${record.sentAt} to ${record.to}${site}, accepted by ${record.target}${queue}`;
}

/** The short message a test sends: says what it is and where it came from, nothing a Site would say. */
export function buildPhiTestEmail(input: { to: string; from: string; siteKey: string | null; via: PhiEmailTestRecord["via"]; host: string }) {
  const sender = input.siteKey ? `the sender of Site ${input.siteKey}` : "email.from";
  const by = input.via === "cli" ? "phis email test" : "the operator console";
  return {
    to: input.to,
    from: input.from,
    subject: "phis test email",
    text: [
      `This is a test message from phis on ${input.host}, sent by ${by}.`,
      "",
      `It went through the configured SMTP targets with ${sender} (${input.from}).`,
      "If it arrived, outgoing mail works; nothing needs to be done with it.",
    ].join("\n"),
  };
}
