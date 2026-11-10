import { NextResponse } from "next/server";

import { guardApiV1 } from "@/lib/api-v1-guard";
import { notifyPhiPerson } from "@/lib/notifications/enqueue";
import { resolveSiteFromHeaders } from "@/lib/site-context";
import { normalizeLocale } from "@/lib/locale";
import { getSiteByKey } from "@/db/sites";
import { stripHtml, type SupportedEmailTemplate } from "@/lib/email-templates";
import { isPhiEmailAddress, normalizePhiEmail } from "@/lib/helpers/normalize";
import { normalizeString } from "@/lib/helpers/request";

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

function formatError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function normalizeTemplate(value: unknown): SupportedEmailTemplate | null {
  if (value !== "registration_verify" && value !== "registration_welcome") {
    return null;
  }
  return value;
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

function normalizeTemplateBody(body: GenericEmailMessage | null, fallbackTo: string): NormalizedGenericMessage | null {
  if (!body) {
    return null;
  }

  const to = normalizePhiEmail(normalizeString(body.to)) || fallbackTo;
  const subject = normalizeText(body.subject);
  const html = normalizeText(body.html);
  const text = normalizeText(body.text);
  const from = normalizeText(body.from) || undefined;

  if (!to || !isPhiEmailAddress(to)) {
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
  const guardError = await guardApiV1(request, { requireInternalToken: true });
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
  const fallbackTo = normalizePhiEmail(normalizeString(payload.to));
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
  if (!recipient || !isPhiEmailAddress(recipient)) {
    return formatError("Invalid recipient email.");
  }

  if (template === "registration_verify") {
    const verificationUrl = normalizeText(payload.verificationUrl);
    if (!verificationUrl) {
      return formatError("Missing verificationUrl.");
    }
    const notificationId = await notifyPhiPerson({
      siteId: site!.id,
      occasion: template,
      recipient: { address: recipient, locale },
      params: { verificationUrl, recipientName },
    });

    return NextResponse.json(
      { sent: true, template, siteKey: site?.key, to: recipient, notificationId },
    );
  }

  if (template === "registration_welcome") {
    const notificationId = await notifyPhiPerson({
      siteId: site!.id,
      occasion: template,
      recipient: { address: genericBody?.to ?? normalizePhiEmail(normalizeString(payload.to)), locale },
      params: { recipientName },
    });

    return NextResponse.json(
      {
        sent: true,
        template,
        siteKey: site?.key,
        to: genericBody?.to ?? normalizePhiEmail(normalizeString(payload.to)),
        notificationId,
      },
    );
  }

  if (!genericBody) {
    return formatError("Missing payload body for generic send.");
  }

  /*
   * A free body goes through as a verbatim message, and that is why it now needs a Site: every row in the
   * outbox belongs to one, and a message nobody can attribute is a message nobody can account for.
   */
  if (!site) {
    return formatError("A generic send needs siteKey, so the message has a Site to belong to.");
  }

  const notificationId = await notifyPhiPerson({
    siteId: site.id,
    occasion: "verbatim",
    recipient: { address: genericBody.to, locale },
    params: {
      from: genericBody.from ?? "",
      subject: genericBody.subject,
      text: genericBody.text,
      html: genericBody.html ?? "",
    },
  });

  return NextResponse.json(
    {
      sent: true,
      template: null,
      siteKey: site.key,
      to: genericBody.to,
      notificationId,
    },
  );
}
