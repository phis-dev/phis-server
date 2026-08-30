import { NextResponse } from "next/server";

import { guardApiV1 } from "@/lib/api-v1-guard";
import { requireSiteFromRequest } from "@/lib/site-context";
import { sendEmail } from "@/lib/email";
import { getFormGuardSecret, getFormTimingWindow, getSiteMailConfig } from "@/lib/form-config";
import { logFormAbuse } from "@/lib/form-abuse-log";
import { verifyFormGuard } from "@/lib/form-guard";

type ContactPayload = {
  name?: unknown;
  email?: unknown;
  subject?: unknown;
  message?: unknown;
  website?: unknown;
  issuedAt?: unknown;
  formToken?: unknown;
};

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function sanitizeHeaderValue(value: string) {
  return value.replace(/[\r\n]/g, " ").trim().slice(0, 300);
}

export async function POST(request: Request) {
  const guardError = guardApiV1(request, { requireInternalToken: true });
  if (guardError) {
    return guardError;
  }

  const site = await requireSiteFromRequest(request);
  if (!site) {
    return NextResponse.json({ error: "Missing site context." }, { status: 400 });
  }

  let payload: ContactPayload = {};
  try {
    payload = (await request.json()) as ContactPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const name = normalize(payload.name);
  const email = normalize(payload.email);
  const subject = normalize(payload.subject);
  const message = normalize(payload.message);
  const website = normalize(payload.website);
  const issuedAt = normalize(payload.issuedAt);
  const formToken = normalize(payload.formToken);

  const guardResult = verifyFormGuard({
    form: "@phis/ui/modules/public/forms/contact",
    siteKey: site.key,
    secret: await getFormGuardSecret(site.id),
    honeypotValue: website,
    issuedAt,
    formToken,
    ...getFormTimingWindow("contact"),
  });

  if (!guardResult.ok) {
    logFormAbuse(request, "@phis/ui/modules/public/forms/contact", guardResult.reason, {
      ageMs: guardResult.ageMs ?? null,
      field: guardResult.reason === "honeypot" ? "website" : null,
      siteKey: site.key,
    });
    return NextResponse.json({ ok: true });
  }

  if (!name || !email || !subject || !message) {
    return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
  }

  if (!isValidEmail(email)) {
    return NextResponse.json({ error: "Invalid email address." }, { status: 400 });
  }

  const siteMailConfig = await getSiteMailConfig(site.id);
  const safeName = sanitizeHeaderValue(name);
  const safeEmail = sanitizeHeaderValue(email);
  const safeSubject = sanitizeHeaderValue(subject);

  const messageId = await sendEmail({
    to: siteMailConfig.contactRecipient,
    from: `${sanitizeHeaderValue(siteMailConfig.mailFromName)} <${siteMailConfig.mailFrom}>`,
    replyTo: `${safeName} <${safeEmail}>`,
    subject: safeSubject,
    text: `Name: ${safeName}\nEmail: ${safeEmail}\n\n${message}`,
  });

  return NextResponse.json({ ok: true, messageId });
}
