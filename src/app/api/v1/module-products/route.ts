import { NextResponse } from "next/server";

import { readPhisSitePackageProductProposal } from "@phis/contracts/products";

import { listSiteModuleProducts } from "@/db/site-module-products.mts";
import { resolvePhisCommandActor } from "@/lib/addons/command-actor";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { getPool } from "@/lib/db";
import { logRuntimeEvent } from "@/lib/log";
import { isPhisModuleMediaPackageName } from "@/lib/module-media";
import { applyModuleProductProposal } from "@/lib/module-products-apply";
import type { PhisModuleProductMapping } from "@/lib/module-products";
import { requireSiteFromRequest } from "@/lib/site-context";

export const dynamic = "force-dynamic";

/**
 * The proposals of the Site's packages that the Site took, with the product each became.
 *
 * What `phis module products sync` reads to post only what is not taken yet, and what `list` reads to say
 * what became of each. Internal token only, the Site named by `x-phis-site-key`, as the Module media routes.
 */
export async function GET(request: Request) {
  const guardError = await guardApiV1(request, { requireInternalToken: true });
  if (guardError) return guardError;
  const site = await requireSiteFromRequest(request);
  if (!site) return NextResponse.json({ error: "site_not_found" }, { status: 404 });
  const mapping: PhisModuleProductMapping = { rows: await listSiteModuleProducts(getPool(), site.id) };
  return NextResponse.json(mapping, { headers: { "cache-control": "private, no-store" } });
}

/**
 * Taking one proposal of one package: `{ package, proposal, as }`.
 *
 * `@phis/products` makes the product with `product.add` as the member `as` names, exactly as
 * `phis addon command` would; the person has to be one who may keep the Site's products (its `editor`
 * role, held by whoever edits the Site's content and by a Site Admin). The answer says what became of the
 * proposal; waiting and refused are answers, not HTTP errors, so a run can go on and report every one.
 */
export async function POST(request: Request) {
  const guardError = await guardApiV1(request, { requireInternalToken: true });
  if (guardError) return guardError;
  const site = await requireSiteFromRequest(request);
  if (!site) return NextResponse.json({ error: "site_not_found" }, { status: 404 });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!isPhisModuleMediaPackageName(body?.package) || typeof body?.as !== "string" || body.as.trim() === "") {
    return NextResponse.json({ error: "package, proposal and as are required." }, { status: 400 });
  }
  const packageName = body.package;
  const { proposal, issues } = readPhisSitePackageProductProposal(packageName, body.proposal);
  if (!proposal) {
    return NextResponse.json({ error: issues.join("; ") || "The proposal is not valid." }, { status: 400 });
  }
  const actor = await resolvePhisCommandActor(site, body.as);
  if (!actor.ok) return NextResponse.json({ error: actor.error }, { status: actor.status });

  const result = await applyModuleProductProposal(site, { packageName, proposal, actorUserId: actor.id });
  logRuntimeEvent(result.status === "refused" ? "warn" : "info", "module.products.proposal", {
    siteKey: site.key,
    meta: { package: packageName, key: proposal.key, productKey: result.productKey, status: result.status, reason: result.reason, actorUserId: actor.id },
  });
  return NextResponse.json({ result });
}
