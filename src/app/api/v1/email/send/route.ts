import { NextResponse } from "next/server";

import { guardApiV1 } from "@/lib/api-v1-guard";
import { resolveSiteFromHeaders } from "@/lib/site-context";
import { normalizeLocale } from "@/lib/locale";
import { getSiteByKey } from "@/db/sites";
import { sendEmail } from "@/lib/email";
import { getSiteConfigBySiteId } from "@/db/site-config";
import { sendTemplatedEmail, stripHtml, type SupportedEmailTemplate } from "@/lib/email-templates";
import { PHIS_SITE_KEY_HEADER, PHIS_TOKEN_HEADER } from "@/lib/constants/http-headers";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": `authorization, ${PHIS_TOKEN_HEADER}, ${PHIS_SITE_KEY_HEADER}, content-type`,
};

type GenericEmailMessage = {
  subject?: unknown;
  text?: unknown;
  html?: unknown;
  from?: unknown;
  to?: unknown;
};

type EmailPayload = {
  template?: unknown;
  to?: unknown;
  locale?: unknown;
  name?: unknown;
  siteKey?: unknown;
  verificationUrl?: unknown;
  body?: GenericEmailMessage;
};


type NormalizedGenericMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from?: string;
};

function resolveMessageId(result: unknown) {
  if (typeof result === "string") {
    return result;
  }

  if (result && typeof result === "object" && "messageId" in result) {
    const messageId = (result as { messageId?: unknown }).messageId;
    return typeof messageId === "string" ? messageId : undefined;
  }

  return undefined;
}

function formatError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status, headers: CORS_HEADERS });
}

function normalizeTemplate(value: unknown): SupportedEmailTemplate | null {
  if (value !== "registration_verify" && value !== "registration_welcome") {
    return null;
  }
  return value;
}

function normalizeEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeGenericBody(value: unknown): GenericEmailMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as GenericEmailMessage;
}

function isValidEmail(email: string) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

function normalizeTemplateBody(body: GenericEmailMessage | null, fallbackTo: string): NormalizedGenericMessage | null {
  if (!body) {
    return null;
  }

  const to = normalizeEmail(body.to) || fallbackTo;
  const subject = normalizeText(body.subject);
  const html = normalizeText(body.html);
  const text = normalizeText(body.text);
  const from = normalizeText(body.from) || undefined;

  if (!to || !isValidEmail(to)) {
    return null;
  }

  const resolvedText = text || (html ? stripHtml(html) : "");
  if (!subject || !resolvedText) {
    return null;
  }

  return {
    to,
    subject,
    text: resolvedText,
    html: html || undefined,
    from,
  };
}

function resolveSiteOrFail(siteKey: string | null | undefined, headers: Headers) {
  if (siteKey) {
    return getSiteByKey(siteKey);
  }

  return resolveSiteFromHeaders(headers);
}

export async function POST(request: Request) {
  const guardError = guardApiV1(request, { requireInternalToken: true });
  if (guardError) {
    return guardError;
  }

  let payload: EmailPayload = {};
  try {
    payload = (await request.json()) as EmailPayload;
  } catch {
    return formatError("Invalid JSON payload.");
  }

  const template = normalizeTemplate(payload.template);
  const fallbackTo = normalizeEmail(payload.to);
  const generic = normalizeGenericBody(payload.body);
  const genericBody = normalizeTemplateBody(generic, fallbackTo);
  if (!template && !genericBody) {
    return formatError(
      "Unsupported payload. Provide either a supported template or a valid generic body.",
    );
  }

  const locale = normalizeLocale(
    typeof payload.locale === "string" ? payload.locale : null,
  );
  const recipientName = normalizeText(payload.name) || "there";
  const requestedSiteKey = normalizeText(payload.siteKey);
  const site = template
    ? await resolveSiteOrFail(requestedSiteKey, request.headers)
    : (requestedSiteKey ? await getSiteByKey(requestedSiteKey) : null);

  if (template && !site) {
    return formatError("Missing site context.");
  }

  const recipient = genericBody?.to || fallbackTo;
  if (!recipient || !isValidEmail(recipient)) {
    return formatError("Invalid recipient email.");
  }

  if (template === "registration_verify") {
    const verificationUrl = normalizeText(payload.verificationUrl);
    if (!verificationUrl) {
      return formatError("Missing verificationUrl.");
    }
    const siteConfig = await getSiteConfigBySiteId(site!.id);
    if (!siteConfig) {
      return formatError("Missing site config.");
    }
    const result = await sendTemplatedEmail({
      to: recipient,
      site: site!,
      siteConfig,
      locale,
      template,
      recipientName,
      verificationUrl,
    });

    return NextResponse.json(
      {
        sent: true,
        template,
        siteKey: site?.key,
        to: recipient,
        messageId: resolveMessageId(result),
      },
      { headers: CORS_HEADERS },
    );
  }

  if (template === "registration_welcome") {
    const siteConfig = await getSiteConfigBySiteId(site!.id);
    if (!siteConfig) {
      return formatError("Missing site config.");
    }
    const result = await sendTemplatedEmail({
      to: genericBody?.to ?? normalizeEmail(payload.to),
      site: site!,
      siteConfig,
      locale,
      template,
      recipientName,
    });

    return NextResponse.json(
      {
        sent: true,
        template,
        siteKey: site?.key,
        to: genericBody?.to ?? normalizeEmail(payload.to),
        messageId: resolveMessageId(result),
      },
      { headers: CORS_HEADERS },
    );
  }

  if (!genericBody) {
    return formatError("Missing payload body for generic send.");
  }

  const result = await sendEmail({
        to: genericBody.to,
    from: genericBody.from,
    subject: genericBody.subject,
    text: genericBody.text,
    html: genericBody.html,
  });

  return NextResponse.json(
    {
      sent: true,
      template: null,
      siteKey: site?.key ?? null,
      to: genericBody.to,
      messageId: resolveMessageId(result),
    },
    { headers: CORS_HEADERS },
  );
}

export async function OPTIONS() {
  return NextResponse.json(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}
