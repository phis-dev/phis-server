import { describe, expect, it } from "vitest";

import { sanitizePhiPersistedHtml } from "../src/lib/html";

describe("persisted HTML sanitization", () => {
  it("keeps the supported editorial subset", () => {
    expect(sanitizePhiPersistedHtml(
      '<h2 style="text-align: center; color: #123456">Title</h2><p>Hello <strong>world</strong>.</p>',
    )).toBe(
      '<h2 style="text-align:center;color:#123456">Title</h2><p>Hello <strong>world</strong>.</p>',
    );
  });

  it("removes executable markup, event handlers, and unsafe URLs", () => {
    expect(sanitizePhiPersistedHtml(
      '<script>alert(1)</script><p onclick="alert(2)">Safe <a href="javascript:alert(3)">link</a></p>',
    )).toBe("<p>Safe <a>link</a></p>");
  });

  it("removes unsupported styles and trailing empty editor blocks", () => {
    expect(sanitizePhiPersistedHtml(
      '<p style="background-image:url(javascript:alert(1)); text-align:right">Text</p><p><br></p>',
    )).toBe('<p style="text-align:right">Text</p>');
  });
});
