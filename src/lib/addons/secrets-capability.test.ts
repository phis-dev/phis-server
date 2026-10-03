import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolve: vi.fn() }));

vi.mock("@/lib/secrets/resolver", () => ({ resolvePhiSecret: mocks.resolve }));

import { buildPhisAddonSecretsCapability } from "./secrets-capability";

/**
 * Which secret a read names. The two an operator can set are distinct records, and a read must name
 * exactly the one it asked for -- never the other in its place.
 */
describe("secrets capability", () => {
  const secrets = buildPhisAddonSecretsCapability({ addonId: "@phis/github", siteKey: "acme" });
  const owner = { kind: "addon", addonId: "@phis/github" };

  beforeEach(() => {
    mocks.resolve.mockReset();
  });

  it("reads the Site's own secret by default", async () => {
    mocks.resolve.mockResolvedValue("site-value");
    expect(await secrets.read("token")).toBe("site-value");
    expect(mocks.resolve).toHaveBeenCalledWith(owner, "site:acme:addon:@phis/github:token");
  });

  it("reads the secret shared by every Site when asked for it", async () => {
    mocks.resolve.mockResolvedValue("shared-value");
    expect(await secrets.read("app-private-key", "addon")).toBe("shared-value");
    expect(mocks.resolve).toHaveBeenCalledWith(owner, "addon:@phis/github:app-private-key");
  });

  it("answers a missing Site secret with null, not with the shared one", async () => {
    mocks.resolve.mockResolvedValue(null);
    expect(await secrets.read("token", "site")).toBeNull();
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
  });

  it("refuses a scope it does not know", async () => {
    await expect(secrets.read("token", "global" as never)).rejects.toThrow(/scope/);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});
