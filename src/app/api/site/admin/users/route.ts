import { randomBytes } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import {
  deleteUserAccount,
  ensureUserAccount,
  getUserAccountByEmail,
  getUserAccountById,
  removeUserAccountSiteMembership,
  updateUserAccountFlags,
  updateUserAccountPasswordHash,
  updateUserAccountProfileFields,
} from "@/db/user-accounts";
import { listAdminUsersForSite, setAdminUserEnabled } from "@/db/user-admin";
import { createUserPasswordResetToken } from "@/db/user-password-reset-tokens";
import { getUserProfileByUserId, upsertUserProfile } from "@/db/user-profiles";
import { getUserSiteMembership, upsertUserSiteMembership } from "@/db/user-site-memberships";
import { requireSiteAdminOnlyApiContext } from "@/lib/guards/site-admin-api";
import { PHI_BASE_ROLE_OPTIONS } from "@/lib/constants/phi-base-role-metadata";
import { PhiUserAccountFlag } from "@/lib/constants/user-account-flags";
import { buildPasswordResetUrlForRequest } from "@/lib/email";
import { getSiteMailConfig } from "@/lib/form-config";
import { sendTemplatedEmail } from "@/lib/email-templates";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
import { hashPassword } from "@/lib/password";
import { hasPhiFlag } from "@/lib/helpers/flags";
import { listUserSessionsForSite, revokeUserSessionsForSite } from "@/db/user-sessions";
import { resolveUserAccountFlagTags } from "@/lib/user-flags";
import { USER_SITE_FLAG_DISABLED, USER_SITE_FLAG_NEWSLETTER_OPT_IN } from "@/lib/user-site-flags";
import { normalizeString, readRequestBody } from "@/lib/helpers/request";

import { PhiUserEmailSource } from "@phis/contracts/access";

export const dynamic = "force-dynamic";

type QueryValue = string | null;

type AdminSite = NonNullable<NonNullable<Awaited<ReturnType<typeof requireSiteAdminOnlyApiContext>>["context"]>["site"]>;

/**
 * An account is global: one address, one password, one profile, whichever Sites it belongs to. A Site
 * Admin governs all of it only while it belongs to their Site alone -- the Admin role grants no
 * cross-Site authority (AUTHORIZATION.md §3). Once other Sites share it, this Site keeps what is its
 * own, the membership with its roles and enabled state, and the person keeps the rest.
 */
function isAccountOwnedBySite(account: { siteIds: readonly number[] }, siteId: number) {
  return account.siteIds.length === 1 && account.siteIds[0] === siteId;
}

const ACCOUNT_SHARED_RESPONSE = {
  code: "account_shared",
  error:
    "This account also belongs to other sites; only its roles and enabled state can be changed here.",
} as const;

function normalize(value: QueryValue) {
  return value?.trim() ?? "";
}

function normalizeNullableString(value: unknown) {
  const normalized = normalizeString(value);
  return normalized ? normalized : null;
}

function normalizeBoolean(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  }

  return false;
}

function parsePageValue(value: QueryValue, fallback: number) {
  const parsed = Number.parseInt(normalize(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseEnabledFilter(value: QueryValue) {
  const normalized = normalize(value).toLowerCase();
  if (normalized === "enabled" || normalized === "disabled" || normalized === "all") {
    return normalized;
  }

  return "all";
}

function parseAccountType(value: QueryValue) {
  const normalized = normalize(value).toLowerCase();
  if (normalized === "customer" || normalized === "roles" || normalized === "auth") {
    return normalized;
  }

  return "all";
}

function parsePositiveInt(value: QueryValue, fallback: number) {
  const parsed = Number.parseInt(normalize(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function buildRoleTags(coreRoleFlags: number) {
  return PHI_BASE_ROLE_OPTIONS.filter((option) => hasPhiFlag(coreRoleFlags, option.flag)).map(
    (option) => option.value,
  );
}

function buildUserSiteFlagTags(siteFlags: number) {
  const tags: string[] = [];

  if ((siteFlags & USER_SITE_FLAG_DISABLED) === USER_SITE_FLAG_DISABLED) {
    tags.push("disabled");
  }

  if ((siteFlags & USER_SITE_FLAG_NEWSLETTER_OPT_IN) === USER_SITE_FLAG_NEWSLETTER_OPT_IN) {
    tags.push("newsletter");
  }

  return tags;
}

function buildBaseRoleFlagsFromSelection(value: unknown) {
  const values = Array.isArray(value)
    ? value.map((entry) => normalizeString(entry).toLowerCase()).filter(Boolean)
    : typeof value === "string"
      ? value
          .split(",")
          .map((entry) => normalizeString(entry).toLowerCase())
          .filter(Boolean)
      : [];

  let flags = 0;
  for (const option of PHI_BASE_ROLE_OPTIONS) {
    if (values.includes(option.value)) {
      flags |= option.flag;
    }
  }

  return flags;
}

function buildRecipientName(firstName: string, lastName: string) {
  return [firstName.trim(), lastName.trim()].filter(Boolean).join(" ").trim();
}

async function sendPasswordResetMail(input: {
  request: NextRequest;
  site: AdminSite;
  userId: number;
  email: string;
  locale: string;
}) {
  const siteConfig = await getSiteMailConfig(input.site.id);
  const resetToken = await createUserPasswordResetToken({
    userId: input.userId,
    siteId: input.site.id,
  });
  const resetUrl = buildPasswordResetUrlForRequest(
    input.request.headers,
    siteConfig.publicBaseUrl,
    resetToken.token,
    input.locale,
  );
  const profile = await getUserProfileByUserId(input.userId);
  const recipientName = profile
    ? buildRecipientName(profile.firstName, profile.lastName) || input.email
    : input.email;

  return sendTemplatedEmail({
    to: input.email,
    site: input.site,
    siteConfig,
    locale: input.locale,
    template: "password_reset",
    recipientName,
    verificationUrl: resetUrl,
  });
}

export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteAdminOnlyApiContext(request);
  if (error) {
    return error;
  }

  if (!context) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const session = context.session;
  if (!session) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const site = context.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const historyUserId = parsePositiveInt(searchParams.get("historyUserId"), 0);
  if (historyUserId > 0) {
    const target = await getUserAccountById(historyUserId, site.id);
    if (!target || !target.siteIds.includes(site.id)) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    const sessions = await listUserSessionsForSite(historyUserId, site.id, parsePositiveInt(searchParams.get("limit"), 25));
    return NextResponse.json({
      userId: historyUserId,
      sessions,
    });
  }

  const userId = parsePositiveInt(searchParams.get("userId"), 0);
  if (userId > 0) {
    const [target, profile, membership] = await Promise.all([
      getUserAccountById(userId, site.id),
      getUserProfileByUserId(userId),
      getUserSiteMembership(userId, site.id),
    ]);
    if (!target || !target.siteIds.includes(site.id) || !membership) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }
    return NextResponse.json({
      user: {
        id: target.id,
        email: target.emailNormalized,
        firstName: profile?.firstName ?? "",
        lastName: profile?.lastName ?? "",
        companyName: profile?.companyName ?? "",
        enabled: membership.enabled,
        coreRoleFlags: membership.coreRoleFlags,
        roleTags: buildRoleTags(membership.coreRoleFlags),
        medusaCustomerId: target.medusaCustomerId,
        self: target.id === session.userId,
      },
    });
  }

  const result = await listAdminUsersForSite(site.id, {
    search: normalize(searchParams.get("search")) || normalize(searchParams.get("q")),
    accountType: parseAccountType(searchParams.get("accountType")),
    enabled: parseEnabledFilter(searchParams.get("enabled")),
    sortKey: normalize(searchParams.get("sortKey")),
    sortOrder: normalize(searchParams.get("sortOrder")).toLowerCase() as "ascend" | "descend" | "",
    page: parsePageValue(searchParams.get("page"), 1),
    pageSize: parsePageValue(searchParams.get("pageSize"), 20),
  });

  const rows = result.rows.map((row) => ({
    id: row.id,
    name: row.displayName,
    email: row.emailNormalized,
    accountType: row.accountType,
    enabled: row.enabled,
    userFlagTags: resolveUserAccountFlagTags(row.flags),
    siteFlagTags: buildUserSiteFlagTags(row.siteFlags),
    roleTags: buildRoleTags(row.coreRoleFlags),
    coreRoleFlags: row.coreRoleFlags,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
    companyName: row.companyName,
    customerNumber: row.customerNumber,
    medusaCustomerId: row.medusaCustomerId,
    firstName: row.firstName,
    lastName: row.lastName,
    self: row.id === session.userId,
  }));

  return NextResponse.json({
    rows,
    total: result.total,
    siteTotal: result.siteTotal,
    page: result.page,
    pageSize: result.pageSize,
  });
}

export async function POST(request: NextRequest) {
  const { context, error } = await requireSiteAdminOnlyApiContext(request);
  if (error) {
    return error;
  }

  if (!context) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const session = context.session;
  if (!session) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const site = context.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const body = await readRequestBody(request);
  const email = normalizeString(body.email).toLowerCase();
  const firstName = normalizeString(body.firstName);
  const lastName = normalizeString(body.lastName);
  const companyName = normalizeNullableString(body.companyName);
  const roleFlags = buildBaseRoleFlagsFromSelection(body.roles);

  if (!email || !firstName || !lastName) {
    return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
  }

  const existingUser = await getUserAccountByEmail(email);
  if (existingUser && existingUser.siteIds.includes(site.id)) {
    return NextResponse.json({ error: "Account already exists." }, { status: 409 });
  }

  if (existingUser) {
    /*
     * The address already has an account, on other Sites. This Site gains a member and nothing else:
     * the password, the account flags and the profile stay as the person left them, since overwriting
     * them here would reach every Site they use. No reset mail either -- they can sign in already.
     * A profile is written only where none exists, which takes nothing from anybody.
     */
    await upsertUserSiteMembership({
      userId: existingUser.id,
      siteId: site.id,
      coreRoleFlags: roleFlags,
    });
    if (!await getUserProfileByUserId(existingUser.id)) {
      await upsertUserProfile({ userId: existingUser.id, firstName, lastName, companyName });
    }

    return NextResponse.json({
      userId: existingUser.id,
      email: existingUser.emailNormalized,
      coreRoleFlags: roleFlags,
      roleTags: buildRoleTags(roleFlags),
      changePassword: false,
      linkedExistingAccount: true,
    });
  }

  const passwordHash = await hashPassword(randomBytes(32).toString("hex"));
  let account: Awaited<ReturnType<typeof ensureUserAccount>>;
  try {
    account = await ensureUserAccount({
      email,
      siteId: site.id,
      emailSource: PhiUserEmailSource.Admin,
      medusaCustomerId: null,
      passwordHash,
      // Nobody has asked this person which language they want, so the column stays empty and their
      // browser answers for them. Writing the Site default here said they had chosen it.
      preferredLocale: null,
      flags: PhiUserAccountFlag.MustChangePassword,
      reuseExisting: false,
    });
  } catch (ensureError) {
    // Somebody registered the address between the lookup above and this write.
    if (ensureError instanceof Error && ensureError.message === "ACCOUNT_EXISTS") {
      return NextResponse.json({ error: "Account already exists." }, { status: 409 });
    }
    throw ensureError;
  }

  await upsertUserProfile({
    userId: account.id,
    firstName,
    lastName,
    companyName,
  });

  await upsertUserSiteMembership({
    userId: account.id,
    siteId: site.id,
    coreRoleFlags: roleFlags,
  });

  try {
    const messageId = await sendPasswordResetMail({
      request,
      site,
      userId: account.id,
      email,
      locale: site.defaultLocale,
    });

    logRuntimeEvent("info", "mail.sent", {
      siteKey: site.key,
      area: "admin-users",
      userId: account.id,
      targetType: "user",
      targetId: account.id,
      message: "Password reset mail sent.",
      meta: {
        email,
        messageId,
        template: "password-reset",
      },
    });
    } catch (mailError) {
      logRuntimeEvent("error", "mail.failed", {
        siteKey: site.key,
        area: "admin-users",
        userId: account.id,
        targetType: "user",
        targetId: account.id,
        message: "Password reset mail failed.",
        error: normalizeLogThrowable(mailError),
        meta: {
          email,
          template: "password-reset",
      },
    });
  }

  return NextResponse.json({
    userId: account.id,
    email,
    coreRoleFlags: roleFlags,
    roleTags: buildRoleTags(roleFlags),
    changePassword: true,
  });
}

export async function PUT(request: NextRequest) {
  const { context, error } = await requireSiteAdminOnlyApiContext(request);
  if (error) {
    return error;
  }

  if (!context) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const session = context.session;
  if (!session) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const site = context.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const body = await readRequestBody(request);
  const userId = typeof body.userId === "number" && Number.isInteger(body.userId) && body.userId > 0
    ? body.userId
    : typeof body.userId === "string"
      ? parsePositiveInt(body.userId, 0)
      : 0;
  if (!userId) {
    return NextResponse.json({ error: "Missing userId." }, { status: 400 });
  }

  const target = await getUserAccountById(userId, site.id);
  if (!target || !target.siteIds.includes(site.id)) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }
  if (target.medusaCustomerId) {
    return NextResponse.json({ error: "Medusa-managed accounts cannot be edited here." }, { status: 409 });
  }

  const currentMembership = await getUserSiteMembership(target.id, site.id);
  const isSelf = target.id === session.userId;

  const requestedEmail = normalizeString(body.email).toLowerCase();
  const requestedFirstName = normalizeString(body.firstName);
  const requestedLastName = normalizeString(body.lastName);
  const requestedCompanyName = normalizeNullableString(body.companyName);
  // A save that does not mention roles leaves them as they are; read as an empty selection, it took
  // every role away from whoever was edited.
  const requestedRoleFlags = body.roles === undefined
    ? (currentMembership?.coreRoleFlags ?? 0)
    : buildBaseRoleFlagsFromSelection(body.roles);
  const changePassword = normalizeBoolean(body.changePassword);
  const requestedEnabled = typeof body.enabled === "boolean" ? body.enabled : null;
  const effectiveRoleFlags = isSelf ? (currentMembership?.coreRoleFlags ?? 0) : requestedRoleFlags;

  if (!requestedEmail || !requestedFirstName || !requestedLastName) {
    return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
  }

  if (isSelf && body.roles !== undefined && requestedRoleFlags !== (currentMembership?.coreRoleFlags ?? 0)) {
    return NextResponse.json({ error: "Role changes are not allowed for your own account." }, { status: 403 });
  }

  if (isSelf && requestedEnabled !== null && requestedEnabled !== currentMembership?.enabled) {
    return NextResponse.json({ error: "Enabled state changes are not allowed for your own account." }, { status: 403 });
  }

  const existingUser = await getUserAccountByEmail(requestedEmail);
  if (existingUser && existingUser.id !== target.id) {
    return NextResponse.json({ error: "Email already exists." }, { status: 409 });
  }

  const ownsAccount = isAccountOwnedBySite(target, site.id);
  if (!ownsAccount) {
    // The edit form sends the whole record, so a role change arrives with the address and name as they
    // are; only a value that actually differs reaches into the account the other Sites share.
    const profile = await getUserProfileByUserId(target.id);
    const touchesAccount =
      changePassword ||
      requestedEmail !== target.emailNormalized ||
      requestedFirstName !== (profile?.firstName ?? "") ||
      requestedLastName !== (profile?.lastName ?? "") ||
      requestedCompanyName !== (profile?.companyName ?? null);
    if (touchesAccount) {
      return NextResponse.json(ACCOUNT_SHARED_RESPONSE, { status: 409 });
    }
  }

  if (ownsAccount) {
    await updateUserAccountProfileFields(target.id, {
      email: requestedEmail !== target.emailNormalized ? requestedEmail : null,
      emailSource: PhiUserEmailSource.Admin,
      // Nothing about the language here. This save is a name and an address, and it used to turn an
      // unanswered `preferred_locale` into the Site default on its way past -- a choice made for
      // somebody by an edit that was not about it.
    });

    await upsertUserProfile({
      userId: target.id,
      firstName: requestedFirstName,
      lastName: requestedLastName,
      companyName: requestedCompanyName,
    });
  }

  if (!isSelf) {
    await upsertUserSiteMembership({
      userId: target.id,
      siteId: site.id,
      coreRoleFlags: requestedRoleFlags,
    });
  }

  if (requestedEnabled !== null && requestedEnabled !== currentMembership?.enabled) {
    await setAdminUserEnabled(target.id, site.id, requestedEnabled);
    if (!requestedEnabled) {
      await revokeUserSessionsForSite(target.id, site.id);
    }
  }

  if (changePassword) {
    if (!target.passwordHash) {
      await updateUserAccountPasswordHash(target.id, await hashPassword(randomBytes(32).toString("hex")), {
        setFlags: PhiUserAccountFlag.MustChangePassword,
      });
    } else {
      await updateUserAccountFlags(target.id, {
        setFlags: PhiUserAccountFlag.MustChangePassword,
      });
    }
    // Whoever is signed in as this person now is asked for the change at the next sign-in, not later.
    await revokeUserSessionsForSite(target.id, site.id);

    try {
      const messageId = await sendPasswordResetMail({
        request,
        site,
        userId: target.id,
        email: requestedEmail,
        locale: target.preferredLocale ?? site.defaultLocale,
      });

      logRuntimeEvent("info", "mail.sent", {
        siteKey: site.key,
        area: "admin-users",
        userId: target.id,
        targetType: "user",
        targetId: target.id,
        message: "Password reset mail sent.",
        meta: {
          email: requestedEmail,
          messageId,
          template: "password-reset",
        },
      });
    } catch (mailError) {
      logRuntimeEvent("error", "mail.failed", {
        siteKey: site.key,
        area: "admin-users",
        userId: target.id,
        targetType: "user",
        targetId: target.id,
        message: "Password reset mail failed.",
        error: normalizeLogThrowable(mailError),
        meta: {
          email: requestedEmail,
          template: "password-reset",
        },
      });
    }
  }

  return NextResponse.json({
    userId: target.id,
    email: requestedEmail,
    self: isSelf,
    roleTags: buildRoleTags(effectiveRoleFlags),
    coreRoleFlags: effectiveRoleFlags,
    firstName: requestedFirstName,
    lastName: requestedLastName,
    companyName: requestedCompanyName,
    enabled: requestedEnabled ?? currentMembership?.enabled ?? true,
  });
}

export async function PATCH(request: NextRequest) {
  const { context, error } = await requireSiteAdminOnlyApiContext(request);
  if (error) {
    return error;
  }

  if (!context) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const session = context.session;
  if (!session) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const site = context.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const body = await readRequestBody(request);
  const userIdInput = normalize(searchParams.get("userId")) || normalize(String(body.userId ?? ""));
  const enabledInput = searchParams.get("enabled");
  const enabledValue =
    typeof body.enabled === "boolean"
      ? body.enabled
      : enabledInput === null
        ? null
        : ["1", "true", "yes", "on"].includes(enabledInput.trim().toLowerCase());

  const userId = Number.parseInt(userIdInput, 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json({ error: "Missing userId." }, { status: 400 });
  }

  if (typeof enabledValue !== "boolean") {
    return NextResponse.json({ error: "Missing enabled state." }, { status: 400 });
  }

  if (userId === session.userId) {
    return NextResponse.json({ error: "Enabled state changes are not allowed for your own account." }, { status: 403 });
  }

  const updated = await setAdminUserEnabled(userId, site.id, enabledValue);
  if (!updated) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }

  if (!enabledValue) {
    await revokeUserSessionsForSite(userId, site.id);
  }

  return NextResponse.json({
    userId: updated.id,
    enabled: enabledValue,
    siteFlagTags: buildUserSiteFlagTags(updated.siteFlags),
  });
}

export async function DELETE(request: NextRequest) {
  const { context, error } = await requireSiteAdminOnlyApiContext(request);
  if (error) {
    return error;
  }

  if (!context) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const session = context.session;
  if (!session) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const site = context.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const userIdInput = normalize(searchParams.get("userId"));
  const userId = Number.parseInt(userIdInput, 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json({ error: "Missing userId." }, { status: 400 });
  }

  if (userId === session.userId) {
    return NextResponse.json({ error: "You cannot delete your own account here." }, { status: 403 });
  }

  const target = await getUserAccountById(userId, site.id);
  if (!target || !target.siteIds.includes(site.id)) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }
  if (target.medusaCustomerId) {
    return NextResponse.json({ error: "Medusa-managed accounts cannot be deleted here." }, { status: 409 });
  }

  const hardDelete = isAccountOwnedBySite(target, site.id);

  if (hardDelete) {
    await deleteUserAccount(target.id);
  } else {
    await removeUserAccountSiteMembership(target.id, site.id);
  }

  return NextResponse.json({
    userId: target.id,
    siteId: site.id,
    deleted: true,
    hardDeleted: hardDelete,
    remainingSiteIds: hardDelete ? [] : target.siteIds.filter((siteId) => siteId !== site.id),
  });
}
