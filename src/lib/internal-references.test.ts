import { describe, expect, it } from "vitest";

import { sanitizePhiPersistedHtml } from "@/lib/html";
import {
  classifyPhiReferenceAttribute,
  collectPhiInternalReferencesFromText,
  createPhiAssetUri,
  createPhiPageReference,
  createPhiPageUri,
} from "@/lib/internal-references";

const pageReference = createPhiPageReference({ kind: "site", pageScopeId: 17 });
const pageUri = createPhiPageUri(pageReference, "details");
const assetUri = createPhiAssetUri(23);

describe("embedded internal references", () => {
  it("finds Page and Asset references inside Markdown and HTML values", () => {
    const source = `[Page](${pageUri}) <img src="${assetUri}">`;
    expect(collectPhiInternalReferencesFromText(source).map((entry) => entry.reference.kind))
      .toEqual(["page", "asset"]);
  });

  it("does not reinterpret ordinary local paths as stable references", () => {
    expect(collectPhiInternalReferencesFromText("[Page](/local/path) ![Asset](/api/site/media/23)"))
      .toEqual([]);
  });
});

describe("reference attribute classification", () => {
  it("accepts the canonical Page and Asset forms unchanged", () => {
    expect(classifyPhiReferenceAttribute(pageUri)).toMatchObject({ kind: "internal", uri: pageUri });
    expect(classifyPhiReferenceAttribute(assetUri)).toMatchObject({ kind: "internal", uri: assetUri });
  });

  it("normalizes surrounding whitespace to the canonical form", () => {
    expect(classifyPhiReferenceAttribute(`  ${assetUri}\n`))
      .toMatchObject({ kind: "internal", uri: assetUri });
  });

  it("leaves external values to the ordinary scheme allowlist", () => {
    for (const value of ["https://example.test/page", "mailto:a@example.test", "#anchor", "/local"]) {
      expect(classifyPhiReferenceAttribute(value)).toEqual({ kind: "external" });
    }
  });

  it("rejects malformed and obfuscated Phi schemes instead of repairing them", () => {
    for (const value of [
      "phis:page/v1.not-base64url!",
      "phis:asset/0",
      "phis:asset/abc",
      "phis:unknown/1",
      "phis&colon;asset/23",
      "phis&#58;asset/23",
      "%70his%3Aasset%2F23",
    ]) {
      expect(classifyPhiReferenceAttribute(value).kind, value).toBe("invalid");
    }
  });
});

describe("persisted HTML sanitizer", () => {
  const internalHtml =
    `<p><a href="${pageUri}">Page</a><img src="${assetUri}" alt="Asset"></p>`;

  it("keeps canonical Phi URIs in the internal content channel", () => {
    const sanitized = sanitizePhiPersistedHtml(internalHtml, { allowInternalReferences: true });
    expect(sanitized).toContain(pageUri);
    expect(sanitized).toContain(assetUri);
  });

  it("strips Phi URIs and images outside the internal content channel", () => {
    const sanitized = sanitizePhiPersistedHtml(internalHtml);
    expect(sanitized).not.toContain("phis:");
    expect(sanitized).not.toContain("<img");
  });

  it("drops a percent-encoded Phi scheme instead of decoding it into a reference", () => {
    const sanitized = sanitizePhiPersistedHtml(
      `<p><img src="%70his%3Aasset%2F23" alt="Asset"></p>`,
      { allowInternalReferences: true },
    );
    expect(sanitized).not.toContain("phis:");
    expect(sanitized).not.toContain("src=");
  });

  it("accepts an entity-encoded colon because the parser yields the canonical value", () => {
    // `&colon;` is decoded during HTML parsing, so the attribute reaching validation is already the
    // canonical `phis:asset/23`. Accepting it is not a bypass: the resulting reference is well formed.
    const sanitized = sanitizePhiPersistedHtml(
      `<p><a href="phis&colon;asset/23">Link</a></p>`,
      { allowInternalReferences: true },
    );
    expect(sanitized).toContain(assetUri);
  });

  it("drops a Phi URI whose reference grammar is invalid", () => {
    const sanitized = sanitizePhiPersistedHtml(
      `<p><a href="phis:page/v1.@@@">Broken</a></p>`,
      { allowInternalReferences: true },
    );
    expect(sanitized).not.toContain("phis:");
    expect(sanitized).not.toContain("href=");
  });

  it("still rejects script-bearing schemes in the internal content channel", () => {
    const sanitized = sanitizePhiPersistedHtml(
      `<p><a href="javascript:alert(1)">X</a><script>alert(1)</script></p>`,
      { allowInternalReferences: true },
    );
    expect(sanitized).not.toContain("javascript:");
    expect(sanitized).not.toContain("<script");
  });

  it("keeps ordinary external links and images in the internal content channel", () => {
    const sanitized = sanitizePhiPersistedHtml(
      `<p><a href="https://example.test/a">A</a><img src="https://example.test/i.png" alt="I"></p>`,
      { allowInternalReferences: true },
    );
    expect(sanitized).toContain("https://example.test/a");
    expect(sanitized).toContain("https://example.test/i.png");
  });
});
