import { NextRequest, NextResponse } from "next/server";

import {
  consumeUserPasswordResetToken,
  getUserPasswordResetTokenByRawToken,
} from "@/db/user-password-reset-tokens";
import { revokeUserSessions } from "@/db/user-sessions";
import { updateUserAccountPasswordHash } from "@/db/user-accounts";
import { verifyCsrfRequest } from "@/lib/auth";
import { PhiUserAccountFlag } from "@/lib/constants/user-account-flags";
import { hashPassword } from "@/lib/password";
import { requireSiteFromRequest } from "@/lib/site-context";
import {
  isSitePasswordMethodEnabled,
  PASSWORD_METHOD_DISABLED_RESPONSE,
} from "@/lib/site-auth/password-method";

type ConfirmPayload = {
  token?: unknown;
  password?: unknown;
  confirmPassword?: unknown;
};

function normalize(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isIsoDateInPast(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

export async function POST(request: NextRequest) {
  const site = await requireSiteFromRequest(request);
  if (!site) {
    return NextResponse.json({ error: "Missing site context." }, { status: 400 });
  }
  if (!verifyCsrfRequest(request)) {
    return NextResponse.json({ error: "Invalid CSRF token." }, { status: 403 });
  }
  if (!await isSitePasswordMethodEnabled(site.id)) {
    return NextResponse.json(PASSWORD_METHOD_DISABLED_RESPONSE, { status: 403 });
  }

  let payload: ConfirmPayload = {};
  try {
    payload = (await request.json()) as ConfirmPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const token = normalize(payload.token);
  const password = normalize(payload.password);
  const confirmPassword = normalize(payload.confirmPassword);

  if (!/^[a-f0-9]{64}$/i.test(token)) {
    return NextResponse.json({ error: "Invalid reset token." }, { status: 400 });
  }

  if (!password || !confirmPassword) {
    return NextResponse.json({ error: "Missing password fields." }, { status: 400 });
  }

  if (password.length < 10) {
    return NextResponse.json({ error: "Password is too short." }, { status: 400 });
  }

  if (password !== confirmPassword) {
    return NextResponse.json({ error: "Passwords do not match." }, { status: 400 });
  }

  const resetToken = await getUserPasswordResetTokenByRawToken(site.id, token);
  if (!resetToken) {
    return NextResponse.json({ error: "Invalid reset token." }, { status: 404 });
  }

  if (resetToken.consumedAt) {
    return NextResponse.json({ error: "Reset token already used." }, { status: 409 });
  }

  if (isIsoDateInPast(resetToken.expiresAt)) {
    return NextResponse.json({ error: "Reset token expired." }, { status: 410 });
  }

  const passwordHash = await hashPassword(password);
  await updateUserAccountPasswordHash(resetToken.userId, passwordHash, {
    clearFlags: PhiUserAccountFlag.MustChangePassword,
  });
  await consumeUserPasswordResetToken(resetToken.id);
  await revokeUserSessions(resetToken.userId);

  return NextResponse.json({});
}
