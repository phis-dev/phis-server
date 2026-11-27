import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({ getPhisConfigSync: () => ({ auth: { transactionEncryptionKey: "test-key" } }) }));
vi.mock("@/lib/db", () => ({ getPool: () => { throw new Error("no database in a unit test"); } }));

const { verifyPhisBillingOpen } = await import("./documents.ts");
const { createHmac } = await import("node:crypto");

const DOC = "0b6f4f1e-0000-4000-8000-000000000001";
const sign = (siteId: number, documentId: string, disposition: string, expires: number, key = "test-key") =>
  createHmac("sha256", key).update(`billing-document-open:${siteId}:${documentId}:${disposition}:${expires}`).digest("base64url");

describe("the signed address of an opened document", () => {
  const expires = Math.floor(Date.now() / 1000) + 300;

  it("holds for its document, Site, disposition and end", () => {
    expect(verifyPhisBillingOpen(1, DOC, { d: "inline", e: String(expires), s: sign(1, DOC, "inline", expires) })).toBe("inline");
    expect(verifyPhisBillingOpen(1, DOC, { d: "attachment", e: String(expires), s: sign(1, DOC, "attachment", expires) })).toBe("attachment");
  });

  it("does not hold expired, tampered, for another disposition, document, Site or key", () => {
    const past = Math.floor(Date.now() / 1000) - 1;
    expect(verifyPhisBillingOpen(1, DOC, { d: "inline", e: String(past), s: sign(1, DOC, "inline", past) })).toBeNull();
    expect(verifyPhisBillingOpen(1, DOC, { d: "attachment", e: String(expires), s: sign(1, DOC, "inline", expires) })).toBeNull();
    expect(verifyPhisBillingOpen(1, DOC, { d: "inline", e: String(expires + 1), s: sign(1, DOC, "inline", expires) })).toBeNull();
    expect(verifyPhisBillingOpen(2, DOC, { d: "inline", e: String(expires), s: sign(1, DOC, "inline", expires) })).toBeNull();
    expect(verifyPhisBillingOpen(1, DOC.replace(/1$/u, "2"), { d: "inline", e: String(expires), s: sign(1, DOC, "inline", expires) })).toBeNull();
    expect(verifyPhisBillingOpen(1, DOC, { d: "inline", e: String(expires), s: sign(1, DOC, "inline", expires, "other") })).toBeNull();
    expect(verifyPhisBillingOpen(1, DOC, { d: "inline", e: String(expires), s: null })).toBeNull();
    expect(verifyPhisBillingOpen(1, DOC, { d: "download", e: String(expires), s: sign(1, DOC, "download", expires) })).toBeNull();
  });

  it("refuses an end further out than the longest an address is given", () => {
    const far = Math.floor(Date.now() / 1000) + 3600;
    expect(verifyPhisBillingOpen(1, DOC, { d: "inline", e: String(far), s: sign(1, DOC, "inline", far) })).toBeNull();
  });
});
