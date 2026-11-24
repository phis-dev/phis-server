import "server-only";

import {
  PHIS_SITE_PACKAGE_PRODUCT_SUPPLIER,
  PhisSitePackageProductFlag,
  phisSitePackageProductKey,
  type PhisSitePackageProductProposal,
} from "@phis/contracts/products";

import { readPhisSitePackageProductProposal } from "@phis/contracts/products";

import { listPhiSiteActiveModuleIdsWithDb } from "@/db/site-active-modules";
import { getSiteModuleMediaFile } from "@/db/site-module-media";
import {
  getSiteModuleProduct,
  insertSiteModuleProduct,
  listSiteModuleProductProposals,
  listSiteModuleProducts,
  lockSiteModuleProducts,
  noteSiteModuleProductProposalWaiting,
  replaceSiteModuleProductProposals,
  siteHasSupplierProduct,
} from "@/db/site-module-products.mts";
import { PhisAddonCommandError, runPhisAddonCommand } from "@/lib/addons/commands";
import { getPool, withTransaction } from "@/lib/db";
import { logRuntimeEvent } from "@/lib/log";
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
 * - a `picture`, an `icon` or a picture of the `gallery` names the package's Media file, which has to stand
 *   in the Site's library (`phis module media sync`); until every one does the proposal is `waiting`, so
 *   the product is not made without a picture it would then never get;
 * - otherwise `@phis/products` makes it with `product.add`, as the person the operator named, and the
 *   proposal is recorded `created`. Where the Add-on is not on for the Site the proposal is `waiting`; where
 *   it refuses (that person may not keep products, Core's refusal) it is `refused`. Neither is recorded.
 *
 * The command runs while the lock is held, so a second sync of the same Site waits for the first rather than
 * finding the proposal missing too. It writes through `products:v1` on its own connections; the lock's
 * transaction writes the row alone.
 */

type Site = { id: number; key: string; publicBaseUrl: string; timeZone: string };

/**
 * The body `product.add` is handed for a proposal:
 * `{ key, title, summary?, description?, kind?, state?, counted?, accountRequired?, picture?, icon?, gallery? }`.
 */
export function buildModuleProductCommandInput(
  productKey: string,
  proposal: PhisSitePackageProductProposal,
  pictures: { picture: number | null; icon: number | null; gallery: readonly number[] },
) {
  const flags = proposal.flags ?? 0;
  return {
    key: productKey,
    title: proposal.title,
    ...(proposal.summary !== undefined ? { summary: proposal.summary } : {}),
    ...(proposal.description !== undefined ? { description: proposal.description } : {}),
    ...(proposal.kind !== undefined ? { kind: proposal.kind } : {}),
    ...(proposal.state !== undefined ? { state: proposal.state } : {}),
    counted: (flags & PhisSitePackageProductFlag.Counted) !== 0,
    accountRequired: (flags & PhisSitePackageProductFlag.AccountRequired) !== 0,
    ...(pictures.picture !== null ? { picture: pictures.picture } : {}),
    ...(pictures.icon !== null ? { icon: pictures.icon } : {}),
    ...(pictures.gallery.length > 0 ? { gallery: [...pictures.gallery] } : {}),
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

    const pictures = { picture: null as number | null, icon: null as number | null, gallery: [] as number[] };
    const named = [
      ...(["picture", "icon"] as const).flatMap((name) => (proposal[name] === undefined ? [] : [{ name, mediaKey: proposal[name] }])),
      ...(proposal.gallery ?? []).map((mediaKey) => ({ name: "gallery" as const, mediaKey })),
    ];
    for (const { name, mediaKey } of named) {
      const row = await getSiteModuleMediaFile(db, site.id, packageName, mediaKey);
      if (!row || row.assetId === null) {
        return outcome("waiting", {
          reason: "media_missing",
          detail: `The ${name === "gallery" ? "gallery picture" : name} "${mediaKey}" is not in the Site's Media library yet; run phis module media sync first.`,
        });
      }
      if (name === "gallery") pictures.gallery.push(row.assetId);
      else pictures[name] = row.assetId;
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

/**
 * Keeps what one package proposes, as the CLI hands it over (`phis update`, `phis module products sync`):
 * the package's whole list replaces the one stored, under the Site's lock. Nothing is made here -- making a
 * product needs a person, and the person is the Site Admin who activates the package in the Builder
 * (`takeModuleProductProposalsOnActivation`) or the member `--as` names. The answer says, per proposal,
 * `taken` or `waiting` for that activation.
 */
export async function recordModuleProductProposals(site: Pick<Site, "id">, input: {
  packageName: string;
  proposals: readonly PhisSitePackageProductProposal[];
}): Promise<PhisModuleProductOutcome[]> {
  return withTransaction(async (db) => {
    await lockSiteModuleProducts(db, site.id);
    await replaceSiteModuleProductProposals(db, { siteId: site.id, packageName: input.packageName, proposals: input.proposals });
    const taken = new Map((await listSiteModuleProducts(db, site.id))
      .filter((row) => row.packageName === input.packageName)
      .map((row) => [row.key, row]));
    return input.proposals.map((proposal): PhisModuleProductOutcome => {
      const row = taken.get(proposal.key);
      const productKey = row?.productKey ?? phisSitePackageProductKey(input.packageName, proposal.key) ?? "";
      return row
        ? { packageName: input.packageName, key: proposal.key, productKey, status: "taken" }
        : {
            packageName: input.packageName, key: proposal.key, productKey, status: "waiting", reason: "activation",
            detail: `Taken when a Site Admin activates ${input.packageName} in the Builder, or with phis module products sync --as.`,
          };
    });
  });
}

/** Whether a Module id is one of the package's own: every Module a package declares is `<package>/...`. */
const isModuleOfPackage = (moduleId: string, packageName: string) => moduleId.startsWith(`${packageName}/`);

/**
 * Takes the stored proposals of every package whose Module the Site now runs in a published Area, as the
 * person who published the Module selection -- the Builder's activation (`POST
 * /api/site/cms/area/modules/publish`). A proposal taken before is left alone, as everywhere.
 *
 * Nothing here fails the publish. A proposal that cannot be taken keeps waiting, and why is noted on its
 * stored row for `phis module check`: `@phis/products` not on for the Site (`supplier_unavailable`), a
 * picture not imported (`media_missing`), or the person may not keep the Site's products
 * (`supplier_refused` -- `@phis/products`' `editor` role). Answers what each one came to.
 */
export async function takeModuleProductProposalsOnActivation(site: Site, input: { actorUserId: number }): Promise<PhisModuleProductOutcome[]> {
  const pool = getPool();
  const [activeModuleIds, stored, taken] = await Promise.all([
    listPhiSiteActiveModuleIdsWithDb(pool, site.id),
    listSiteModuleProductProposals(pool, site.id),
    listSiteModuleProducts(pool, site.id),
  ]);
  const takenKeys = new Set(taken.map((row) => `${row.packageName}\u0000${row.key}`));
  const due = stored.filter((entry) =>
    !takenKeys.has(`${entry.packageName}\u0000${entry.key}`)
    && activeModuleIds.some((moduleId) => isModuleOfPackage(moduleId, entry.packageName)));
  const outcomes: PhisModuleProductOutcome[] = [];
  for (const entry of due) {
    // Read again as Core is handed a proposal: what was stored by an older release is held to today's rules.
    const { proposal, issues } = readPhisSitePackageProductProposal(entry.packageName, entry.proposal);
    const result = proposal
      ? await applyModuleProductProposal(site, { packageName: entry.packageName, proposal, actorUserId: input.actorUserId })
      : {
          packageName: entry.packageName, key: entry.key, productKey: "", status: "refused" as const, reason: "invalid_proposal",
          detail: issues.join("; "),
        };
    const waits = result.status === "waiting" || result.status === "refused";
    await noteSiteModuleProductProposalWaiting(pool, {
      siteId: site.id, packageName: entry.packageName, key: entry.key,
      reason: waits ? result.reason ?? result.status : null, detail: waits ? result.detail ?? null : null,
    });
    logRuntimeEvent(waits ? "warn" : "info", "module.products.activation", {
      siteKey: site.key,
      meta: { package: entry.packageName, key: entry.key, productKey: result.productKey, status: result.status, reason: result.reason, actorUserId: input.actorUserId },
    });
    outcomes.push(result);
  }
  return outcomes;
}
