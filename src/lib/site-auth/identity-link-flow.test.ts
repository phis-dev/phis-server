import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  consumeTransaction: vi.fn(),
  createTransaction: vi.fn(),
  getMethod: vi.fn(),
  getIdentityUserId: vi.fn(),
  linkIdentity: vi.fn(),
  getUserByEmail: vi.fn(),
  getUserById: vi.fn(),
  getAuthorization: vi.fn(),
  verifyPassword: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
}));

vi.mock("@/db/user-accounts", () => ({
  getUserAccountByEmail: mocks.getUserByEmail,
  getUserAccountById: mocks.getUserById,
}));
vi.mock("@/db/site-auth", () => ({
  consumeAuthTransaction: mocks.consumeTransaction,
  createAuthTransaction: mocks.createTransaction,
  getSiteAuthMethod: mocks.getMethod,
  getUserIdByExternalIdentity: mocks.getIdentityUserId,
  linkExternalIdentity: mocks.linkIdentity,
}));
vi.mock("@/db/user-site-memberships", () => ({
  getEffectiveUserSiteAuthorization: mocks.getAuthorization,
}));
vi.mock("@/lib/auth", () => ({
  randomToken: () => "link-token",
  sha256Hex: (value: string) => `hash:${value}`,
}));
vi.mock("@/lib/password", () => ({ verifyPasswordHash: mocks.verifyPassword }));
vi.mock("@/lib/site-auth/transaction-crypto", () => ({
  encryptAuthTransactionPayload: mocks.encrypt,
  decryptAuthTransactionPayload: mocks.decrypt,
}));

import {
  confirmExternalIdentityLink,
  createExternalIdentityLinkChallenge,
} from "./identity-link-flow";

const identity = {
  issuer: "https://accounts.google.com",
  subject: "google-subject",
  providerKey: "google",
  email: "user@example.test",
  emailVerified: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.encrypt.mockReturnValue({
    ciphertextHex: "ciphertext",
    ivHex: "iv",
    authTagHex: "tag",
  });
});

describe("external identity link confirmation", () => {
  it("stores only a hash of the browser token and encrypted provider identity", async () => {
    const challenge = await createExternalIdentityLinkChallenge({
      siteId: 7,
      userId: 42,
      methodKey: "google",
      providerInstallationKey: "google",
      identity,
      nextPath: "/admin",
    });

    expect(challenge.token).toBe("link-token");
    expect(mocks.encrypt).toHaveBeenCalledWith({ version: 1, identity });
    expect(mocks.createTransaction).toHaveBeenCalledWith(expect.objectContaining({
      siteId: 7,
      userId: 42,
      methodKey: "google",
      providerInstallationKey: "google",
      stage: "step-up",
      stateHash: "hash:link-token",
      nextPath: "/admin",
    }));
  });

  it("links the validated identity only after the existing password succeeds", async () => {
    mocks.consumeTransaction.mockResolvedValue({
      userId: 42,
      methodKey: "google",
      providerInstallationKey: "google",
      stage: "step-up",
      payloadCiphertext: "ciphertext",
      payloadIv: "iv",
      payloadAuthTag: "tag",
      nextPath: "/admin",
    });
    mocks.decrypt.mockReturnValue({ version: 1, identity });
    mocks.getMethod.mockResolvedValue({
      enabled: true,
      provider: { enabled: true, installationKey: "google" },
    });
    mocks.getUserById.mockResolvedValue({
      id: 42,
      siteIds: [7],
      passwordHash: "password-hash",
      flags: 0,
    });
    mocks.getUserByEmail.mockResolvedValue({ id: 42 });
    mocks.getIdentityUserId.mockResolvedValue(null);
    mocks.verifyPassword.mockResolvedValue(true);
    mocks.getAuthorization.mockResolvedValue({ enabled: true, coreRoleFlags: 1, roleClaims: [] });

    const result = await confirmExternalIdentityLink({
      siteId: 7,
      token: "link-token",
      password: "valid-password",
    });

    expect(mocks.consumeTransaction).toHaveBeenCalledWith(7, "hash:link-token");
    expect(mocks.verifyPassword).toHaveBeenCalledWith("password-hash", "valid-password");
    expect(mocks.linkIdentity).toHaveBeenCalledWith({
      userId: 42,
      issuer: identity.issuer,
      subject: identity.subject,
      providerKey: "google",
    });
    expect(result).toEqual(expect.objectContaining({ methodKey: "google", nextPath: "/admin" }));
  });

  it("does not link an identity when password confirmation fails", async () => {
    mocks.consumeTransaction.mockResolvedValue({
      userId: 42,
      methodKey: "google",
      providerInstallationKey: "google",
      stage: "step-up",
      payloadCiphertext: "ciphertext",
      payloadIv: "iv",
      payloadAuthTag: "tag",
      nextPath: "/admin",
    });
    mocks.decrypt.mockReturnValue({ version: 1, identity });
    mocks.getMethod.mockResolvedValue({
      enabled: true,
      provider: { enabled: true, installationKey: "google" },
    });
    mocks.getUserById.mockResolvedValue({
      id: 42,
      siteIds: [7],
      passwordHash: "password-hash",
      flags: 0,
    });
    mocks.getUserByEmail.mockResolvedValue({ id: 42 });
    mocks.getIdentityUserId.mockResolvedValue(null);
    mocks.verifyPassword.mockResolvedValue(false);

    await expect(confirmExternalIdentityLink({
      siteId: 7,
      token: "link-token",
      password: "wrong-password",
    })).rejects.toThrow("AUTH_LINK_INVALID_CREDENTIALS");
    expect(mocks.linkIdentity).not.toHaveBeenCalled();
  });
});
