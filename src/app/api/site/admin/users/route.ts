import { randomBytes } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import {
  deleteUserAccount,
  ensureUserAccount,
  getUserAccountByEmail,
  getUserAccountById,
  removeUserAccountSiteMembership,
} from "@/db/user-accounts";
import { readPhiSiteUserAddonRoles, readPhiSiteUsersAddonRoles } from "@/db/server-addon-roles.mts";
import { saveSiteUser } from "@/db/user-admin-save";
import { listAdminUsersForSite, setAdminUserEnabled } from "@/db/user-admin";
import { createUserPasswordResetToken } from "@/db/user-password-reset-tokens";
import { getUserProfileByUserId, upsertUserProfile } from "@/db/user-profiles";
import { getUserSiteMembership, upsertUserSiteMembership } from "@/db/user-site-memberships";
import { readAvailablePhisProviderIds } from "@/lib/addons/capability-snapshot";
import { listPhisAddonRolesImplying } from "@/lib/addons/role-inclusion";
import { PHIS_SITE_ACCESS } from "@/lib/addons/contract";
import { phisSiteAccessCoreRoleFlags, phisSiteAccessHolderOfCoreRoles } from "@/lib/addons/site-access";
import { mayGrantPhisAddonRole } from "@/lib/addons/role-granting";
import {
  listPhiCountingAddonDeclaredRoles,
  listPhiCountingAddonRolesHeldThroughSiteAccess,
  listPhiInstalledAddonImpliedSiteAccesses,
  selectPhiCountingAddonRoles,
  type PhiCountingAddonRoleHeldThroughSiteAccess,
} from "@/lib/addons/viewer-roles";
import { getPool } from "@/lib/db";
import { requireSiteAdminOnlyApiContext } from "@/lib/guards/site-admin-api";
import { PHI_BASE_ROLE_OPTIONS } from "@/lib/constants/phi-base-role-metadata";
import { PhiUserAccountFlag } from "@/lib/constants/user-account-flags";
import { buildPasswordResetUrlForLocale } from "@/lib/email";
import { getSiteMailConfig } from "@/lib/form-config";
import { notifyPhiPerson } from "@/lib/notifications/enqueue";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
import { hashPassword } from "@/lib/password";
import { hasPhiFlag } from "@/lib/helpers/flags";
import { listUserSessionsForSite, revokeUserSessionsForSite } from "@/db/user-sessions";
import { resolveUserAccountFlagTags } from "@/lib/user-flags";
import { USER_SITE_FLAG_DISABLED, USER_SITE_FLAG_NEWSLETTER_OPT_IN } from "@/lib/user-site-flags";
import {
  normalizeNullableString,
  normalizeString,
  parsePhiPagination,
  parsePositiveIntWithFallback,
  parseStrictPositiveInt,
  readRequestBody,
} from "@/lib/helpers/request";

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

function normalizeBoolean(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  }

  return false;
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
  if (normalized === "staff" || normalized === "customer") {
    return normalized;
  }

  return "all";
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

type AddonRoleAssignment = { addonId: string; role: string };

/**
 * The `addonRoles` of a save: the stored Add-on roles the person is to hold afterwards, one string
 * `"<addonId>:<role>"` per role (the value the user-management options Provider gives each role), split at its
 * last colon; one Add-on may appear several times. Anything but a list of such strings is null, a malformed list.
 */
function parseAddonRolesSelection(value: unknown): AddonRoleAssignment[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const entries: AddonRoleAssignment[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return null;
    }
    const cut = entry.lastIndexOf(":");
    const addonId = cut > 0 ? entry.slice(0, cut) : undefined;
    const role = cut > 0 ? entry.slice(cut + 1) : undefined;
    if (
      addonId === undefined || role === undefined ||
      !addonId.trim() || addonId.length > 255 || !role.trim() || role.length > 64
    ) {
      return null;
    }
    entries.push({ addonId: addonId.trim(), role: role.trim() });
  }
  return entries;
}

/**
 * The Add-on roles that count on this Site for each of the given members, as the list shows them, from one read
 * of the grants for all of them:
 *
 * - `stored`, the stored grants, narrowed to the ones that count -- the rule the viewer's `addonRoleClaims`
 *   apply -- but not expanded through `includes` and not widened for a Site Admin: what was granted is shown.
 *   The UI recognises a Site Admin by `roleTags` containing "admin".
 * - `implied`, what a Site access hands the member without a grant (`impliedBy`, with what it includes), each
 *   naming the access (`listPhiCountingAddonRolesHeldThroughSiteAccess`), whether or not it is stored as well;
 *   none for a Site Admin or a disabled membership. Answered from the `enabled` and Core role flags the caller
 *   read with the members (`phisSiteAccessHolderOfCoreRoles`), never per role or per member.
 *
 * The capability snapshot is read only when there is something to narrow: a grant on the page, or a member
 * holding a Site access an enabled Add-on hangs a role on.
 */
async function readCountingAddonRoles(
  siteId: number,
  members: readonly { id: number; enabled: boolean; coreRoleFlags: number }[],
  known: ReadonlySet<string> | null = null,
) {
  const grants = await readPhiSiteUsersAddonRoles(getPool(), { siteId, userIds: members.map((member) => member.id) });
  const holders = new Map(members.map((member) => [member.id, phisSiteAccessHolderOfCoreRoles(member)] as const));
  const impliedAccesses = listPhiInstalledAddonImpliedSiteAccesses();
  const mayImply = [...holders.values()].some((holds) =>
    !holds(PHIS_SITE_ACCESS.siteAdmin) && impliedAccesses.some((access) => holds(access)));
  const availableProviderIds = grants.size > 0 || mayImply
    ? (known ?? await readAvailablePhisProviderIds(siteId))
    : new Set<string>();
  return (userId: number): { stored: AddonRoleAssignment[]; implied: PhiCountingAddonRoleHeldThroughSiteAccess[] } => {
    const counting = selectPhiCountingAddonRoles(grants.get(userId) ?? [], availableProviderIds);
    const holds = holders.get(userId);
    return {
      stored: [...counting].flatMap(([addonId, roles]) => roles.map((role) => ({ addonId, role }))),
      implied: holds ? listPhiCountingAddonRolesHeldThroughSiteAccess(availableProviderIds, holds) : [],
    };
  };
}

async function sendPasswordResetMail(input: {
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
  const resetUrl = buildPasswordResetUrlForLocale(
    siteConfig.publicBaseUrl,
    resetToken.token,
    input.locale,
  );
  // Neither the address nor the name goes in: the outbox resolves both when it sends, which is also what
  // keeps an administrator from mailing an address the account no longer has.
  return notifyPhiPerson({
    siteId: input.site.id,
    occasion: "password_reset",
    recipient: { userId: input.userId, locale: input.locale },
    params: { verificationUrl: resetUrl },
  });
}

/**
 * The Site's users, one page, each with the Core roles, the stored Add-on roles they were given and, as `impliedAddonRoles`, the ones a Site access hands them without a grant (a Site Admin holds every role besides); filterable by account type, enabled state, `addonId` and `addonRole`. `?userId=` answers the one user, with `addonRoles` as a list of `"<addonId>:<role>"` strings, one per role.
 */
export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteAdminOnlyApiContext(request);
  if (error) {
    return error;
  }

  const session = context.session;

  const site = context.site;

  const { searchParams } = new URL(request.url);
  // Ids are read strictly: "12abc" names nobody, and must not become user 12.
  const historyUserParam = searchParams.get("historyUserId");
  const historyUserId = historyUserParam === null ? null : parseStrictPositiveInt(historyUserParam);
  if (historyUserParam !== null && !historyUserId) {
    return NextResponse.json({ error: "Invalid historyUserId." }, { status: 400 });
  }
  if (historyUserId) {
    const target = await getUserAccountById(historyUserId);
    if (!target || !target.siteIds.includes(site.id)) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    const sessions = await listUserSessionsForSite(historyUserId, site.id, parsePositiveIntWithFallback(searchParams.get("limit"), 25));
    return NextResponse.json({
      userId: historyUserId,
      sessions,
    });
  }

  const userParam = searchParams.get("userId");
  const userId = userParam === null ? null : parseStrictPositiveInt(userParam);
  if (userParam !== null && !userId) {
    return NextResponse.json({ error: "Invalid userId." }, { status: 400 });
  }
  if (userId) {
    const [target, profile, membership] = await Promise.all([
      getUserAccountById(userId),
      getUserProfileByUserId(userId),
      getUserSiteMembership(userId, site.id),
    ]);
    if (!target || !target.siteIds.includes(site.id) || !membership) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }
    const addonRoles = (await readCountingAddonRoles(site.id, [{ ...membership, id: target.id }]))(target.id);
    return NextResponse.json({
      user: {
        id: target.id,
        email: target.emailNormalized,
        firstName: profile?.firstName ?? "",
        lastName: profile?.lastName ?? "",
        displayName: profile?.displayName ?? "",
        companyName: profile?.companyName ?? "",
        enabled: membership.enabled,
        coreRoleFlags: membership.coreRoleFlags,
        roleTags: buildRoleTags(membership.coreRoleFlags),
        addonRoles: addonRoles.stored.map(({ addonId, role }) => `${addonId}:${role}`),
        impliedAddonRoles: addonRoles.implied,
        self: target.id === session.userId,
      },
    });
  }

  // An Add-on role filter. A malformed value is the caller's mistake; a well-formed one naming an Add-on
  // this Site does not run, or a role it does not declare, matches nobody.
  const addonIdParam = searchParams.get("addonId");
  const addonRoleParam = searchParams.get("addonRole");
  const addonIdFilter = addonIdParam === null ? null : addonIdParam.trim();
  const addonRoleFilter = addonRoleParam === null ? null : addonRoleParam.trim();
  if (addonIdFilter !== null && (!addonIdFilter || addonIdFilter.length > 255)) {
    return NextResponse.json({ error: "Invalid addonId." }, { status: 400 });
  }
  if (addonRoleFilter !== null && addonIdFilter === null) {
    return NextResponse.json({ error: "addonRole requires addonId." }, { status: 400 });
  }
  if (addonRoleFilter !== null && !/^[a-z][a-z0-9-]{0,63}$/.test(addonRoleFilter)) {
    return NextResponse.json({ error: "Invalid addonRole." }, { status: 400 });
  }
  let addonRoles: { addonId: string; roles: string[]; impliedByRoleFlags: number } | undefined;
  let availableProviderIds: ReadonlySet<string> | null = null;
  if (addonIdFilter !== null) {
    availableProviderIds = await readAvailablePhisProviderIds(site.id);
    const declared = listPhiCountingAddonDeclaredRoles(availableProviderIds).get(addonIdFilter) ?? [];
    // A named role is held stored or through a role that includes it, as `roles:v1` has() answers; the
    // query adds the enabled Site Admins, who hold every declared role, and the enabled holders of a Site
    // access one of those roles is implied by.
    const roles = addonRoleFilter === null
      ? declared.map((role) => role.name)
      : listPhisAddonRolesImplying(declared, addonRoleFilter);
    addonRoles = {
      addonId: addonIdFilter,
      roles,
      impliedByRoleFlags: declared.reduce((flags, role) =>
        role.impliedBy !== undefined && roles.includes(role.name)
          ? flags | phisSiteAccessCoreRoleFlags(role.impliedBy.siteAccess)
          : flags, 0),
    };
  }

  const result = await listAdminUsersForSite(site.id, {
    addonRoles,
    search: normalize(searchParams.get("search")) || normalize(searchParams.get("q")),
    accountType: parseAccountType(searchParams.get("accountType")),
    enabled: parseEnabledFilter(searchParams.get("enabled")),
    sortKey: normalize(searchParams.get("sortKey")),
    sortOrder: normalize(searchParams.get("sortOrder")).toLowerCase() as "ascend" | "descend" | "",
    ...parsePhiPagination(searchParams, 20),
  });

  // The page's stored grants in one read; what a Site access implies from the rows' own Core roles.
  const addonRolesOf = await readCountingAddonRoles(site.id, result.rows, availableProviderIds);

  const rows = result.rows.map((row) => {
    const addonRoles = addonRolesOf(row.id);
    return {
      id: row.id,
      name: row.displayName,
      email: row.emailNormalized,
      accountType: row.accountType,
      enabled: row.enabled,
      userFlagTags: resolveUserAccountFlagTags(row.flags),
      siteFlagTags: buildUserSiteFlagTags(row.siteFlags),
      roleTags: buildRoleTags(row.coreRoleFlags),
      addonRoles: addonRoles.stored,
      impliedAddonRoles: addonRoles.implied,
      coreRoleFlags: row.coreRoleFlags,
      lastLoginAt: row.lastLoginAt,
      createdAt: row.createdAt,
      companyName: row.companyName,
      firstName: row.firstName,
      lastName: row.lastName,
      self: row.id === session.userId,
    };
  });

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

  const site = context.site;

  const body = await readRequestBody(request);
  const email = normalizeString(body.email).toLowerCase();
  const firstName = normalizeString(body.firstName);
  const lastName = normalizeString(body.lastName);
  const companyName = normalizeNullableString(body.companyName);
  const displayName = normalizeNullableString(body.displayName);
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
      await upsertUserProfile({ userId: existingUser.id, firstName, lastName, displayName, companyName });
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
    displayName,
    companyName,
  });

  await upsertUserSiteMembership({
    userId: account.id,
    siteId: site.id,
    coreRoleFlags: roleFlags,
  });

  try {
    const messageId = await sendPasswordResetMail({
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

/**
 * Saves one user: name, address, Core roles, enabled state and, with `addonRoles`, the stored Add-on roles over every Add-on that counts on the Site (enabled and available, the set `GET` shows), in one transaction (AUTHORIZATION.md section 5). `addonRoles` is a flat list of `"<addonId>:<role>"` strings, one per role; the answer carries it in the same form.
 */
export async function PUT(request: NextRequest) {
  const { context, error } = await requireSiteAdminOnlyApiContext(request);
  if (error) {
    return error;
  }

  const session = context.session;

  const site = context.site;

  const body = await readRequestBody(request);
  const userId = parseStrictPositiveInt(body.userId);
  if (!userId) {
    return NextResponse.json({ error: "Missing userId." }, { status: 400 });
  }

  const target = await getUserAccountById(userId);
  if (!target || !target.siteIds.includes(site.id)) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }

  const currentMembership = await getUserSiteMembership(target.id, site.id);
  const isSelf = target.id === session.userId;

  const requestedEmail = normalizeString(body.email).toLowerCase();
  const requestedFirstName = normalizeString(body.firstName);
  const requestedLastName = normalizeString(body.lastName);
  const requestedCompanyName = normalizeNullableString(body.companyName);
  // Absent leaves the stored name alone, like a profile write that does not know about it.
  const requestedDisplayName = Object.hasOwn(body, "displayName") ? normalizeNullableString(body.displayName) : undefined;
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

  // The stored Add-on roles the person is to hold afterwards, over every Add-on that counts on this Site;
  // absent leaves them as they are, which is what every caller before this field did.
  const wantedAddonRoles = body.addonRoles === undefined ? null : parseAddonRolesSelection(body.addonRoles);
  if (body.addonRoles !== undefined && wantedAddonRoles === null) {
    return NextResponse.json({ error: "addonRoles must be a list of \"<addonId>:<role>\" strings." }, { status: 400 });
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
      requestedCompanyName !== (profile?.companyName ?? null) ||
      (requestedDisplayName !== undefined && requestedDisplayName !== (profile?.displayName ?? null));
    if (touchesAccount) {
      return NextResponse.json(ACCOUNT_SHARED_RESPONSE, { status: 409 });
    }
  }

  /*
   * The Add-on roles are a difference to what is stored, over the Add-ons that count here
   * (`listPhiCountingAddonDeclaredRoles`: enabled and available) -- the set `GET` reads them from, so a save
   * that sends back what it was shown changes nothing. Each role to give and each role to take back needs the
   * actor's standing, as it would one at a time through `PUT /api/site/addon-roles`, and a single refusal
   * stores nothing -- the person included. A stored role of an Add-on outside that set (not enabled here, or
   * enabled but not available), or one its manifest no longer declares, is not shown and is left as it is;
   * naming a role of such an Add-on is refused as `addon_unknown`.
   */
  let addonRoleChange: { grant: AddonRoleAssignment[]; revoke: AddonRoleAssignment[] } | null = null;
  let availableProviderIds: ReadonlySet<string> | null = null;
  if (wantedAddonRoles !== null) {
    if (!currentMembership) {
      return NextResponse.json({ error: "user_not_member" }, { status: 404 });
    }
    availableProviderIds = await readAvailablePhisProviderIds(site.id);
    const declaredByAddon = listPhiCountingAddonDeclaredRoles(availableProviderIds);
    for (const { addonId, role } of wantedAddonRoles) {
      const declared = declaredByAddon.get(addonId);
      if (declared === undefined) {
        return NextResponse.json({ error: "addon_unknown", addonId, role }, { status: 404 });
      }
      if (!declared.some((descriptor) => descriptor.name === role)) {
        return NextResponse.json({ error: "role_undeclared", addonId, role }, { status: 404 });
      }
    }
    const wanted = new Set(wantedAddonRoles.map(({ addonId, role }) => `${addonId}\u0000${role}`));
    const held = new Set((await readPhiSiteUserAddonRoles(getPool(), { siteId: site.id, userId: target.id }))
      .map(({ addonId, role }) => `${addonId}\u0000${role}`));
    const grant: AddonRoleAssignment[] = [];
    const revoke: AddonRoleAssignment[] = [];
    for (const [addonId, declared] of declaredByAddon) {
      for (const { name: role } of declared) {
        const key = `${addonId}\u0000${role}`;
        if (wanted.has(key) === held.has(key)) {
          continue;
        }
        const verdict = await mayGrantPhisAddonRole({
          addonId,
          siteId: site.id,
          actorUserId: session.userId,
          role,
          declared,
        });
        if (!verdict.allowed) {
          return NextResponse.json(
            { error: verdict.reason, addonId, role },
            { status: verdict.reason === "not_permitted" ? 403 : 404 },
          );
        }
        (wanted.has(key) ? grant : revoke).push({ addonId, role });
      }
    }
    addonRoleChange = { grant, revoke };
  }

  let savedAddonRoles: Awaited<ReturnType<typeof saveSiteUser>>;
  try {
    savedAddonRoles = await saveSiteUser({
      siteId: site.id,
      userId: target.id,
      actorUserId: session.userId,
      account: ownsAccount
        ? {
            newEmail: requestedEmail !== target.emailNormalized ? requestedEmail : null,
            firstName: requestedFirstName,
            lastName: requestedLastName,
            displayName: requestedDisplayName,
            companyName: requestedCompanyName,
          }
        : null,
      coreRoleFlags: isSelf ? null : requestedRoleFlags,
      enabled: requestedEnabled !== null && requestedEnabled !== currentMembership?.enabled ? requestedEnabled : null,
      passwordReset: changePassword
        ? { newPasswordHash: target.passwordHash ? null : await hashPassword(randomBytes(32).toString("hex")) }
        : null,
      addonRoles: addonRoleChange,
    });
  } catch (saveError) {
    // Somebody took the address between the check above and this write; nothing of the save is stored.
    if (saveError instanceof Error && saveError.message === "EMAIL_TAKEN") {
      return NextResponse.json({ error: "Email already exists." }, { status: 409 });
    }
    throw saveError;
  }
  for (const { addonId, role } of savedAddonRoles.granted) {
    logRuntimeEvent("info", "addon.role.granted", {
      siteKey: site.key,
      pluginKey: addonId,
      meta: { role, userId: target.id, added: true },
    });
  }
  for (const { addonId, role } of savedAddonRoles.revoked) {
    logRuntimeEvent("info", "addon.role.revoked", {
      siteKey: site.key,
      pluginKey: addonId,
      meta: { role, userId: target.id, removed: true },
    });
  }

  if (changePassword) {
    try {
      const messageId = await sendPasswordResetMail({
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

  const savedEnabled = requestedEnabled ?? currentMembership?.enabled ?? true;
  const savedRoles = (await readCountingAddonRoles(
    site.id,
    [{ id: target.id, enabled: savedEnabled, coreRoleFlags: effectiveRoleFlags }],
    availableProviderIds,
  ))(target.id);
  return NextResponse.json({
    userId: target.id,
    email: requestedEmail,
    self: isSelf,
    roleTags: buildRoleTags(effectiveRoleFlags),
    coreRoleFlags: effectiveRoleFlags,
    firstName: requestedFirstName,
    lastName: requestedLastName,
    companyName: requestedCompanyName,
    enabled: savedEnabled,
    // As `GET ?userId=` answers them (`"<addonId>:<role>"` strings, `impliedAddonRoles` beside), read after the commit.
    addonRoles: savedRoles.stored.map(({ addonId, role }) => `${addonId}:${role}`),
    impliedAddonRoles: savedRoles.implied,
  });
}

export async function PATCH(request: NextRequest) {
  const { context, error } = await requireSiteAdminOnlyApiContext(request);
  if (error) {
    return error;
  }

  const session = context.session;

  const site = context.site;

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

  const userId = parseStrictPositiveInt(userIdInput);
  if (!userId) {
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

  const session = context.session;

  const site = context.site;

  const { searchParams } = new URL(request.url);
  const userIdInput = normalize(searchParams.get("userId"));
  const userId = parseStrictPositiveInt(userIdInput);
  if (!userId) {
    return NextResponse.json({ error: "Missing userId." }, { status: 400 });
  }

  if (userId === session.userId) {
    return NextResponse.json({ error: "You cannot delete your own account here." }, { status: 403 });
  }

  const target = await getUserAccountById(userId);
  if (!target || !target.siteIds.includes(site.id)) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
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
