import "server-only";

import { PhiUserEmailSource } from "@phis/contracts/access";

import { replacePhisUserAddonRoles } from "@/db/server-addon-roles.mts";
import { setAdminUserEnabled } from "@/db/user-admin";
import {
  updateUserAccountFlags,
  updateUserAccountPasswordHash,
  updateUserAccountProfileFields,
} from "@/db/user-accounts";
import { upsertUserProfile } from "@/db/user-profiles";
import { upsertUserSiteMembership } from "@/db/user-site-memberships";
import { revokeUserSessionsForSite } from "@/db/user-sessions";
import { withTransaction } from "@/lib/db";
import { PhiUserAccountFlag } from "@/lib/constants/user-account-flags";

/**
 * What one save of a Site user in user administration writes, already decided by the caller.
 *
 * The caller has refused everything it can refuse (who may change what, who owns the account, which Add-on
 * roles the actor may give or take); what is left is the write, and the write is one transaction.
 */
export type SiteUserSave = {
  siteId: number;
  userId: number;
  /** The acting Site Admin, recorded as the one who granted Add-on roles. */
  actorUserId: number;
  /** The account's own fields, only where this Site owns the account alone; null leaves them as they are. */
  account: null | {
    newEmail: string | null;
    firstName: string;
    lastName: string;
    /** Absent leaves the stored name alone, null clears it. */
    displayName: string | null | undefined;
    companyName: string | null;
  };
  /** The Core role flags to store, or null where this save does not write them. */
  coreRoleFlags: number | null;
  /** A change of the membership's enabled state; disabling ends the person's sessions on this Site. */
  enabled: boolean | null;
  /** Ask for a password change at the next sign-in; a hash is given only where the account has none yet. */
  passwordReset: null | { newPasswordHash: string | null };
  /** The Add-on roles to give and take, as the difference already checked; null leaves them alone. */
  addonRoles: null | {
    grant: readonly { addonId: string; role: string }[];
    revoke: readonly { addonId: string; role: string }[];
  };
};

/**
 * Saves the person and, when the save carries them, the Add-on roles in ONE transaction: whatever fails,
 * nothing of it is stored. Sessions are ended in the same transaction, so a rolled-back save never signs
 * anybody out.
 */
export async function saveSiteUser(input: SiteUserSave) {
  return withTransaction(async (client) => {
    if (input.account) {
      await updateUserAccountProfileFields(input.userId, {
        email: input.account.newEmail,
        emailSource: PhiUserEmailSource.Admin,
        // Nothing about the language here: this save is a name and an address.
      }, client);
      await upsertUserProfile({
        userId: input.userId,
        firstName: input.account.firstName,
        lastName: input.account.lastName,
        displayName: input.account.displayName,
        companyName: input.account.companyName,
      }, client);
    }

    if (input.coreRoleFlags !== null) {
      await upsertUserSiteMembership({
        userId: input.userId,
        siteId: input.siteId,
        coreRoleFlags: input.coreRoleFlags,
      }, client);
    }

    if (input.enabled !== null) {
      await setAdminUserEnabled(input.userId, input.siteId, input.enabled, client);
      if (!input.enabled) {
        await revokeUserSessionsForSite(input.userId, input.siteId, client);
      }
    }

    if (input.passwordReset) {
      if (input.passwordReset.newPasswordHash !== null) {
        await updateUserAccountPasswordHash(input.userId, input.passwordReset.newPasswordHash, {
          setFlags: PhiUserAccountFlag.MustChangePassword,
        }, client);
      } else {
        await updateUserAccountFlags(input.userId, { setFlags: PhiUserAccountFlag.MustChangePassword }, client);
      }
      // Whoever is signed in as this person now is asked for the change at the next sign-in, not later.
      await revokeUserSessionsForSite(input.userId, input.siteId, client);
    }

    if (input.addonRoles && (input.addonRoles.grant.length > 0 || input.addonRoles.revoke.length > 0)) {
      return await replacePhisUserAddonRoles(client, {
        siteId: input.siteId,
        userId: input.userId,
        grant: input.addonRoles.grant,
        revoke: input.addonRoles.revoke,
        grantedByUserId: input.actorUserId,
      });
    }
    return { granted: [], revoked: [] };
  });
}
