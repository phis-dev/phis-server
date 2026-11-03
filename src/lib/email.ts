import "server-only";

import nodemailer from "nodemailer";

import { getPhisConfigSync } from "@/lib/config";
import { normalizeLocale } from "@/lib/locale";

const DEFAULT_SMTP_HOST = "127.0.0.1";
const DEFAULT_SMTP_HOSTS = `${DEFAULT_SMTP_HOST}:25`;
const DEFAULT_SMTP_PORT = 25;

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

type SmtpTarget = {
  host: string;
  port: number;
};

export function buildBaseUrlWithLocale(baseUrl: string, locale?: string | null) {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  if (!normalizedBaseUrl) {
    throw new Error("Missing site public base URL.");
  }

  const normalizedLocale = normalizeLocale(locale);
  const url = new URL(normalizedBaseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  const localePath = `/${normalizedLocale}`;

  if (!basePath || basePath === "/") {
    url.pathname = localePath;
  } else if (basePath.endsWith(localePath)) {
    url.pathname = basePath;
  } else {
    url.pathname = `${basePath}${localePath}`;
  }

  return url.toString().replace(/\/+$/, "");
}

function isLocalHost(host: string) {
  return host === "127.0.0.1" || host === "localhost";
}

function parseSmtpTargets(targets: string, fallbackPort: number): SmtpTarget[] {
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

function createMailTransport(target: SmtpTarget) {
  const smtpConfig = getPhisConfigSync().email?.smtp;
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

export function buildVerificationUrlForLocale(
  baseUrl: string,
  token: string,
  locale?: string | null,
) {
  const localizedBaseUrl = buildBaseUrlWithLocale(baseUrl, locale);
  return `${localizedBaseUrl}/confirm?token=${encodeURIComponent(token)}`;
}

export function buildVerificationUrlForRequest(
  headers: Headers,
  baseUrl: string,
  token: string,
  locale?: string | null,
) {
  const forwardedHost = headers.get("x-forwarded-host")?.trim();
  const host = forwardedHost || headers.get("host")?.trim();
  const proto = headers.get("x-forwarded-proto")?.trim() || "https";

  if (!host) {
    return buildVerificationUrlForLocale(baseUrl, token, locale);
  }

  const normalizedLocale = normalizeLocale(locale);
  return `${proto}://${host}/${normalizedLocale}/confirm?token=${encodeURIComponent(token)}`;
}

export function buildPasswordResetUrlForLocale(
  baseUrl: string,
  token: string,
  locale?: string | null,
) {
  const localizedBaseUrl = buildBaseUrlWithLocale(baseUrl, locale);
  return `${localizedBaseUrl}/reset-password?token=${encodeURIComponent(token)}`;
}

export function buildPasswordResetUrlForRequest(
  headers: Headers,
  baseUrl: string,
  token: string,
  locale?: string | null,
) {
  const forwardedHost = headers.get("x-forwarded-host")?.trim();
  const host = forwardedHost || headers.get("host")?.trim();
  const proto = headers.get("x-forwarded-proto")?.trim() || "https";

  if (!host) {
    return buildPasswordResetUrlForLocale(baseUrl, token, locale);
  }

  const normalizedLocale = normalizeLocale(locale);
  return `${proto}://${host}/${normalizedLocale}/reset-password?token=${encodeURIComponent(token)}`;
}

function buildFromHeader() {
  const emailConfig = getPhisConfigSync().email;
  const configuredFrom = emailConfig?.from?.trim();
  const senderName = emailConfig?.fromName?.trim() || "phis";
  const senderAddress = configuredFrom ?? "no-reply@localhost";

  if (configuredFrom && configuredFrom.includes("<")) {
    return configuredFrom;
  }

  return `${senderName} <${senderAddress}>`;
}

async function sendEmailOnce(message: EmailMessage, target: SmtpTarget) {
  const transport = createMailTransport(target);
  const info = await transport.sendMail({
    from: message.from ?? buildFromHeader(),
    replyTo: message.replyTo,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    headers: message.headers,
  });

  return typeof info === "string" ? info : info.messageId;
}

export async function sendEmail(message: EmailMessage): Promise<string | null> {
  const smtpTargets = getPhisConfigSync().email?.smtp?.targets ?? [DEFAULT_SMTP_HOSTS];
  const targets = parseSmtpTargets(smtpTargets.join(","), DEFAULT_SMTP_PORT);

  if (targets.length === 0) {
    throw new Error("SMTP is not configured.");
  }

  let lastError: unknown;
  for (let index = 0; index < targets.length; index += 1) {
    try {
      const messageId = await sendEmailOnce(message, targets[index]);
      return messageId ?? null;
    } catch (error) {
      lastError = error;
      if (index < targets.length - 1) {
        continue;
      }
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error("Unable to send email.");
}
