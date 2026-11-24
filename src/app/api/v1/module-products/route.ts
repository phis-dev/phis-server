import { NextResponse } from "next/server";

import { readPhisSitePackageProductProposal } from "@phis/contracts/products";

import { listSiteModuleProductProposals, listSiteModuleProducts } from "@/db/site-module-products.mts";
import { resolvePhisCommandActor } from "@/lib/addons/command-actor";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { getPool } from "@/lib/db";
import { logRuntimeEvent } from "@/lib/log";
import { isPhisModuleMediaPackageName } from "@/lib/module-media";
import { applyModuleProductProposal, recordModuleProductProposals } from "@/lib/module-products-apply";
import type { PhisModuleProductMapping } from "@/lib/module-products";
import { requireSiteFromRequest } from "@/lib/site-context";

export const dynamic = "force-dynamic";

/**
 * The proposals of the Site's packages that the Site took, with the product each became (`rows`), and the
 * proposals Core keeps for the Builder's activation with why each still waits (`proposals`).
 *
 * What `phis module products sync` reads to post only what is not taken yet, and what `list` reads to say
 * what became of each. Internal token only, the Site named by `x-phis-site-key`, as the Module media routes.
 */
export async function GET(request: Request) {
  const guardError = await guardApiV1(request, { requireInternalToken: true });
  if (guardError) return guardError;
  const site = await requireSiteFromRequest(request);
  if (!site) return NextResponse.json({ error: "site_not_found" }, { status: 404 });
  const [rows, stored] = await Promise.all([listSiteModuleProducts(getPool(), site.id), listSiteModuleProductProposals(getPool(), site.id)]);
  const mapping: PhisModuleProductMapping = {
    rows,
    proposals: stored.map(({ packageName, key, waitingReason, waitingDetail }) => ({ packageName, key, waitingReason, waitingDetail })),
  };
  return NextResponse.json(mapping, { headers: { "cache-control": "private, no-store" } });
}

/**
 * Handing over what one package proposes, `{ package, proposals }`, or taking one proposal of it now,
 * `{ package, proposal, as }`.
 *
 * Handed over, the package's whole list replaces the one Core keeps (an empty list drops it), and is taken
 * when a Site Admin activates the package in the Builder, as that admin; the answer is `{ results }`, each
 * `taken` or `waiting` (`activation`). Every proposal is read as one is below, and one that is not valid
 * refuses the whole hand-over.
 *
 * Taken now:
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
  if (isPhisModuleMediaPackageName(body?.package) && body.as === undefined && body.proposal === undefined && Array.isArray(body.proposals)) {
    const handedOver = body.package;
    const read = body.proposals.map((entry) => readPhisSitePackageProductProposal(handedOver, entry));
    const issues = read.flatMap((entry) => entry.issues);
    const keys = read.flatMap((entry) => (entry.proposal ? [entry.proposal.key] : []));
    if (issues.length > 0 || new Set(keys).size !== keys.length) {
      return NextResponse.json({ error: issues.join("; ") || "A proposal key is named twice." }, { status: 400 });
    }
    const results = await recordModuleProductProposals(site, {
      packageName: handedOver,
      proposals: read.map((entry) => entry.proposal!),
    });
    return NextResponse.json({ results });
  }
  if (!isPhisModuleMediaPackageName(body?.package) || typeof body?.as !== "string" || body.as.trim() === "") {
    return NextResponse.json({ error: "package with proposals, or package, proposal and as, are required." }, { status: 400 });
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
