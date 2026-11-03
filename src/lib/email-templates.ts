import "server-only";

import { sendEmail } from "@/lib/email";
import { PHI_CANONICAL_SOURCE_LOCALE, normalizeLocale } from "@/lib/locale";
import { translateWithCache } from "@/lib/translations";

export type SupportedEmailTemplate =
  | "registration_verify"
  | "registration_welcome"
  | "registration_account_exists"
  | "password_reset";

type TemplateContext = {
  recipientName: string;
  siteName: string;
  verifyUrl: string;
  supportEmail: string;
};

type TemplateParamKey = keyof TemplateContext;

type TemplateText = {
  text: string;
  params?: TemplateParamKey[];
};

type TranslatedTemplate = {
  subject: string;
  bodyHtml: string;
};

const TEMPLATE_DEFAULTS: Record<
  SupportedEmailTemplate,
  {
    subject: TemplateText;
    lines: TemplateText[];
    ctaLabel?: string;
  }
> = {
  registration_verify: {
    subject: { text: "Verify your email address" },
    lines: [
      { text: "Hello %1,", params: ["recipientName"] },
      { text: "Please confirm your email address by clicking the link below:" },
      { text: "If this request was not made by you, please ignore this email." },
    ],
    ctaLabel: "Verify email",
  },
  registration_welcome: {
    subject: { text: "Welcome to %1", params: ["siteName"] },
    lines: [
      { text: "Hello %1,", params: ["recipientName"] },
      { text: "Welcome to %1.", params: ["siteName"] },
      { text: "You can now continue once your account is fully set up by using your access portal." },
      { text: "Need help? Contact %1.", params: ["supportEmail"] },
    ],
  },
  registration_account_exists: {
    subject: { text: "You already have an account at %1", params: ["siteName"] },
    lines: [
      { text: "Hello," },
      { text: "Somebody tried to register at %1 with this email address, which already has an account.",
        params: ["siteName"] },
      {
        text: "If that was you, sign in with your password, or use \"Forgot password\" on the sign-in page.",
      },
      { text: "If it was not you, you can ignore this email. Your account has not been changed." },
    ],
  },
  password_reset: {
    subject: { text: "Reset your password" },
    lines: [
      { text: "Hello %1,", params: ["recipientName"] },
      { text: "You requested a password reset. Use the link below to set a new password:" },
      { text: "If you did not request this, you can ignore this email." },
    ],
    ctaLabel: "Reset password",
  },
};

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function applyTemplateParams(
  text: string,
  params: TemplateParamKey[] | undefined,
  context: TemplateContext,
  escapeValue: (value: string) => string,
) {
  if (!params?.length) {
    return text;
  }

  return params.reduce((result, key, index) => {
    return result.replaceAll(`%${index + 1}`, escapeValue(context[key]));
  }, text);
}

async function translateTemplateText(
  part: TemplateText,
  locale: string,
  ctx: string,
  context: TemplateContext,
  escapeValue: (value: string) => string,
) {
  if (locale === PHI_CANONICAL_SOURCE_LOCALE) {
    return applyTemplateParams(part.text, part.params, context, escapeValue);
  }

  return translateWithCache({
    locale,
    msg: part.text,
    ctx,
  }).then((translated) => applyTemplateParams(translated, part.params, context, escapeValue));
}

export function stripHtml(value: string) {
  return value
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function resolveEmailTemplate(
  _siteId: number,
  _sourceLocale: string,
  locale: string,
  template: SupportedEmailTemplate,
  context: TemplateContext,
): Promise<TranslatedTemplate> {
  const defaults = TEMPLATE_DEFAULTS[template];
  const normalizedLocale = normalizeLocale(locale);
  const safeContext = {
    recipientName: escapeHtml(context.recipientName),
    siteName: escapeHtml(context.siteName),
    verifyUrl: escapeHtml(context.verifyUrl),
    supportEmail: escapeHtml(context.supportEmail),
  };
  const subjectRaw = await translateTemplateText(
    defaults.subject,
    normalizedLocale,
    `${template.replaceAll("_", " ")} email subject`,
    context,
    (value) => value,
  );
  const translatedLines = await Promise.all(
    defaults.lines.map((part, index) =>
      translateTemplateText(
        part,
        normalizedLocale,
        `${template.replaceAll("_", " ")} email body line ${index + 1}`,
        safeContext,
        (value) => value,
      ),
    ),
  );
  const ctaLabel = defaults.ctaLabel;
  const translatedCtaLabel = ctaLabel
    ? normalizedLocale === PHI_CANONICAL_SOURCE_LOCALE
      ? ctaLabel
      : await translateWithCache({
          locale: normalizedLocale,
          msg: ctaLabel,
          ctx: `${template.replaceAll("_", " ")} email call to action`,
        })
    : null;

  const renderedLines = translatedLines;
  const renderedSubject = subjectRaw;

  let bodyHtml = "";

  if (template === "registration_verify" || template === "password_reset") {
    bodyHtml = [
      `<p>${renderedLines[0] ?? ""}</p>`,
      `<p>${renderedLines[1] ?? ""}</p>`,
      `<p><a href="${safeContext.verifyUrl}">${escapeHtml(translatedCtaLabel ?? defaults.ctaLabel ?? "Verify email")}</a></p>`,
      `<p>${renderedLines[2] ?? ""}</p>`,
    ].join("");
  } else {
    bodyHtml = renderedLines.map((line) => `<p>${line}</p>`).join("");
  }

  return {
    subject: renderedSubject,
    bodyHtml,
  };
}

/**
 * The footer a sent message owes, and an asked-for one must not carry.
 *
 * Core writes it rather than the caller, which is what keeps a message that needed consent from ever going
 * out without the way back. It says why the mail arrived before it offers the way out, because a link
 * without a reason reads like a trick.
 */
async function renderUnsubscribeFooter(locale: string, siteName: string, unsubscribeUrl: string) {
  const normalizedLocale = normalizeLocale(locale);
  const translate = (msg: string, ctx: string) =>
    normalizedLocale === PHI_CANONICAL_SOURCE_LOCALE
      ? Promise.resolve(msg)
      : translateWithCache({ locale: normalizedLocale, msg, ctx });

  const [note, label] = await Promise.all([
    translate(
      "You are receiving this because you asked %1 for updates.",
      "unsubscribe footer reason",
    ),
    translate("Unsubscribe", "unsubscribe footer link"),
  ]);

  return {
    html: `<hr><p>${note.replaceAll("%1", escapeHtml(siteName))} `
      + `<a href="${escapeHtml(unsubscribeUrl)}">${escapeHtml(label)}</a></p>`,
    /*
     * The plain-text alternative carries the address itself, because `stripHtml` keeps the words of a link
     * and throws away where it points. A text-only reader was left with the word "Unsubscribe" and no way
     * to act on it, which is the one thing this footer exists to prevent.
     */
    text: `${note.replaceAll("%1", siteName)} ${label}: ${unsubscribeUrl}`,
  };
}

export async function sendTemplatedEmail({
  to,
  site,
  siteConfig,
  locale,
  template,
  recipientName,
  verificationUrl = "",
  replyTo,
  unsubscribeUrl,
}: {
  to: string;
  site: { id: number; key: string; name: string; sourceLocale: string };
  siteConfig: { supportEmail: string; mailFrom: string; mailFromName: string };
  locale: string;
  template: SupportedEmailTemplate;
  recipientName: string;
  verificationUrl?: string;
  /** Where an answer should go. A circular answers to Support; a system mail answers nowhere. */
  replyTo?: string;
  /**
   * Set only for a message somebody decided to send.
   *
   * Presence is what adds the visible footer and the `List-Unsubscribe` header together, so a circular
   * cannot acquire one without the other -- a header without a link is a mail only a machine can escape,
   * and a link without the header is one the reader has to hunt for.
   *
   * `List-Unsubscribe-Post` is deliberately absent. RFC 8058 one-click requires the very URL in the header
   * to accept a bare `POST`, and on a phis Site there is no such address: a Module reaches the browser
   * through rendered pages and the form gateway, and the Skeleton gains no route per feature. Claiming
   * one-click without honouring it is worse than not claiming it, so the header says only what is true.
   */
  unsubscribeUrl?: string;
}) {
  const content = await resolveEmailTemplate(site.id, site.sourceLocale, locale, template, {
    recipientName,
    siteName: site.name,
    verifyUrl: verificationUrl,
    supportEmail: siteConfig.supportEmail,
  });

  const footer = unsubscribeUrl
    ? await renderUnsubscribeFooter(locale, site.name, unsubscribeUrl)
    : null;
  const bodyHtml = footer ? content.bodyHtml + footer.html : content.bodyHtml;
  const bodyText = footer
    ? `${stripHtml(content.bodyHtml)}\n\n${footer.text}`
    : stripHtml(content.bodyHtml);

  return sendEmail({
    to,
    from: `${siteConfig.mailFromName} <${siteConfig.mailFrom}>`,
    replyTo,
    subject: content.subject,
    text: bodyText,
    html: bodyHtml,
    headers: unsubscribeUrl ? { "List-Unsubscribe": `<${unsubscribeUrl}>` } : undefined,
  });
}
