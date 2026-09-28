import { describe, expect, it } from "vitest";

import { collectSiteCmsReferences } from "@/db/site-cms-references";
import { createPhiPageReference } from "@/lib/internal-references";

const PAGE = createPhiPageReference({ kind: "site", pageScopeId: 41 });
const MODULE_PAGE = createPhiPageReference({
  kind: "module",
  ownerModuleId: "@acme/shop/modules/site",
  presetKey: "pricing-page",
});

const pagesOf = (value: unknown, options?: { targetAreaId: number }) =>
  collectSiteCmsReferences(value, options)
    .filter((entry) => entry.reference.kind === "page");

/*
 * A Widget that offers a link stores a target object, not an href: a Page by its bare reference, or an
 * explicitly external address. Neither shape is a string the walk would have recognised -- the URI form
 * belongs to Markdown and HTML bodies, and config carries identity. Until the field name said so, a
 * Card or a Button pointing at a Page referenced it as far as the reader was concerned and as far as
 * nothing else was: the Page delete guard counted no references to it, and the operator deleting it was
 * told the Page was unused while two Widgets still linked to it.
 */
describe("A link target in persisted config is a reference", () => {
  it("finds the Page a Widget links to, at the field that carries the target", () => {
    expect(pagesOf({
      layoutNodes: [{ key: "hero", config: { linkTarget: { kind: "page", reference: PAGE } } }],
    }).map((entry) => entry.location)).toEqual(["/layoutNodes/0/config/linkTarget"]);
  });

  it("finds a second link on the same Widget, because the suffix is the same rule", () => {
    expect(pagesOf({
      config: {
        linkTarget: { kind: "page", reference: PAGE },
        actionLinkTarget: { kind: "page", reference: MODULE_PAGE },
      },
    }).map((entry) => entry.location).sort()).toEqual(["/config/actionLinkTarget", "/config/linkTarget"]);
  });

  it("keeps a Module target as a Module target", () => {
    const [entry] = pagesOf({ config: { linkTarget: { kind: "page", reference: MODULE_PAGE } } });
    expect(entry?.reference).toMatchObject({
      kind: "page",
      target: { kind: "module", ownerModuleId: "@acme/shop/modules/site", presetKey: "pricing-page" },
    });
  });

  it("carries a fragment without its hash, and none where there was none", () => {
    const [withFragment] = pagesOf({ config: { linkTarget: { kind: "page", reference: PAGE, fragment: "#plans" } } });
    expect(withFragment?.reference).toMatchObject({ fragment: "plans" });
    const [without] = pagesOf({ config: { linkTarget: { kind: "page", reference: PAGE } } });
    expect(without?.reference).toMatchObject({ fragment: null });
  });

  it("carries the Area a Page reference has to resolve in", () => {
    expect(pagesOf({ config: { linkTarget: { kind: "page", reference: PAGE } } }, { targetAreaId: 2 })[0])
      .toMatchObject({ targetAreaId: 2 });
  });

  /*
   * An external address names nothing the Site owns. There is no identity to guard and no path that can
   * move beneath it, so it earns no row -- and the index has no target variant it could take.
   */
  it("writes no row for an external address", () => {
    expect(collectSiteCmsReferences({
      config: { linkTarget: { kind: "external", href: "https://example.com/pricing" } },
    })).toEqual([]);
  });

  /*
   * The guard the whole-field read exists for. Descending into an external target would let a reserved
   * scheme typed into the URL box index itself as though somebody had picked the Page from the tree --
   * a reference nobody authored, pointing at a Page the Widget does not actually link to.
   */
  it("indexes nothing from a reserved scheme typed into an external address", () => {
    expect(collectSiteCmsReferences({
      config: { linkTarget: { kind: "external", href: `phis:page/${PAGE}` } },
    })).toEqual([]);
  });

  it("indexes nothing from a target whose reference does not parse", () => {
    for (const linkTarget of [
      { kind: "page", reference: "v1.not-a-reference" },
      { kind: "page", reference: "/pricing" },
      { kind: "page" },
      { kind: "elsewhere", reference: PAGE },
      "phis:page/nonsense",
      null,
    ]) {
      expect(collectSiteCmsReferences({ config: { linkTarget } })).toEqual([]);
    }
  });

  it("is the plain name or one that ends in it, and not the suffix standing alone", () => {
    expect(pagesOf({ config: { LinkTarget: { kind: "page", reference: PAGE } } })).toEqual([]);
  });

  /* A Markdown body beside a target keeps being read the way it always was. */
  it("leaves the string walk alone", () => {
    expect(pagesOf({
      config: { linkTarget: { kind: "page", reference: PAGE } },
      markdown: `See [Pricing](phis:page/${MODULE_PAGE}).`,
    }).map((entry) => entry.location).sort()).toEqual(["/config/linkTarget", "/markdown@14"]);
  });
});
