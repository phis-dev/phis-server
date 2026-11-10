import { GET as handleCsrf } from "@/lib/site-auth/handlers/csrf";
import { guardApiV1 } from "@/lib/api-v1-guard";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return (await guardApiV1(request, { requireInternalToken: true })) ?? handleCsrf();
}
