import { describe, expect, it } from "vitest";

import { collectSiteCmsContentReferences } from "@/db/site-cms-references";
import { sanitizePhiPersistedHtml } from "@/lib/html";
import {
  createPhiAssetUri,
  createPhiPageReference,
  createPhiPageUri,
} from "@/lib/internal-references";

const pageReference = createPhiPageReference({ kind: "site", pageScopeId: 42 });

describe("trusted content reference projection", () => {
  it("indexes the references surviving HTML sanitization", () => {
    const html = sanitizePhiPersistedHtml(
      `<p><a href="${createPhiPageUri(pageReference, "top")}">P</a>` +
        `<img src="${createPhiAssetUri(9)}" alt="A"></p>`,
      { allowInternalReferences: true },
    );

    const references = collectSiteCmsContentReferences("html", html, { targetAreaId: 1 });
    expect(references.map((entry) => entry.reference.kind)).toEqual(["page", "asset"]);
    expect(references[0]).toMatchObject({
      targetAreaId: 1,
      reference: { kind: "page", target: { kind: "site", pageScopeId: 42 }, fragment: "top" },
    });
    expect(references[1]!.reference).toEqual({ kind: "asset", assetId: 9 });
    // The location root is the persisted field name, with the in-body offset appended.
    expect(references.every((entry) => entry.location.startsWith("/html@"))).toBe(true);
  });

  it("indexes Markdown references under the Markdown field", () => {
    const references = collectSiteCmsContentReferences(
      "markdown",
      `See [P](${createPhiPageUri(pageReference)}) and ![A](${createPhiAssetUri(9)}).`,
      { targetAreaId: 4 },
    );
    expect(references.map((entry) => entry.reference.kind)).toEqual(["page", "asset"]);
    expect(references.every((entry) => entry.location.startsWith("/markdown@"))).toBe(true);
    expect(references[0]).toMatchObject({ targetAreaId: 4 });
  });

  it("does not index an attribute the sanitizer already rejected", () => {
    const html = sanitizePhiPersistedHtml(
      `<p><img src="%70hi%3Aasset%2F9" alt="A"></p>`,
      { allowInternalReferences: true },
    );
    expect(collectSiteCmsContentReferences("html", html, { targetAreaId: 1 })).toEqual([]);
  });

  it("does not index ordinary local paths", () => {
    expect(collectSiteCmsContentReferences(
      "markdown",
      "See [P](/en/about) and ![A](/api/site/media/9).",
      { targetAreaId: 1 },
    )).toEqual([]);
  });
});

describe("revision content id collection", () => {
  it("collects positive widget content ids once each", async () => {
    const { collectRevisionContentIds } = await import("@/db/site-content");
    expect(collectRevisionContentIds({
      contentWidgets: [
        { id: "a", contentId: 7 },
        { id: "b", contentId: null },
        { id: "c", contentId: 7 },
        { id: "d", contentId: 12 },
        { id: "e", contentId: 0 },
        { id: "f", contentId: -3 },
        { id: "g" },
        null,
      ],
    })).toEqual([7, 12]);
  });

  it("returns nothing for trees without a widget array", async () => {
    const { collectRevisionContentIds } = await import("@/db/site-content");
    for (const tree of [null, undefined, {}, { contentWidgets: null }, { contentWidgets: "x" }]) {
      expect(collectRevisionContentIds(tree)).toEqual([]);
    }
  });
});
