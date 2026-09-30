import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn(), translate: vi.fn() }));

vi.mock("@/lib/email", () => ({ sendEmail: mocks.send }));
vi.mock("@/lib/translations", () => ({ translateWithCache: mocks.translate }));

import { sendTemplatedEmail } from "./email-templates";

/**
 * A circular owes a way out, and the footer and the header only count together: a header without a link is
 * a mail only a machine can escape, a link without the header is one the reader has to hunt for. These pin
 * that both arrive together, that an asked-for message gets neither, and that `List-Unsubscribe-Post` is
 * not claimed -- one-click needs the header's own URL to accept a bare POST, and a phis Site has no such
 * address.
 */
describe("the unsubscribe footer", () => {
  const site = { id: 1, key: "site", name: "Example Site", sourceLocale: "en" };
  const siteConfig = {
    supportEmail: "support@example.test",
    mailFrom: "no-reply@example.test",
    mailFromName: "Example",
  };

  beforeEach(() => {
    mocks.send.mockReset().mockResolvedValue("<id>");
    mocks.translate.mockReset();
  });

  async function send(unsubscribeUrl?: string) {
    await sendTemplatedEmail({
      to: "reader@example.invalid",
      site,
      siteConfig,
      locale: "en",
      template: "registration_welcome",
      recipientName: "Reader",
      replyTo: unsubscribeUrl ? siteConfig.supportEmail : undefined,
      unsubscribeUrl,
    });
    return mocks.send.mock.calls[0][0];
  }

  it("carries the link, both headers and a reply address when one is given", async () => {
    const message = await send("https://site.test/en/unsubscribe?token=42.sig");

    expect(message.html).toContain('href="https://site.test/en/unsubscribe?token=42.sig"');
    expect(message.html).toContain("Unsubscribe");
    expect(message.headers).toEqual({
      "List-Unsubscribe": "<https://site.test/en/unsubscribe?token=42.sig>",
    });
    // The plain-text alternative must carry it too, or a text-only reader has no way out.
    expect(message.text).toContain("https://site.test/en/unsubscribe?token=42.sig");
    expect(message.replyTo).toBe(siteConfig.supportEmail);
  });

  it("carries none of it for a message the person asked for", async () => {
    const message = await send();

    expect(message.headers).toBeUndefined();
    expect(message.html).not.toContain("unsubscribe");
    expect(message.replyTo).toBeUndefined();
  });

  it("says why the mail arrived before offering the way out", async () => {
    const message = await send("https://site.test/en/unsubscribe?token=42.sig");
    const reasonAt = message.html.indexOf("asked");
    const linkAt = message.html.indexOf("<a href=");

    expect(reasonAt).toBeGreaterThan(-1);
    expect(reasonAt).toBeLessThan(linkAt);
    expect(message.html).toContain("Example Site");
  });

  it("escapes what it puts into the link and the reason", async () => {
    const message = await sendTemplatedEmail({
      to: "reader@example.invalid",
      site: { ...site, name: 'Site "&" <script>' },
      siteConfig,
      locale: "en",
      template: "registration_welcome",
      recipientName: "Reader",
      unsubscribeUrl: 'https://site.test/en/unsubscribe?token=a"><script>',
    });
    const sent = mocks.send.mock.calls[0][0];

    expect(sent.html).not.toContain("<script>");
    expect(sent.html).toContain("&quot;");
    expect(message).toBe("<id>");
  });
});
