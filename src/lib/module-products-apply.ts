import "server-only";

import {
  PHIS_SITE_PACKAGE_PRODUCT_SUPPLIER,
  PhisSitePackageProductFlag,
  phisSitePackageProductKey,
  type PhisSitePackageProductProposal,
} from "@phis/contracts/products";

import { getSiteModuleMediaFile } from "@/db/site-module-media";
import {
  getSiteModuleProduct,
  insertSiteModuleProduct,
  lockSiteModuleProducts,
  siteHasSupplierProduct,
} from "@/db/site-module-products.mts";
import { PhisAddonCommandError, runPhisAddonCommand } from "@/lib/addons/commands";
import { withTransaction } from "@/lib/db";
import { PhisSiteModuleProductFlag, type PhisModuleProductOutcome } from "@/lib/module-products";

/**
 * Taking one product a Site package proposes (SERVER_ADDONS.md, `products:v1`, "Products a Site package
 * proposes"; DB.md `site_module_products`).
 *
 * Once per Site and proposal, and never again. Under the Site's lock, in this order:
 *
 * - a recorded proposal is `taken` and nothing is asked: the product may have been changed, withdrawn or
 *   removed since, and none of that is undone;
 * - a product of `@phis/products` the Site has under the derived key already is `found`: recorded as
 *   taken and left as it is;
 * - a `picture` or `icon` names the package's Media file, which has to stand in the Site's library
 *   (`phis module media sync`); until it does the proposal is `waiting`, so the product is not made
 *   without the picture it would then never get;
 * - otherwise `@phis/products` makes it with `product.add`, as the person the operator named, and the
 *   proposal is recorded `created`. Where the Add-on is not on for the Site the proposal is `waiting`; where
 *   it refuses (that person may not keep products, Core's refusal) it is `refused`. Neither is recorded.
 *
 * The command runs while the lock is held, so a second sync of the same Site waits for the first rather than
 * finding the proposal missing too. It writes through `products:v1` on its own connections; the lock's
 * transaction writes the row alone.
 */

type Site = { id: number; key: string; publicBaseUrl: string; timeZone: string };

/** The body `product.add` is handed for a proposal: `{ key, title, summary?, kind?, state?, counted?, accountRequired?, picture?, icon? }`. */
export function buildModuleProductCommandInput(
  productKey: string,
  proposal: PhisSitePackageProductProposal,
  pictures: { picture: number | null; icon: number | null },
) {
  const flags = proposal.flags ?? 0;
  return {
    key: productKey,
    title: proposal.title,
    ...(proposal.summary !== undefined ? { summary: proposal.summary } : {}),
    ...(proposal.kind !== undefined ? { kind: proposal.kind } : {}),
    ...(proposal.state !== undefined ? { state: proposal.state } : {}),
    counted: (flags & PhisSitePackageProductFlag.Counted) !== 0,
    accountRequired: (flags & PhisSitePackageProductFlag.AccountRequired) !== 0,
    ...(pictures.picture !== null ? { picture: pictures.picture } : {}),
    ...(pictures.icon !== null ? { icon: pictures.icon } : {}),
  };
}

export async function applyModuleProductProposal(site: Site, input: {
  packageName: string;
  proposal: PhisSitePackageProductProposal;
  actorUserId: number;
}): Promise<PhisModuleProductOutcome> {
  const { packageName, proposal } = input;
  const productKey = phisSitePackageProductKey(packageName, proposal.key);
  if (productKey === null) {
    return {
      packageName, key: proposal.key, productKey: "", status: "refused", reason: "invalid_key",
      detail: "The product key cannot be made from the package name and the proposal's key.",
    };
  }
  const outcome = (status: PhisModuleProductOutcome["status"], extra: Partial<PhisModuleProductOutcome> = {}): PhisModuleProductOutcome =>
    ({ packageName, key: proposal.key, productKey, status, ...extra });
  const supplier = PHIS_SITE_PACKAGE_PRODUCT_SUPPLIER.addonId;

  return withTransaction(async (db) => {
    await lockSiteModuleProducts(db, site.id);
    if (await getSiteModuleProduct(db, site.id, packageName, proposal.key)) return outcome("taken");

    if (await siteHasSupplierProduct(db, site.id, supplier, productKey)) {
      await insertSiteModuleProduct(db, { siteId: site.id, packageName, key: proposal.key, productKey, flags: PhisSiteModuleProductFlag.Found });
      return outcome("found", { detail: `The Site has ${supplier}:${productKey} already; it is left as it is.` });
    }

    const pictures = { picture: null as number | null, icon: null as number | null };
    for (const name of ["picture", "icon"] as const) {
      const mediaKey = proposal[name];
      if (mediaKey === undefined) continue;
      const row = await getSiteModuleMediaFile(db, site.id, packageName, mediaKey);
      if (!row || row.assetId === null) {
        return outcome("waiting", {
          reason: "media_missing",
          detail: `The ${name} "${mediaKey}" is not in the Site's Media library yet; run phis module media sync first.`,
        });
      }
      pictures[name] = row.assetId;
    }

    let ran: Awaited<ReturnType<typeof runPhisAddonCommand>>;
    try {
      ran = await runPhisAddonCommand({
        addonId: supplier,
        commandId: PHIS_SITE_PACKAGE_PRODUCT_SUPPLIER.command,
        site,
        actorUserId: input.actorUserId,
        input: buildModuleProductCommandInput(productKey, proposal, pictures),
      });
    } catch (error) {
      if (error instanceof PhisAddonCommandError) {
        return outcome("waiting", { reason: "supplier_unavailable", detail: error.message });
      }
      throw error;
    }
    if (!ran.ok) return outcome("refused", { reason: "supplier_refused", detail: ran.error });

    await insertSiteModuleProduct(db, { siteId: site.id, packageName, key: proposal.key, productKey, flags: 0 });
    return outcome("created");
  });
}
