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
const media = { files: [
  { key: "app-icon", file: "dist/media/icon.png", alt: "Icon" },
  { key: "shot-1", file: "dist/media/shot-1.png", alt: "Screen one" },
  { key: "shot-2", file: "dist/media/shot-2.png", alt: "Screen two" },
] };

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
        {
          key: "pro", title: " Pro ", summary: "All of it", description: "## Features\n\n- Fast\n", kind: "app", state: "active", flags: 3,
          picture: "app-icon", icon: "app-icon", gallery: ["shot-2", "shot-1"],
        },
        { key: "basic", title: "Basic", flags: 0, gallery: [] },
      ],
    });
    expect(issues).toEqual([]);
    expect(proposals).toEqual([
      {
        key: "pro", sourceLocale: "en", title: "Pro", summary: "All of it", description: "## Features\n\n- Fast", kind: "app", state: "active", flags: 3,
        picture: "app-icon", icon: "app-icon", gallery: ["shot-2", "shot-1"],
      },
      { key: "basic", sourceLocale: "en", title: "Basic" },
    ]);
  });

  it("states the package's language on every proposal, and takes none from a proposal itself", () => {
    expect(readPhisSitePackageProductProposals(PKG, { sourceLocale: "fr", products: [{ key: "pro", title: "Pro" }] }).proposals)
      .toEqual([{ key: "pro", sourceLocale: "fr", title: "Pro" }]);
    expect(readPhisSitePackageProductProposals(PKG, { products: [{ key: "pro", title: "Pro", sourceLocale: "de" }] }).issues)
      .toEqual([expect.stringContaining("a proposal names no language of its own")]);
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
        { key: "galleried", title: "x", gallery: ["shot-1", "nowhere", "shot-1"] },
        { key: "listless", title: "x", gallery: "shot-1", description: "" },
        { key: "crowded", title: "x", gallery: Array.from({ length: 21 }, () => "shot-1"), description: "x".repeat(20001) },
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
      expect.stringContaining('(key "galleried"): `gallery` entry "nowhere" must be the key'),
      expect.stringContaining('(key "galleried"): `gallery` names a Media file twice'),
      expect.stringContaining('(key "listless"): `description` must be an optional non-empty string'),
      expect.stringContaining('(key "listless"): `gallery` must be a list of at most 20'),
      expect.stringContaining('(key "crowded"): `description` must be an optional non-empty string of at most 20000'),
      expect.stringContaining('(key "crowded"): `gallery` must be a list of at most 20'),
    ]);
    expect(issues.every((issue) => issue.startsWith(`${PKG}: `))).toBe(true);
  });

  it("refuses a package whose name cannot stand in a product key", () => {
    const { issues } = readPhisSitePackageProductProposals("@acme/site.v2", { products: [{ key: "pro", title: "Pro" }] });
    expect(issues).toEqual([expect.stringContaining("the product key cannot be made from the package name")]);
  });

  it("reads one proposal for Core, where a picture need only be a Media key", () => {
    expect(readPhisSitePackageProductProposal(PKG, { key: "pro", sourceLocale: "en", title: "Pro", picture: "app-icon" }).proposal)
      .toEqual({ key: "pro", sourceLocale: "en", title: "Pro", picture: "app-icon" });
    expect(readPhisSitePackageProductProposal(PKG, { key: "pro", sourceLocale: "en", title: "Pro", picture: "Not A Key" }).proposal).toBeNull();
    expect(readPhisSitePackageProductProposal(PKG, { key: "pro", sourceLocale: "en", title: "Pro", gallery: ["shot-9", "shot-1"] }).proposal)
      .toEqual({ key: "pro", sourceLocale: "en", title: "Pro", gallery: ["shot-9", "shot-1"] });
    expect(readPhisSitePackageProductProposal(PKG, { key: "pro", sourceLocale: "en", title: "Pro", gallery: ["Not A Key"] }).proposal).toBeNull();
    // Handed one, Core needs the language the package's reader stated.
    expect(readPhisSitePackageProductProposal(PKG, { key: "pro", title: "Pro" }).issues).toEqual([expect.stringContaining("`sourceLocale`")]);
    expect(readPhisSitePackageProductProposal(PKG, { key: "pro", sourceLocale: "Français", title: "Pro" }).proposal).toBeNull();
    expect(readPhisSitePackageProductProposal(PKG, "pro").issues).toEqual([`${PKG}: proposal: must be an object`]);
  });
});

describe("what product.add is handed", () => {
  it("is the proposal under the derived key, its flags as product.add's two answers, its pictures as Asset ids", () => {
    expect(buildModuleProductCommandInput("acme.site.pro", {
      key: "pro", sourceLocale: "fr", title: "Pro", summary: "All", description: "Long", kind: "app", state: "active",
      flags: PhisSitePackageProductFlag.AccountRequired, picture: "app-icon", gallery: ["shot-2", "shot-1"],
    }, { picture: 41, icon: null, gallery: [43, 42] })).toEqual({
      key: "acme.site.pro", sourceLocale: "fr", title: "Pro", summary: "All", description: "Long", kind: "app", state: "active",
      counted: false, accountRequired: true, picture: 41, gallery: [43, 42],
    });
    expect(buildModuleProductCommandInput("acme.site.basic", { key: "basic", sourceLocale: "en", title: "Basic", flags: PhisSitePackageProductFlag.Counted }, { picture: null, icon: 7, gallery: [] }))
      .toEqual({ key: "acme.site.basic", sourceLocale: "en", title: "Basic", counted: true, accountRequired: false, icon: 7 });
  });
});
