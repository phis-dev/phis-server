import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  PHIS_SITE_PACKAGE_PRODUCT_SUPPLIER,
  phisSitePackageProductKey,
  readPhisSitePackageProductProposals,
  type PhisSitePackageProductProposal,
} from "@phis/contracts/products";

import {
  PhisSiteModuleProductFlag,
  type PhisModuleProductMapping,
  type PhisModuleProductOutcome,
  type PhisModuleProductProposalRow,
  type PhisModuleProductRow,
} from "../lib/module-products.ts";
import { callCore, readSiteRuntimeCore, type Core } from "./module-media.mts";

/**
 * `phis module products`: the products the Site's packages propose (`phis.products`), made once per Site by
 * `@phis/products` (SERVER_ADDONS.md, `products:v1`, "Products a Site package proposes").
 *
 * As `phis module media`: the package's `package.json` is read as text and no package code runs, and the
 * CLI posts one proposal per request to the running Core with the Site's own token. Core does the rest --
 * it runs `@phis/products`' `product.add` as the member `--as` names and records what was taken.
 */

export type ModuleProductPackage = {
  packageName: string;
  /** False where the package is not in the Site's `node_modules` yet, which is not a fault of the package. */
  installed: boolean;
  proposals: PhisSitePackageProductProposal[];
  issues: string[];
};

/** What each installed package of the Site proposes, with every violation reported by package and key. */
export function readModuleProductPackages(siteRoot: string, packageNames: readonly string[]): ModuleProductPackage[] {
  return packageNames.map((packageName) => {
    const manifestFile = path.join(siteRoot, "node_modules", ...packageName.split("/"), "package.json");
    if (!existsSync(manifestFile)) return { packageName, installed: false, proposals: [], issues: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(manifestFile, "utf8"));
    } catch (error) {
      return {
        packageName, installed: true, proposals: [],
        issues: [`${packageName}: package.json is not readable JSON: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
    const { proposals, issues } = readPhisSitePackageProductProposals(packageName, (parsed as { phis?: unknown } | null)?.phis);
    return { packageName, installed: true, proposals, issues };
  });
}

const rowKey = (packageName: string, key: string) => `${packageName}\u0000${key}`;

export type ModuleProductSyncReport = {
  site: string;
  /** Proposals the packages make; zero means Core was not contacted. */
  proposed: number;
  items: PhisModuleProductOutcome[];
  refused: PhisModuleProductOutcome[];
};

/**
 * Hands every package's proposals to Core, which keeps them for the Builder's activation (a Site Admin
 * switching the package's Module on takes them, as that admin), and -- with `as` -- posts every proposal
 * Core has not recorded as taken, to be taken now as that member. A package Core keeps proposals of and
 * that proposes none any more is handed over empty, so they go. A manifest violation stops the run before
 * any request, naming every one. A waiting or refused proposal does not: the rest is taken, and the report
 * carries them for the caller to say so.
 */
export async function syncModuleProducts(input: {
  siteKey: string;
  siteRoot: string;
  packageNames: readonly string[];
  /** The member to take them as now; absent, they are only handed over. */
  as?: string;
}): Promise<ModuleProductSyncReport> {
  const packages = readModuleProductPackages(input.siteRoot, input.packageNames);
  const issues = packages.flatMap((entry) => entry.issues);
  if (issues.length > 0) {
    throw new Error(`The product proposals are invalid:\n${issues.map((line) => `  - ${line}`).join("\n")}`);
  }
  const proposing = packages.filter((entry) => entry.proposals.length > 0);
  const proposed = proposing.reduce((sum, entry) => sum + entry.proposals.length, 0);
  // Without a proposal and without a Core to clear, there is nothing to say; a Site without `site-runtime.json` is not asked.
  if (proposed === 0 && !existsSync(path.join(input.siteRoot, "config", "site-runtime.json"))) {
    return { site: input.siteKey, proposed: 0, items: [], refused: [] };
  }

  const core: Core = { ...readSiteRuntimeCore(input.siteRoot), siteKey: input.siteKey };
  const mapping = await callCore(core, "/api/v1/module-products", { method: "GET" }) as unknown as PhisModuleProductMapping;
  const kept = new Set(mapping.proposals.map((row) => row.packageName));
  const handOver = packages.filter((entry) => entry.installed && (entry.proposals.length > 0 || kept.has(entry.packageName)));
  const handedOver = new Map<string, PhisModuleProductOutcome>();
  for (const entry of handOver) {
    const answer = await callCore(core, "/api/v1/module-products", {
      method: "POST",
      json: { package: entry.packageName, proposals: entry.proposals },
    });
    for (const result of ((answer as { results?: PhisModuleProductOutcome[] } | null)?.results ?? [])) {
      handedOver.set(rowKey(result.packageName, result.key), result);
    }
  }
  if (proposed === 0) return { site: input.siteKey, proposed: 0, items: [], refused: [] };

  const taken = new Map(mapping.rows.map((row) => [rowKey(row.packageName, row.key), row]));
  const items: PhisModuleProductOutcome[] = [];
  for (const entry of proposing) {
    for (const proposal of entry.proposals) {
      if (input.as === undefined) {
        const result = handedOver.get(rowKey(entry.packageName, proposal.key));
        if (result) items.push(result);
        continue;
      }
      const row = taken.get(rowKey(entry.packageName, proposal.key));
      if (row) {
        items.push({ packageName: entry.packageName, key: proposal.key, productKey: row.productKey, status: "taken" });
        continue;
      }
      const answer = await callCore(core, "/api/v1/module-products", {
        method: "POST",
        json: { package: entry.packageName, proposal, as: input.as },
      });
      items.push(answer!.result as PhisModuleProductOutcome);
    }
  }
  return { site: input.siteKey, proposed, items, refused: items.filter((item) => item.status === "refused") };
}

export function describeModuleProductOutcome(item: PhisModuleProductOutcome) {
  const why = item.detail ? ` -- ${item.detail}` : "";
  return `${item.status.padEnd(8)} ${item.packageName} ${item.key}  ${PHIS_SITE_PACKAGE_PRODUCT_SUPPLIER.addonId}:${item.productKey}${why}`;
}

export type ModuleProductListRow = {
  packageName: string;
  key: string;
  productKey: string;
  /**
   * `created` and `found` are taken (Core made it, or the Site had it); `waiting` is proposed and not
   * taken yet; `no longer proposed` is a row whose proposal the package dropped, which changes nothing.
   */
  state: "created" | "found" | "waiting" | "no longer proposed";
  /**
   * Why a `waiting` one waits, where what Core keeps was asked: not handed to Core yet, waiting for a Site
   * Admin to activate the package in the Builder, or what the last attempt there answered.
   */
  why?: string;
};

/** Why a proposal not taken waits, from what Core keeps of it. */
function waitingWhy(packageName: string, stored: PhisModuleProductProposalRow | undefined) {
  if (!stored) return "not handed to Core yet: run phis update or phis module products sync";
  if (stored.waitingReason === null) return `taken when a Site Admin activates ${packageName} in the Builder, or with phis module products sync --as`;
  return `${stored.waitingReason}${stored.waitingDetail ? `: ${stored.waitingDetail}` : ""}`;
}

/**
 * Every proposal and every recorded row, with what each came to. Read from the rows alone, so it is the
 * same answer whether Core is asked (`phis module products list`) or the database is (`phis module check`).
 */
export function describeModuleProductStates(
  packages: readonly ModuleProductPackage[],
  rows: readonly PhisModuleProductRow[],
  /** What Core keeps of the proposals; given, a waiting row says why it waits. */
  stored?: readonly PhisModuleProductProposalRow[],
): ModuleProductListRow[] {
  const byKey = new Map(rows.map((row) => [rowKey(row.packageName, row.key), row]));
  const storedByKey = new Map((stored ?? []).map((row) => [rowKey(row.packageName, row.key), row]));
  const proposed = new Set<string>();
  const list: ModuleProductListRow[] = [];
  for (const entry of packages) {
    for (const proposal of entry.proposals) {
      proposed.add(rowKey(entry.packageName, proposal.key));
      const row = byKey.get(rowKey(entry.packageName, proposal.key));
      list.push({
        packageName: entry.packageName,
        key: proposal.key,
        productKey: row?.productKey ?? phisSitePackageProductKey(entry.packageName, proposal.key) ?? "",
        state: !row ? "waiting" : (row.flags & PhisSiteModuleProductFlag.Found) !== 0 ? "found" : "created",
        ...(!row && stored ? { why: waitingWhy(entry.packageName, storedByKey.get(rowKey(entry.packageName, proposal.key))) } : {}),
      });
    }
  }
  for (const row of rows) {
    if (!proposed.has(rowKey(row.packageName, row.key))) {
      list.push({ packageName: row.packageName, key: row.key, productKey: row.productKey, state: "no longer proposed" });
    }
  }
  return list;
}

export async function listModuleProducts(input: {
  siteKey: string;
  siteRoot: string;
  packageNames: readonly string[];
}): Promise<{ rows: ModuleProductListRow[]; issues: string[] }> {
  const packages = readModuleProductPackages(input.siteRoot, input.packageNames);
  const core: Core = { ...readSiteRuntimeCore(input.siteRoot), siteKey: input.siteKey };
  const mapping = await callCore(core, "/api/v1/module-products", { method: "GET" }) as unknown as PhisModuleProductMapping;
  return { rows: describeModuleProductStates(packages, mapping.rows, mapping.proposals), issues: packages.flatMap((entry) => entry.issues) };
}
