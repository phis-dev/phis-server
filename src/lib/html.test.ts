import { describe, expect, it } from "vitest";

import { sanitizePhiPersistedHtml } from "@/lib/html";

const internal = { allowInternalReferences: true } as const;

describe("persisted HTML image sizing", () => {
  it("keeps the size attributes an image carries", () => {
    const html = sanitizePhiPersistedHtml(
      `<p><img src="https://cdn.test/1.png" alt="A" title="T" width="480" height="320"></p>`,
      internal,
    );
    for (const attribute of [`title="T"`, `width="480"`, `height="320"`]) {
      expect(html).toContain(attribute);
    }
  });

  it("keeps a relative size an attribute cannot express", () => {
    const html = sanitizePhiPersistedHtml(
      `<p><img src="https://cdn.test/1.png" alt="A" style="width: 50%; height: 12rem"></p>`,
      internal,
    );
    expect(html).toMatch(/width:\s*50%/u);
    expect(html).toMatch(/height:\s*12rem/u);
  });

  it.each([
    "width: calc(100% - 10px)",
    "width: var(--x)",
    "width: auto",
    "width: 50",
    "width: expression(alert(1))",
    "background: url(https://evil.test/x.png)",
    "position: fixed",
  ])("rejects %s", (declaration) => {
    expect(sanitizePhiPersistedHtml(
      `<p><img src="https://cdn.test/1.png" alt="A" style="${declaration}"></p>`,
      internal,
    )).not.toContain("style=");
  });

  it("grants the permission to the image alone", () => {
    expect(sanitizePhiPersistedHtml(`<p style="width: 50%">sized</p>`, internal)).not.toContain("style=");
  });

  it("still admits colour and text alignment everywhere", () => {
    const html = sanitizePhiPersistedHtml(`<p style="color: #ff0000; text-align: center">x</p>`, internal);
    expect(html).toMatch(/color:\s*#ff0000/u);
    expect(html).toMatch(/text-align:\s*center/u);
  });
});
