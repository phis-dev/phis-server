import "server-only";

import { getUserAccountByEmail, getUserAccountById } from "@/db/user-accounts";
import { PhiUserAccountFlag } from "@/lib/constants/user-account-flags";

/**
 * The person an operator names for a command (`--as`): an address or an account id, a member of the Site
 * and not disabled -- a person who cannot sign in here could not have done it in the browser either.
 *
 * Asked by the internal routes only (`/api/v1/addons/commands`, `/api/v1/module-products`), which is what
 * makes naming somebody safe: only the operator holds the internal token.
 */
export async function resolvePhisCommandActor(
  site: { id: number; key: string },
  who: string,
): Promise<{ ok: true; id: number; email: string } | { ok: false; status: 404 | 409; error: string }> {
  const named = who.trim();
  const account = /^\d+$/.test(named)
    ? await getUserAccountById(Number(named))
    : await getUserAccountByEmail(named);
  if (!account || !account.siteIds.includes(site.id)) {
    return { ok: false, status: 404, error: `${named} is not a member of ${site.key}.` };
  }
  if ((account.flags & PhiUserAccountFlag.Disabled) !== 0) {
    return { ok: false, status: 409, error: `${named} is disabled.` };
  }
  return { ok: true, id: account.id, email: account.emailNormalized };
}
