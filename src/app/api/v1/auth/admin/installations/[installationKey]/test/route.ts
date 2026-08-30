import { NextRequest, NextResponse } from "next/server";

import {
  listAuthProviderInstallations,
  upsertAuthProviderInstallation,
} from "@/db/site-auth";
import {
  normalizeAuthInstallationKey,
  testAuthInstallation,
} from "@/lib/site-auth/installation-catalog";
import { requireAuthAdminSectionContext } from "@/lib/site-auth/admin-sections";
import { logRuntimeEvent } from "@/lib/log";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ installationKey: string }> };

export async function POST(request: NextRequest, routeContext: Context) {
  const { context, error } = await requireAuthAdminSectionContext(request);
  if (error || !context) {
    return error ?? NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const installationKey = normalizeAuthInstallationKey((await routeContext.params).installationKey);
  if (!installationKey) {
    return NextResponse.json({ error: "Unknown installation." }, { status: 404 });
  }
  const installation = (await listAuthProviderInstallations(context.siteId))
    .find((entry) => entry.installationKey === installationKey);
  if (!installation) {
    return NextResponse.json({ error: "Unknown installation." }, { status: 404 });
  }

  const result = await testAuthInstallation(installation);
  const validation = {
    status: result.status,
    testedAt: new Date().toISOString(),
    detail: result.detail,
  };
  await upsertAuthProviderInstallation({ ...installation, validation });
  logRuntimeEvent("info", "auth.admin.installation.tested", {
    siteKey: context.siteKey,
    userId: context.userId,
    method: request.method,
    path: request.nextUrl.pathname,
    meta: { installationKey, status: validation.status },
  });
  return NextResponse.json({ validation });
}
