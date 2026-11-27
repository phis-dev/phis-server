import { NextRequest, NextResponse } from "next/server";

import { readPhisBillingDocument } from "@/db/billing.mts";
import { getPool } from "@/lib/db";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { verifyPhisBillingOpen } from "@/lib/billing/documents";
import { readPhisBillingFile } from "@/lib/billing/store";
import { renderPhisBillingContentPage } from "@/lib/billing/content-page";
import { requireSiteFromRequest } from "@/lib/site-context";

export const dynamic = "force-dynamic";

/**
 * Serves one billing document's file -- or, for a receipt or confirmation issued without one, Core's page of
 * its content -- to the browser that was given the address by `open` (`billing:v1`, the account and
 * Accounting routes). The signature names the document, the disposition and the end; nothing else opens
 * it, and nothing is cached. `404` for a signature that does not hold, a document gone or not available.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardApiV1(request, { requireInternalToken: true });
  if (guard) return guard;
  const site = await requireSiteFromRequest(request);
  const id = (await params).id;
  const query = request.nextUrl.searchParams;
  const disposition = site ? verifyPhisBillingOpen(site.id, id, { d: query.get("d"), e: query.get("e"), s: query.get("s") }) : null;
  const document = site && disposition ? await readPhisBillingDocument(getPool(), site.id, id) : null;
  if (!site || !disposition || !document || document.record.status !== "available") return NextResponse.json({ error: "Not found." }, { status: 404 });
  const name = `${(document.record.number ?? document.record.kind).replace(/[^A-Za-z0-9._-]/g, "_")}`;
  const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
  if (!document.record.file || !document.storageKey) {
    if (!document.record.content) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return new NextResponse(renderPhisBillingContentPage(document.record), { headers: { ...headers, "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "content-disposition": `${disposition}; filename="${name}.html"` } });
  }
  const body = await readPhisBillingFile(site.id, site.key, document.storageKey);
  if (!body) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const html = document.record.file.contentType === "text/html";
  return new NextResponse(body, { headers: { ...headers, "content-type": html ? "text/html; charset=utf-8" : "application/pdf",
    "content-length": String(document.record.file.byteSize),
    // A Provider's HTML receipt is shown, never run: no script, no request of its own.
    ...(html ? { "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox" } : {}),
    "content-disposition": `${disposition}; filename="${name}.${html ? "html" : "pdf"}"` } });
}
