import { GET as handleCsrf } from "@/app/api/auth/csrf/route";
import { guardApiV1 } from "@/lib/api-v1-guard";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return guardApiV1(request, { requireInternalToken: true }) ?? handleCsrf();
}
