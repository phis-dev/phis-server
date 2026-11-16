import { NextResponse } from "next/server";

import { guardApiV1 } from "@/lib/api-v1-guard";
import { logRuntimeEvent } from "@/lib/log";
import { isPhisModuleMediaKey, isPhisModuleMediaPackageName } from "@/lib/module-media";
import { bindModuleMedia, type PhisModuleMediaBindInput } from "@/lib/module-media-import";
import { requireSiteFromRequest } from "@/lib/site-context";

export const dynamic = "force-dynamic";

/**
 * Pointing a declared name at an Asset or Folder of the Site by hand, or taking that back.
 *
 * Body: `{ package, key, asset }`, `{ package, key, folder }` or `{ package, key, reset: true }`. The target
 * is validated here, not by the caller: it has to lie in this Site's Site Space. Internal token only.
 */
export async function POST(request: Request) {
  const guardError = await guardApiV1(request, { requireInternalToken: true });
  if (guardError) return guardError;
  const site = await requireSiteFromRequest(request);
  if (!site) return NextResponse.json({ error: "site_not_found" }, { status: 404 });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const isId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  const modes = [body?.asset !== undefined, body?.folder !== undefined, body?.reset !== undefined].filter(Boolean).length;
  if (!isPhisModuleMediaPackageName(body?.package) || !isPhisModuleMediaKey(body?.key) || modes !== 1) {
    return NextResponse.json({ error: "package, key and exactly one of asset, folder, reset are required." }, { status: 400 });
  }
  let input: PhisModuleMediaBindInput;
  if (isId(body.asset)) input = { packageName: body.package, key: body.key, asset: body.asset };
  else if (isId(body.folder)) input = { packageName: body.package, key: body.key, folder: body.folder };
  else if (body.reset === true) input = { packageName: body.package, key: body.key, reset: true };
  else return NextResponse.json({ error: "asset and folder are ids; reset is true." }, { status: 400 });

  const result = await bindModuleMedia(site, input);
  logRuntimeEvent(result.ok ? "info" : "warn", "module.media.bind", {
    siteKey: site.key,
    meta: { package: input.packageName, key: input.key, ok: result.ok, ...(result.ok ? { action: result.action } : { reason: result.reason }) },
  });
  return NextResponse.json({ result });
}
