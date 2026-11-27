import "server-only";

import { NextResponse, type NextRequest } from "next/server";

import type { PhisProduct, PhisProductId, PhisProductState } from "@phis/contracts/products";

import {
  listProductDirectory,
  moveProductsAsOperator,
  PhisProductRuleError,
  readProduct,
  releaseProduct,
  type PhisStoredProduct,
} from "@/db/products.mts";
import { schedulePhisAddonEventDelivery } from "@/lib/addons/event-trigger";
import { isPhisProductId } from "@/lib/addons/product-draft";
import { listPhisProductListeners, presentPhisProduct } from "@/lib/addons/products-capability";
import { getPhisConfigSync } from "@/lib/config";
import { resolvePhiSiteSourceLocale } from "@/lib/config-core";
import { PHIS_ADDON_ID_PATTERN } from "@/lib/addons/schema-name";
import { getPool } from "@/lib/db";
import type { SiteAdminApiGuardedContext } from "@/lib/guards/site-admin-api";
import { parsePhiPagination } from "@/lib/helpers/request";
import { isPhiRecord } from "@/lib/helpers/record";
import { logRuntimeEvent } from "@/lib/log";

/*
 * The Site's product directory as its operator administers it (`products:v1`, SERVER_ADDONS.md).
 *
 * Core owns no product: every one belongs to the supplier Add-on that registered it. What is the
 * operator's is the release of a publisher's terms and the lock, which is why these routes stand in Core
 * rather than in a shop -- they have to work with no shop at all, and stay the same whichever shop sells.
 * The writes are the ones `phis product release|lock|unlock` makes, through the same functions.
 */

const STATES: readonly PhisProductState[] = ["draft", "active", "withdrawn", "locked"];
const SEARCH_MAX_LENGTH = 200;

/**
 * One row of the directory: what the operator reads to decide, not the attributes other Add-ons keep.
 *
 * `imageListPath` and `iconListPath` are the picture's and the icon's `icon` variant (64 x 64, fitted whole on a
 * transparent ground), for a list that shows them small, as `products:v1` answers them; `null` without one or
 * for an Asset that is no image. They carry the delivery revision and the variant version, so the address
 * changes when the picture does.
 */
export type SiteProductDirectoryRow = Pick<
  PhisProduct,
  | "id" | "supplier" | "publisher" | "title" | "summary" | "type" | "state" | "sale" | "referralUrl" | "flags"
  | "parts" | "pendingTerms" | "imagePath" | "iconPath"
  | "imageListPath" | "iconListPath" | "version"
>;

/** The operator's row; the language is the Site's where a product names none, though the row does not show it. */
function toRow(stored: PhisStoredProduct, siteKey: string): SiteProductDirectoryRow {
  const product = presentPhisProduct(stored, resolvePhiSiteSourceLocale(getPhisConfigSync(), siteKey));
  return {
    id: product.id,
    supplier: product.supplier,
    publisher: product.publisher,
    title: product.title,
    summary: product.summary,
    type: product.type,
    state: product.state,
    sale: product.sale,
    referralUrl: product.referralUrl,
    flags: product.flags,
    parts: product.parts,
    pendingTerms: product.pendingTerms,
    imagePath: product.imagePath,
    iconPath: product.iconPath,
    imageListPath: product.imageListPath,
    iconListPath: product.iconListPath,
    version: product.version,
  };
}

const refuse = (status: number, error: string) => NextResponse.json({ error }, { status });

/** `GET /api/site/products`: the filters read strictly, a malformed one is the caller's mistake. */
export async function answerSiteProductDirectory(request: NextRequest, context: SiteAdminApiGuardedContext) {
  const searchParams = request.nextUrl.searchParams;

  const supplier = searchParams.get("supplier")?.trim() || undefined;
  if (supplier !== undefined && !PHIS_ADDON_ID_PATTERN.test(supplier)) {
    return refuse(400, "supplier must be an Add-on id such as @scope/name.");
  }

  const stateParam = searchParams.get("state")?.trim();
  const states = stateParam ? stateParam.split(",").map((value) => value.trim()) : [...STATES];
  if (!states.every((state): state is PhisProductState => (STATES as readonly string[]).includes(state))) {
    return refuse(400, "state is a comma-separated list of draft, active, withdrawn or locked.");
  }

  const pendingParam = searchParams.get("pendingTerms")?.trim().toLowerCase();
  if (pendingParam && pendingParam !== "true" && pendingParam !== "false") {
    return refuse(400, "pendingTerms is true or false.");
  }

  const search = searchParams.get("q")?.trim() ?? "";
  if (search.length > SEARCH_MAX_LENGTH) return refuse(400, `q has at most ${SEARCH_MAX_LENGTH} characters.`);

  const { page, pageSize } = parsePhiPagination(searchParams);
  const result = await listProductDirectory(getPool(), {
    siteId: context.site.id,
    states,
    supplier,
    awaitingRelease: pendingParam ? pendingParam === "true" : undefined,
    search: search || undefined,
    page,
    pageSize,
  });
  return NextResponse.json({
    rows: result.products.map((stored) => toRow(stored, context.site.key)),
    total: result.total,
    page,
    pageSize,
  });
}

export type SiteProductCommand = "release" | "lock" | "unlock";

/**
 * The release's body: none, or `{ expectedVersion }`, the version of the product the operator read the terms
 * of. Read strictly: anything else in it is the caller's mistake, not a field to skip.
 */
async function readReleaseBody(request: NextRequest): Promise<{ expectedVersion?: number } | NextResponse> {
  const text = await request.text();
  if (text.trim() === "") return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse(400, "The body is a JSON object, or empty.");
  }
  if (!isPhisReleaseBody(body)) {
    return refuse(400, "The body holds at most expectedVersion, a positive whole number.");
  }
  return body.expectedVersion === undefined ? {} : { expectedVersion: body.expectedVersion };
}

function isPhisReleaseBody(body: unknown): body is { expectedVersion?: number } {
  if (!isPhiRecord(body) || Object.keys(body).some((key) => key !== "expectedVersion")) return false;
  const version = body.expectedVersion;
  return version === undefined || (Number.isSafeInteger(version) && (version as number) > 0);
}

/**
 * `POST /api/site/products/{id}/release|lock|unlock`: the id is one path segment, percent-encoded by
 * whoever built the address (`@`, `/` and `:` are in every id), and decoded by Next before it gets here.
 *
 * The answer is the outcome and the product as it now stands. A command that finds nothing to do --
 * a product already locked, one not locked, a release with nothing pending -- answers `unchanged`
 * rather than a refusal: the state asked for is the state there is.
 *
 * A release may name the version the operator read (`expectedVersion`): where the product has moved
 * since -- the publisher changed its terms again while the dialog was open -- it is refused with `409`
 * rather than releasing terms nobody compared.
 */
export async function answerSiteProductCommand(
  request: NextRequest,
  context: SiteAdminApiGuardedContext,
  rawId: string,
  command: SiteProductCommand,
) {
  if (!isPhisProductId(rawId)) return refuse(400, "The product id looks like @scope/name:key.");
  const id: PhisProductId = rawId;
  const pool = getPool();
  const siteId = context.site.id;
  const listeners = listPhisProductListeners();

  let outcome: string;
  try {
    if (command === "release") {
      const body = await readReleaseBody(request);
      if (body instanceof NextResponse) return body;
      const result = await releaseProduct(pool, { siteId, productId: id, listeners, ...body });
      if (!result) return refuse(404, "product_not_found");
      outcome = result.outcome;
    } else {
      if (!await readProduct(pool, siteId, id)) return refuse(404, "product_not_found");
      const moved = await moveProductsAsOperator(pool, {
        siteId, to: command === "lock" ? "locked" : "unlocked", productId: id, listeners,
      });
      outcome = moved.length > 0 ? (command === "lock" ? "locked" : "unlocked") : "unchanged";
    }
  } catch (error) {
    // The Site's own product needs no release; parts that would contain the product itself are refused,
    // and so is a release of a version that is no longer the product's.
    if (error instanceof PhisProductRuleError) return refuse(409, error.message);
    throw error;
  }

  if (outcome !== "unchanged") {
    // After the commit; the outbox rows are written, this only spares them the next tick.
    schedulePhisAddonEventDelivery(siteId);
    logRuntimeEvent("info", `site.products.${command}`, {
      siteKey: context.site.key,
      userId: context.session.userId,
      method: request.method,
      path: request.nextUrl.pathname,
      targetType: "product",
      targetId: id,
      meta: { outcome },
    });
  }
  const product = await readProduct(pool, siteId, id);
  if (!product) return refuse(404, "product_not_found");
  return NextResponse.json({ outcome, product: toRow(product, context.site.key) });
}
