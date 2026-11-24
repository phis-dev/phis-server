import "server-only";

import type { PhisSiteAddress, PhisUserDescription } from "@phis/contracts/users";

import { ensureEntitlementSubject } from "@/db/entitlements.mts";
import { readPhisCurrentSiteAddresses, readPhisSiteMember, readPhisUserDescriptions, recordPhisUsersAccess } from "@/db/site-users";
import { ensureThreadFile, listThreadsForUser } from "@/db/threads";
import { getPool } from "@/lib/db";
import { PHIS_SITE_ACCESS } from "@/lib/addons/contract";
import type { PhisSiteAccessHolder } from "@/lib/addons/role-inclusion";
import {
  PHIS_USER_FIELD_ALL_BITS,
  PHIS_USER_FIELD_BITS,
  PHIS_USERS_ACCESS_CORE_ADDON_ID,
  PhisUsersAccessOperation,
  PhisUsersAccessRoad,
} from "@/lib/constants/users";

const NAME = PHIS_USER_FIELD_BITS.name;
const EMAIL = PHIS_USER_FIELD_BITS.email;
const PHONE = PHIS_USER_FIELD_BITS.phone;
const ADDRESS = PHIS_USER_FIELD_BITS.address;

export type PhisCustomerFile = {
  person: {
    userId: number;
    displayName: string;
    name?: PhisUserDescription["name"];
    email?: string | null;
    phone?: PhisUserDescription["phone"];
    addresses?: readonly PhisSiteAddress[];
  };
  fileThreadId: number;
  threads: Awaited<ReturnType<typeof listThreadsForUser>>["rows"];
};

/**
 * Staff's file on one member (`GET /api/site/members/{userId}/file`): the person as the staff road of
 * `users:v1` lets the actor read them -- `support` name, e-mail and telephone, `accounting` (a Site Admin
 * too) also the Site's addresses -- the person's file, opened on first asking, and the threads the actor may
 * see that the person takes part in. The read is written to the access log as Core's own (`customerFile`,
 * `@phis/server`). The caller refuses the actor's own file; null for anybody who is no member of the Site.
 */
export async function readPhisCustomerFile(input: {
  siteId: number;
  actorUserId: number;
  holds: PhisSiteAccessHolder;
  userId: number;
  page: number;
  pageSize: number;
}): Promise<PhisCustomerFile | null> {
  const member = await readPhisSiteMember(input.siteId, input.userId);
  if (!member) return null;
  const bits = input.holds(PHIS_SITE_ACCESS.accounting) || input.holds(PHIS_SITE_ACCESS.siteAdmin)
    ? PHIS_USER_FIELD_ALL_BITS
    : input.holds(PHIS_SITE_ACCESS.support) ? NAME | EMAIL | PHONE : 0;
  if (bits === 0) return null;

  const subject = await ensureEntitlementSubject(getPool(), input.siteId, input.userId);
  const [[described], addresses, fileThreadId, threads] = await Promise.all([
    readPhisUserDescriptions({ siteId: input.siteId, subjects: [subject], profile: true, email: true }),
    (bits & ADDRESS) !== 0
      ? readPhisCurrentSiteAddresses(input.siteId, [input.userId], { handedOut: false })
        .then((byUser) => byUser.get(input.userId) ?? [])
      : Promise.resolve(null),
    ensureThreadFile(input.siteId, input.userId),
    listThreadsForUser(input.siteId, input.actorUserId, {
      participantUserId: input.userId,
      page: input.page,
      pageSize: input.pageSize,
    }),
  ]);
  if (fileThreadId == null || !described) return null;

  const profile = described.profile;
  await recordPhisUsersAccess(null, {
    siteId: input.siteId,
    addonId: PHIS_USERS_ACCESS_CORE_ADDON_ID,
    actorUserId: input.actorUserId,
    road: PhisUsersAccessRoad.Staff,
    operation: PhisUsersAccessOperation.CustomerFile,
    subjects: [subject],
    addressIds: (addresses ?? []).map((address) => address.id),
    fields: bits,
  });
  return {
    person: {
      userId: member.userId,
      displayName: member.displayName,
      ...((bits & NAME) !== 0 && profile
        ? { name: { firstName: profile.firstName, lastName: profile.lastName, displayName: profile.displayName, companyName: profile.companyName } }
        : {}),
      ...((bits & EMAIL) !== 0 ? { email: described.email } : {}),
      ...((bits & PHONE) !== 0 ? { phone: { phone: profile?.phone ?? null, mobile: profile?.mobile ?? null } } : {}),
      ...(addresses ? { addresses } : {}),
    },
    fileThreadId,
    threads: threads.rows,
  };
}
