/**
 * The one way phis hands a message to SMTP: `email.from`/`fromName`, `email.smtp.targets` in order, and
 * `secure`/`ignoreTls`/`tlsRejectUnauthorized` for each connection.
 *
 * `src/lib/email.ts` sends every server message through `sendPhiMail` with the cached configuration;
 * `phis email test` and the operator's "Send test email" go through `attemptPhiMailDelivery`, which tries
 * the same targets the same way and reports every attempt instead of only the last error. The
 * configuration is passed in rather than read here, so the CLI bundle and the Next server can both load
 * this file: Node built-ins, nodemailer and relative imports only.
 */

import nodemailer from "nodemailer";

import type { PhisConfig } from "./config-core.ts";

const DEFAULT_SMTP_HOST = "127.0.0.1";
const DEFAULT_SMTP_HOSTS = `${DEFAULT_SMTP_HOST}:25`;
const DEFAULT_SMTP_PORT = 25;

export type PhiEmailConfig = PhisConfig["email"];

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from?: string;
  replyTo?: string;
  /**
   * Headers beyond the six above, for the ones a message is required to carry rather than chooses to.
   *
   * `List-Unsubscribe` and `List-Unsubscribe-Post` are why this exists: a circular without them is filed
   * as spam by the large providers whatever it says, and RFC 8058 one-click needs both. Nothing here
   * decides how a Site speaks -- a caller wanting a different sender or reply address has fields for
   * those.
   */
  headers?: Record<string, string>;
};

export type PhiSmtpTarget = {
  host: string;
  port: number;
};

function isLocalHost(host: string) {
  return host === "127.0.0.1" || host === "localhost";
}

function parseSmtpTargets(targets: string, fallbackPort: number): PhiSmtpTarget[] {
  return targets
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((entry) => {
      const lastColon = entry.lastIndexOf(":");
      if (lastColon > -1) {
        const host = entry.slice(0, lastColon).trim();
        const port = Number(entry.slice(lastColon + 1));
        if (host && Number.isFinite(port) && port > 0) {
          return { host, port: Math.trunc(port) };
        }
      }

      return { host: entry, port: fallbackPort };
    });
}

/** The targets in the order they are tried; 127.0.0.1:25 when none are configured. */
export function resolvePhiSmtpTargets(emailConfig: PhiEmailConfig): PhiSmtpTarget[] {
  const smtpTargets = emailConfig?.smtp?.targets ?? [DEFAULT_SMTP_HOSTS];
  return parseSmtpTargets(smtpTargets.join(","), DEFAULT_SMTP_PORT);
}

export function formatPhiSmtpTarget(target: PhiSmtpTarget) {
  return `${target.host}:${target.port}`;
}

function createMailTransport(target: PhiSmtpTarget, emailConfig: PhiEmailConfig) {
  const smtpConfig = emailConfig?.smtp;
  const secure = smtpConfig?.secure === true;
  const ignoreTLS = smtpConfig?.ignoreTls === true;
  const rejectUnauthorized =
    smtpConfig?.tlsRejectUnauthorized === undefined
      ? !isLocalHost(target.host)
      : smtpConfig.tlsRejectUnauthorized !== false;

  return nodemailer.createTransport({
    host: target.host,
    port: target.port,
    secure,
    ignoreTLS: ignoreTLS,
    tls: {
      rejectUnauthorized,
    },
  });
}

/** The sender a message gets when its caller names none: `email.fromName <email.from>`. */
export function buildPhiMailFromHeader(emailConfig: PhiEmailConfig) {
  const configuredFrom = emailConfig?.from?.trim();
  const senderName = emailConfig?.fromName?.trim() || "phis";
  const senderAddress = configuredFrom ?? "no-reply@localhost";

  if (configuredFrom && configuredFrom.includes("<")) {
    return configuredFrom;
  }

  return `${senderName} <${senderAddress}>`;
}

async function sendPhiMailOnce(message: EmailMessage, target: PhiSmtpTarget, emailConfig: PhiEmailConfig) {
  const transport = createMailTransport(target, emailConfig);
  const info = await transport.sendMail({
    from: message.from ?? buildPhiMailFromHeader(emailConfig),
    replyTo: message.replyTo,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    headers: message.headers,
  });
  return {
    messageId: typeof info === "string" ? info : (info.messageId ?? null),
    response: typeof info === "string" ? "" : String(info.response ?? ""),
  };
}

/**
 * Sends one message: the first target that accepts it wins, and only the last target's error is thrown
 * when none does. Returns the message id.
 */
export async function sendPhiMail(message: EmailMessage, emailConfig: PhiEmailConfig): Promise<string | null> {
  const targets = resolvePhiSmtpTargets(emailConfig);

  if (targets.length === 0) {
    throw new Error("SMTP is not configured.");
  }

  let lastError: unknown;
  for (let index = 0; index < targets.length; index += 1) {
    try {
      const { messageId } = await sendPhiMailOnce(message, targets[index], emailConfig);
      return messageId ?? null;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error("Unable to send email.");
}

/** Where in the SMTP conversation an attempt stopped. */
export type PhiSmtpFailureStage = "connect" | "tls" | "auth" | "sender" | "recipient" | "data" | "other";

export type PhiSmtpAttempt =
  | {
    target: string;
    ok: true;
    response: string;
    /** The id the server queued the message under, when its answer names one (`queued as …`, `id=…`). */
    queueId: string | null;
    messageId: string | null;
  }
  | {
    target: string;
    ok: false;
    stage: PhiSmtpFailureStage;
    error: string;
    /** The server's answer, when it gave one (e.g. `550 5.1.1 <x@y>: Recipient address rejected`). */
    response: string | null;
  };

export type PhiMailDeliveryReport = {
  from: string;
  to: string;
  /** The attempt that was accepted, or null when every target failed. */
  accepted: Extract<PhiSmtpAttempt, { ok: true }> | null;
  attempts: PhiSmtpAttempt[];
};

/** The queue id out of an SMTP `250` answer, in the forms Postfix, Exim, Sendmail and most relays use. */
export function readPhiSmtpQueueId(response: string) {
  const match = /queued as\s+<?([A-Za-z0-9._@-]+)>?/i.exec(response)
    ?? /\bid=([A-Za-z0-9._@-]+)/i.exec(response)
    ?? /^250\s+(?:\d\.\d\.\d\s+)?([A-Za-z0-9]{6,})\s+Message accepted/i.exec(response);
  return match?.[1] ?? null;
}

const TLS_MESSAGE = /certificate|\bssl\b|\btls\b|handshake|self[- ]signed|wrong version number|alert/i;

/**
 * nodemailer marks its errors with a code (`ECONNECTION`, `ETLS`, `EAUTH`, `EENVELOPE`, …) and the SMTP
 * command that was answered (`CONN`, `STARTTLS`, `AUTH …`, `MAIL FROM`, `RCPT TO`, `DATA`); those two
 * place the failure in the conversation.
 */
export function classifyPhiSmtpError(error: unknown): PhiSmtpFailureStage {
  const value = error as { code?: unknown; command?: unknown; message?: unknown } | null;
  const code = typeof value?.code === "string" ? value.code : "";
  const command = typeof value?.command === "string" ? value.command.toUpperCase() : "";
  const message = typeof value?.message === "string" ? value.message : String(error);

  if (code === "ETLS" || code === "EREQUIRETLS" || command === "STARTTLS") return "tls";
  if (code === "EAUTH" || command.startsWith("AUTH")) return "auth";
  if (command === "MAIL FROM") return "sender";
  if (command === "RCPT TO") return "recipient";
  if (command === "DATA" || code === "EMESSAGE") return "data";
  if (code === "ECONNECTION" || code === "ETIMEDOUT" || code === "EDNS" || code === "ESOCKET" || command === "CONN") {
    return TLS_MESSAGE.test(message) ? "tls" : "connect";
  }
  if (/^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN)$/.test(code)) return "connect";
  return TLS_MESSAGE.test(message) ? "tls" : "other";
}

/**
 * Tries the targets in the order `sendPhiMail` does and stops at the first that accepts the message, but
 * returns every attempt's outcome instead of throwing the last error. For tests of the mail path; the
 * server's own messages keep going through `sendPhiMail`.
 */
export async function attemptPhiMailDelivery(
  message: EmailMessage,
  emailConfig: PhiEmailConfig,
): Promise<PhiMailDeliveryReport> {
  const from = message.from ?? buildPhiMailFromHeader(emailConfig);
  const attempts: PhiSmtpAttempt[] = [];

  for (const target of resolvePhiSmtpTargets(emailConfig)) {
    const label = formatPhiSmtpTarget(target);
    try {
      const { messageId, response } = await sendPhiMailOnce({ ...message, from }, target, emailConfig);
      const accepted = { target: label, ok: true as const, response, queueId: readPhiSmtpQueueId(response), messageId };
      attempts.push(accepted);
      return { from, to: message.to, accepted, attempts };
    } catch (error) {
      const response = (error as { response?: unknown } | null)?.response;
      attempts.push({
        target: label,
        ok: false,
        stage: classifyPhiSmtpError(error),
        error: error instanceof Error ? error.message : String(error),
        response: typeof response === "string" && response ? response : null,
      });
    }
  }

  return { from, to: message.to, accepted: null, attempts };
}
