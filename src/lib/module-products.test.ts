import { describe, expect, it } from "vitest";

import {
  PhisSitePackageProductFlag,
  phisSitePackageProductKey,
  readPhisSitePackageProductProposal,
  readPhisSitePackageProductProposals,
} from "@phis/contracts/products";

import { buildModuleProductCommandInput } from "./module-products-apply";

/*
 * What a Site package may propose under `phis.products`, read as the CLI and `phis module check` read it
 * (`@phis/contracts/products`), and what `@phis/products`' `product.add` is handed for it.
 */

const PKG = "@acme/site";
const media = { files: [{ key: "app-icon", file: "dist/media/icon.png", alt: "Icon" }] };

describe("the product key a proposal becomes", () => {
  it("is the package name's parts and the proposal's key, joined by dots", () => {
    expect(phisSitePackageProductKey("@phis/phisys", "phivoice-ai")).toBe("phis.phisys.phivoice-ai");
    expect(phisSitePackageProductKey("plain-site", "basic")).toBe("plain-site.basic");
  });

  it("cannot be made from a name with a dot, an underscore or a leading digit, nor past 96 characters", () => {
    expect(phisSitePackageProductKey("@acme/site.v2", "basic")).toBeNull();
    expect(phisSitePackageProductKey("@acme/my_site", "basic")).toBeNull();
    expect(phisSitePackageProductKey("@1acme/site", "basic")).toBeNull();
    expect(phisSitePackageProductKey(PKG, "two.parts")).toBeNull();
    expect(phisSitePackageProductKey(`@${"a".repeat(40)}/${"b".repeat(40)}`, "c".repeat(20))).toBeNull();
  });
});

describe("reading phis.products", () => {
  it("reads every field product.add takes, a picture and an icon by the package's Media key", () => {
    const { proposals, issues } = readPhisSitePackageProductProposals(PKG, {
      media,
      products: [
        { key: "pro", title: " Pro ", summary: "All of it", kind: "app", state: "active", flags: 3, picture: "app-icon", icon: "app-icon" },
        { key: "basic", title: "Basic", flags: 0 },
      ],
    });
    expect(issues).toEqual([]);
    expect(proposals).toEqual([
      { key: "pro", title: "Pro", summary: "All of it", kind: "app", state: "active", flags: 3, picture: "app-icon", icon: "app-icon" },
      { key: "basic", title: "Basic" },
    ]);
  });

  it("is nothing for a package that proposes nothing", () => {
    expect(readPhisSitePackageProductProposals(PKG, { modules: [] })).toEqual({ proposals: [], issues: [] });
    expect(readPhisSitePackageProductProposals(PKG, undefined)).toEqual({ proposals: [], issues: [] });
  });

  it("refuses the whole list on any violation, naming each one", () => {
    const { proposals, issues } = readPhisSitePackageProductProposals(PKG, {
      media,
      products: [
        { key: "pro", title: "Pro" },
        { key: "pro", title: "Again" },
        { key: "Bad Key", title: "x" },
        { key: "nameless" },
        { key: "odd", title: "x", state: "withdrawn", flags: 4, kind: "Not A Kind", price: 3 },
        { key: "pictured", title: "x", picture: "nowhere" },
      ],
    });
    expect(proposals).toEqual([]);
    expect(issues).toEqual([
      expect.stringContaining('phis.products[1] (key "pro"): key is already used'),
      expect.stringContaining("phis.products[2]: key \"Bad Key\""),
      expect.stringContaining("phis.products[3] (key \"nameless\"): `title`"),
      expect.stringContaining('unknown property "price"'),
      expect.stringContaining("`kind`"),
      expect.stringContaining("`state` must be draft or active"),
      expect.stringContaining("`flags`"),
      expect.stringContaining("`picture` \"nowhere\" must be the key of one of this package's phis.media.files"),
    ]);
    expect(issues.every((issue) => issue.startsWith(`${PKG}: `))).toBe(true);
  });

  it("refuses a package whose name cannot stand in a product key", () => {
    const { issues } = readPhisSitePackageProductProposals("@acme/site.v2", { products: [{ key: "pro", title: "Pro" }] });
    expect(issues).toEqual([expect.stringContaining("the product key cannot be made from the package name")]);
  });

  it("reads one proposal for Core, where a picture need only be a Media key", () => {
    expect(readPhisSitePackageProductProposal(PKG, { key: "pro", title: "Pro", picture: "app-icon" }).proposal)
      .toEqual({ key: "pro", title: "Pro", picture: "app-icon" });
    expect(readPhisSitePackageProductProposal(PKG, { key: "pro", title: "Pro", picture: "Not A Key" }).proposal).toBeNull();
    expect(readPhisSitePackageProductProposal(PKG, "pro").issues).toEqual([`${PKG}: proposal: must be an object`]);
  });
});

describe("what product.add is handed", () => {
  it("is the proposal under the derived key, its flags as product.add's two answers, its pictures as Asset ids", () => {
    expect(buildModuleProductCommandInput("acme.site.pro", {
      key: "pro", title: "Pro", summary: "All", kind: "app", state: "active",
      flags: PhisSitePackageProductFlag.AccountRequired, picture: "app-icon",
    }, { picture: 41, icon: null })).toEqual({
      key: "acme.site.pro", title: "Pro", summary: "All", kind: "app", state: "active",
      counted: false, accountRequired: true, picture: 41,
    });
    expect(buildModuleProductCommandInput("acme.site.basic", { key: "basic", title: "Basic", flags: PhisSitePackageProductFlag.Counted }, { picture: null, icon: 7 }))
      .toEqual({ key: "acme.site.basic", title: "Basic", counted: true, accountRequired: false, icon: 7 });
  });
});
