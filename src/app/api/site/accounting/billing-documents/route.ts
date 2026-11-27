import { NextRequest, NextResponse } from "next/server";

import type { PhisBillingDocument, PhisBillingPaymentState } from "@phis/contracts/billing";

import { findPhisBillingSubjectOfUser, listPhisBillingDocuments } from "@/db/billing.mts";
import { getPool } from "@/lib/db";
import { requireSiteBillingApiContext } from "@/lib/guards/site-admin-api";
import {
  decodePhisBillingCursor, encodePhisBillingCursor, phisBillingErrorResponse, phisBillingListFields, readPhisBillingKindsParam, readPhisBillingLimitParam,
} from "@/lib/billing/routes";
import { PHIS_BILLING_PAYMENT_STATES, PhisBillingError, readPhisBillingInstant } from "@/lib/billing/validation";
import { parseStrictPositiveInt } from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

const STATUSES: readonly PhisBillingDocument["status"][] = ["pending", "available", "voided", "failed"];

/**
 * "Documents" in Accounting: every billing document of the Site, newest first, for the Site roles Admin and
 * Accountant only (never a Maintainer). Query: `userId` (the person, turned into their subject here),
 * `issuerKind` (`merchant` | `provider`), `issuer` (name, contains), `kinds`, `source` and `consumer` (Add-on
 * ids), `from` and `to` (issued, ISO instants), `status` (comma-separated), `paymentState`, `q` (number,
 * reference or label, contains), `cursor`, `limit`. Answers `{ documents, cursor }` without contents.
 */
export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteBillingApiContext(request);
  if (error) return error;
  try {
    const query = request.nextUrl.searchParams;
    let subjectId: number | null = null;
    if (query.get("userId")) {
      const userId = parseStrictPositiveInt(query.get("userId"));
      if (!userId) throw new PhisBillingError("invalid_input", "userId is a user's id.");
      subjectId = await findPhisBillingSubjectOfUser(getPool(), context.site.id, userId);
      if (subjectId === null) return NextResponse.json({ documents: [], cursor: null });
    }
    const issuerKind = query.get("issuerKind");
    if (issuerKind && issuerKind !== "merchant" && issuerKind !== "provider") throw new PhisBillingError("invalid_input", "issuerKind is merchant or provider.");
    const statuses = query.get("status")?.split(",").filter(Boolean) ?? null;
    if (statuses?.some(status => !STATUSES.includes(status as PhisBillingDocument["status"]))) throw new PhisBillingError("invalid_input", `status is a list of ${STATUSES.join(", ")}.`);
    const paymentState = query.get("paymentState");
    if (paymentState && !PHIS_BILLING_PAYMENT_STATES.includes(paymentState as PhisBillingPaymentState)) throw new PhisBillingError("invalid_input", "paymentState is not one.");
    const page = await listPhisBillingDocuments(getPool(), {
      siteId: context.site.id,
      // Staff reach a detached document too, through its reference; a person's filter lists what is theirs.
      subjectId,
      issuerKind: issuerKind as "merchant" | "provider" | null,
      issuerName: query.get("issuer"),
      kinds: readPhisBillingKindsParam(query.get("kinds")),
      sourceAddonId: query.get("source"),
      consumerAddonId: query.get("consumer"),
      issuedFrom: query.get("from") ? readPhisBillingInstant(query.get("from"), "from") : null,
      issuedTo: query.get("to") ? readPhisBillingInstant(query.get("to"), "to") : null,
      statuses: statuses as PhisBillingDocument["status"][] | null,
      paymentState: paymentState as PhisBillingPaymentState | null,
      search: query.get("q")?.slice(0, 100) || null,
    }, { cursor: decodePhisBillingCursor(query.get("cursor")), limit: readPhisBillingLimitParam(query.get("limit")) });
    return NextResponse.json({ documents: page.documents.map(document => phisBillingListFields(document.record)), cursor: encodePhisBillingCursor(page.next) });
  } catch (failure) {
    return phisBillingErrorResponse(failure);
  }
}
