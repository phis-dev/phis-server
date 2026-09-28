import "server-only";

import { getSiteAuthMethod } from "@/db/site-auth";

/**
 * Whether this Site still offers the password as a way in.
 *
 * The manifest hides the form when an Admin switches the method off, and that was the whole of it: the
 * login handler, both reset handlers, the link confirmation and the registration branch that verifies
 * a password all kept issuing sessions or accepting passwords, because none of them asked. AUTHENTICATION.md
 * §15 says a disabled method fails closed, and closed means here, on the route, not on the button.
 */
export async function isSitePasswordMethodEnabled(siteId: number) {
  const method = await getSiteAuthMethod(siteId, "password", "primary", null);
  return method?.enabled === true;
}

export const PASSWORD_METHOD_DISABLED_RESPONSE = {
  code: "method_disabled",
  error: "Password sign-in is not available on this site.",
} as const;
