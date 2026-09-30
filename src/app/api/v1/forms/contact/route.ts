import { NextResponse } from "next/server";

import { guardApiV1 } from "@/lib/api-v1-guard";
import { requireSiteFromRequest } from "@/lib/site-context";
import { notifyPhiPerson } from "@/lib/notifications/enqueue";
import { getFormGuardSecret, getFormTimingWindow, getSiteMailConfig } from "@/lib/form-config";
import { logFormAbuse } from "@/lib/form-abuse-log";
import { verifyFormGuard } from "@/lib/form-guard";
import { normalizeString, readPhiClientIp } from "@/lib/helpers/request";
import { checkRateLimit } from "@/lib/rate-limit";
import { tooManyAttemptsResponse } from "@/lib/site-auth/attempt-limit";

type ContactPayload = {
  name?: unknown;
  email?: unknown;
  subject?: unknown;
  message?: unknown;
  website?: unknown;
  issuedAt?: unknown;
  formToken?: unknown;
};

/*
 * Every accepted submission is a mail to the Site's contact recipient, so it is counted twice: per sender
 * address and per client address where a trusted proxy names one. Either alone is easy to vary; a script
 * that passes the honeypot and the timing window still sends at most this many an hour from one place
 * or under one name.
 */
const CONTACT_SUBMISSIONS_PER_HOUR = 5;
const CONTACT_WINDOW_MS = 3_600_000;

function checkContactLimit(request: Request, siteId: number, email: string) {
  const address = readPhiClientIp(request);
  const keys = [
    `contact:${siteId}:email:${email.toLowerCase()}`,
    ...(address ? [`contact:${siteId}:address:${address}`] : []),
  ];
  let retryAfter: number | null = null;
  for (const key of keys) {
    const answer = checkRateLimit(key, CONTACT_SUBMISSIONS_PER_HOUR, CONTACT_WINDOW_MS);
    if (answer !== null && (retryAfter === null || answer > retryAfter)) {
      retryAfter = answer;
    }
  }
  return retryAfter;
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

  const name = normalizeString(payload.name);
  const email = normalizeString(payload.email);
  const subject = normalizeString(payload.subject);
  const message = normalizeString(payload.message);
  const website = normalizeString(payload.website);
  const issuedAt = normalizeString(payload.issuedAt);
  const formToken = normalizeString(payload.formToken);

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

  const retryAfter = checkContactLimit(request, site.id, email);
  if (retryAfter !== null) {
    return tooManyAttemptsResponse(retryAfter);
  }

  const siteMailConfig = await getSiteMailConfig(site.id);
  const safeName = sanitizeHeaderValue(name);
  const safeEmail = sanitizeHeaderValue(email);
  const safeSubject = sanitizeHeaderValue(subject);

  /*
   * Through the outbox like everything else, as a verbatim message: a visitor's own sentence is not
   * Core's to translate or reframe, and the recipient is the Site's own mailbox rather than a person whose
   * address has to be resolved. What it gains is the retry -- a submission lost to one refused SMTP
   * connection used to be gone, and the visitor had already been told it arrived.
   */
  const notificationId = await notifyPhiPerson({
    siteId: site.id,
    occasion: "verbatim",
    recipient: { address: siteMailConfig.contactRecipient, locale: site.defaultLocale },
    params: {
      from: `${sanitizeHeaderValue(siteMailConfig.mailFromName)} <${siteMailConfig.mailFrom}>`,
      replyTo: `${safeName} <${safeEmail}>`,
      subject: safeSubject,
      text: `Name: ${safeName}\nEmail: ${safeEmail}\n\n${message}`,
    },
  });

  return NextResponse.json({ ok: true, notificationId });
}
