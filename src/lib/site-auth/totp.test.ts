import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  buildTotpUri,
  createTotpCode,
  createTotpSecret,
  resolveTotpCodeStep,
  verifyTotpCode,
} from "./totp";

describe("TOTP", () => {
  it("names the step a code belongs to, which is what lets a code be spent once", () => {
    const { secret } = createTotpSecret();
    const now = Date.UTC(2030, 0, 1, 0, 0, 0);
    const step = Math.floor(now / 1000 / 30);

    expect(resolveTotpCodeStep(secret, createTotpCode(secret, now), now)).toBe(step);
    // The previous period's code is still accepted, and says which period it was.
    expect(resolveTotpCodeStep(secret, createTotpCode(secret, now - 30_000), now)).toBe(step - 1);
    expect(resolveTotpCodeStep(secret, createTotpCode(secret, now + 30_000), now)).toBe(step + 1);
    expect(resolveTotpCodeStep(secret, createTotpCode(secret, now + 61_000), now)).toBeNull();
    expect(resolveTotpCodeStep(secret, "12345", now)).toBeNull();
  });

  it("creates and verifies a six-digit code within the allowed time window", () => {
    const { secret, manualKey } = createTotpSecret();
    const now = Date.UTC(2030, 0, 1, 0, 0, 0);
    const code = createTotpCode(secret, now);

    expect(manualKey).toMatch(/^[A-Z2-7]+$/);
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyTotpCode(secret, code, now)).toBe(true);
    expect(verifyTotpCode(secret, code, now + 61_000)).toBe(false);
  });

  it("builds a standards-shaped otpauth URI without exposing unrelated state", () => {
    const uri = buildTotpUri({ manualKey: "JBSWY3DPEHPK3PXP", issuer: "Example", accountName: "user@example.test" });
    const parsed = new URL(uri);

    expect(parsed.protocol).toBe("otpauth:");
    expect(parsed.searchParams.get("secret")).toBe("JBSWY3DPEHPK3PXP");
    expect(parsed.searchParams.get("digits")).toBe("6");
    expect(parsed.searchParams.get("period")).toBe("30");
  });
});
