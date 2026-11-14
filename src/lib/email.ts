import "server-only";

import { getPhisConfigSync } from "@/lib/config";
import { sendPhiMail, type EmailMessage } from "@/lib/email-transport";
import { normalizeLocale } from "@/lib/locale";

export type { EmailMessage } from "@/lib/email-transport";

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

/*
 * A link in a mail is built from the Site's public base URL and nothing else. It used to prefer the
 * request's `x-forwarded-host` and `host`, which a caller sets: a reset request with a forged host
 * header mailed the person a reset link into the forger's domain, token included (site-context.ts
 * refuses those headers for the same reason).
 */
export function buildSiteLinkForLocale(
  baseUrl: string,
  path: string,
  locale: string | null | undefined,
  params: Record<string, string>,
) {
  const query = new URLSearchParams(params).toString();
  return `${buildBaseUrlWithLocale(baseUrl, locale)}${path}${query ? `?${query}` : ""}`;
}

export function buildVerificationUrlForLocale(baseUrl: string, token: string, locale?: string | null) {
  return buildSiteLinkForLocale(baseUrl, "/confirm", locale, { token });
}

export function buildPasswordResetUrlForLocale(baseUrl: string, token: string, locale?: string | null) {
  return buildSiteLinkForLocale(baseUrl, "/reset-password", locale, { token });
}

/** Sends one message through `email.smtp.targets` with the server's cached configuration. */
export async function sendEmail(message: EmailMessage): Promise<string | null> {
  return sendPhiMail(message, getPhisConfigSync().email);
}
