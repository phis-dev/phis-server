import { describe, expect, it } from "vitest";

import { fillPhiRuntimeKeys, listMissingPhiRuntimeKeys, PHI_RUNTIME_KEY_NAMES } from "./runtime-keys";

describe("runtime keys", () => {
  it("makes every missing key as 64 hex characters", () => {
    const { config, created } = fillPhiRuntimeKeys({});
    expect(created).toEqual(PHI_RUNTIME_KEY_NAMES);
    expect(listMissingPhiRuntimeKeys(config)).toEqual([]);
    expect(config.secrets?.encryptionKeyVersion).toBe(1);
    for (const value of [
      config.api?.internalToken,
      config.auth?.transactionEncryptionKey,
      config.registration?.intentEncryptionKey,
      config.operator?.sessionSecret,
      config.secrets?.encryptionKey,
    ]) {
      expect(value).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("keeps a key that is there", () => {
    const { config, created } = fillPhiRuntimeKeys({ api: { internalToken: "kept" } });
    expect(created).not.toContain("api.internalToken");
    expect(config.api?.internalToken).toBe("kept");
    expect(fillPhiRuntimeKeys(config).created).toEqual([]);
  });
});
