import "server-only";

import { sendEmail } from "@/lib/email";
import { PHI_CANONICAL_SOURCE_LOCALE, normalizeLocale } from "@/lib/locale";
import { translateWithCache } from "@/lib/translations";

export type SupportedEmailTemplate =
  | "registration_verify"
  | "registration_welcome"
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

function escapeHtml(value: string) {
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

export async function sendTemplatedEmail({
  to,
  site,
  siteConfig,
  locale,
  template,
  recipientName,
  verificationUrl = "",
}: {
  to: string;
  site: { id: number; key: string; name: string; sourceLocale: string };
  siteConfig: { supportEmail: string; mailFrom: string; mailFromName: string };
  locale: string;
  template: SupportedEmailTemplate;
  recipientName: string;
  verificationUrl?: string;
}) {
  const content = await resolveEmailTemplate(site.id, site.sourceLocale, locale, template, {
    recipientName,
    siteName: site.name,
    verifyUrl: verificationUrl,
    supportEmail: siteConfig.supportEmail,
  });

  return sendEmail({
    to,
    from: `${siteConfig.mailFromName} <${siteConfig.mailFrom}>`,
    subject: content.subject,
    text: stripHtml(content.bodyHtml),
    html: content.bodyHtml,
  });
}
