import { GET as issueCsrfToken } from "@/lib/site-auth/handlers/csrf";

export const dynamic = "force-dynamic";

/**
 * The CSRF token the operator login form sends back. The operator console is served by this server, so it
 * asks here rather than through a Site's `/api/auth` door, which reaches Core only with the Site's token.
 */
export async function GET() {
  return issueCsrfToken();
}
