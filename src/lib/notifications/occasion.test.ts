import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/translations", () => ({
  translateWithCache: vi.fn(async ({ msg }: { msg: string }) => `[de] ${msg}`),
}));

import { renderPhiAddonOccasion } from "./occasion";

/**
 * Core's frame around an Add-on's words: salutation, escaping, paragraphs, and links that can only
 * point at the Site itself.
 */
describe("rendering an Add-on's occasion", () => {
  const occasion = {
    name: "order-paid",
    class: "asked-for" as const,
    subject: { text: "Order %1 is paid", parameters: ["number"] },
    lines: [
      { text: "Thank you, %1 is paid.", parameters: ["number"] },
      { text: "Follow it here: %1", parameters: ["link"] },
    ],
    parameters: [
      { name: "number", type: "text" as const },
      { name: "link", type: "path" as const },
    ],
  };

  it("writes the salutation, escapes text and turns a path into a link on the Site", async () => {
    const rendered = await renderPhiAddonOccasion({
      addonId: "@acme/shop",
      occasion,
      params: { number: "<1001>", link: "/shop/order/1001?t=a&b" },
      locale: "en",
      recipientName: "Guest & Co",
      publicBaseUrl: "https://shop.example/",
    });
    expect(rendered.subject).toBe("Order <1001> is paid");
    expect(rendered.bodyHtml).toBe(
      "<p>Hello Guest &amp; Co,</p>"
      + "<p>Thank you, &lt;1001&gt; is paid.</p>"
      + '<p>Follow it here: <a href="https://shop.example/en/shop/order/1001?t=a&amp;b">'
      + "https://shop.example/en/shop/order/1001?t=a&amp;b</a></p>",
    );
    expect(rendered.bodyText).toBe(
      "Hello Guest & Co,\n\nThank you, <1001> is paid.\n\nFollow it here: https://shop.example/en/shop/order/1001?t=a&b",
    );
  });

  it("translates the unparameterised sentences and substitutes afterwards", async () => {
    const rendered = await renderPhiAddonOccasion({
      addonId: "@acme/shop",
      occasion,
      params: { number: "1001", link: "/shop/order/1001" },
      locale: "de",
      recipientName: "Gast",
      publicBaseUrl: "https://shop.example",
    });
    expect(rendered.subject).toBe("[de] Order 1001 is paid");
    expect(rendered.bodyText.startsWith("[de] Hello Gast,")).toBe(true);
    expect(rendered.bodyText).toContain("https://shop.example/de/shop/order/1001");
  });
});
