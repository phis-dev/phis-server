import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  surface: vi.fn(),
  write: vi.fn(),
  read: vi.fn(() => ({})),
  schema: vi.fn(),
  sites: vi.fn(),
  verify: vi.fn(),
  sitesList: vi.fn(async () => [] as unknown[]),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (href: string) => {
    throw new Error(`redirect:${href}`);
  },
}));
vi.mock("@/lib/operator-surfaces", () => ({ requirePhisOperatorSurface: mocks.surface }));
vi.mock("@/lib/config-files", () => ({
  readMergedPhiConfigSync: mocks.read,
  readPhiRuntimeConfigSync: mocks.read,
  writePhiRuntimeConfigSync: mocks.write,
}));
vi.mock("@/lib/config", () => ({ resetPhisConfigCache: vi.fn() }));
vi.mock("@/lib/password-core", () => ({ hashPassword: async () => "hash" }));
vi.mock("@/db/bootstrap", () => ({
  applyPhiBootstrapSchema: mocks.schema,
  createPhiBootstrapSites: mocks.sites,
  grantPhiAddonCoreReferences: vi.fn(),
  verifyPhiDatabaseWriteAccess: mocks.verify,
  readPhiBootstrapSites: mocks.sitesList,
}));

import {
  applySchemaBootstrap,
  completeBootstrapSetup,
  createPlatformSuperUser,
  saveDatabaseConnection,
  saveInitialSites,
  saveTranslationSettings,
} from "./actions";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

/**
 * A Server Action is reachable by its id without the page, so each one answers for the setup gate
 * itself. Once setup is closed, not one of them may write the installation's configuration.
 */
describe("setup actions after setup has closed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.surface.mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");
    });
  });

  const everyAction: Array<[string, () => Promise<unknown>]> = [
    ["createPlatformSuperUser", () => createPlatformSuperUser("en", form({
      displayName: "Op", email: "op@example.test", password: "long-enough!",
    }))],
    ["saveDatabaseConnection", () => saveDatabaseConnection("en", "/setup", form({
      host: "evil.test", port: "5432", database: "phis", user: "phis", password: "x",
    }))],
    ["saveTranslationSettings", () => saveTranslationSettings("en", "/setup", form({}))],
    ["applySchemaBootstrap", () => applySchemaBootstrap("en", "/setup")],
    ["saveInitialSites", () => saveInitialSites("en", "/setup", form({}))],
    ["completeBootstrapSetup", () => completeBootstrapSetup("en", form({ acceptedTerms: "on" }))],
  ];

  it.each(everyAction)("%s refuses before it writes anything", async (_name, run) => {
    await expect(run()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.surface).toHaveBeenCalledWith("setup");
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.schema).not.toHaveBeenCalled();
    expect(mocks.sites).not.toHaveBeenCalled();
  });
});

describe("the database step while setup is open", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.surface.mockImplementation(() => undefined);
    mocks.read.mockReturnValue({ database: { uri: "postgresql://phis:st%3Ared@db.internal:5432/phis" } });
  });

  it("keeps the stored password when the field comes back empty, as the page leaves it", async () => {
    await expect(saveDatabaseConnection("en", "/setup/next", form({
      host: "db.internal", port: "5432", database: "phis", user: "phis", password: "",
    }))).rejects.toThrow("redirect:/setup/next");

    const written = new URL(String(mocks.verify.mock.calls[0]?.[0]));
    expect(decodeURIComponent(written.password)).toBe("st:red");
  });

  it("takes a password that was typed", async () => {
    await expect(saveDatabaseConnection("en", "/setup/next", form({
      host: "db.internal", port: "5432", database: "phis", user: "phis", password: "typed",
    }))).rejects.toThrow("redirect:/setup/next");

    expect(new URL(String(mocks.verify.mock.calls[0]?.[0])).password).toBe("typed");
  });
});

describe("finishing the setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.surface.mockImplementation(() => undefined);
  });

  function finish() {
    return completeBootstrapSetup("en", form({ acceptedTerms: "on" }));
  }

  it("refuses to close without an operator who can sign in", async () => {
    mocks.read.mockReturnValue({ platformSuperUsers: [], database: { uri: "postgresql://db/phis" } });
    mocks.sitesList.mockResolvedValue([{ key: "site" }]);
    await expect(finish()).rejects.toThrow(/redirect:.*operator/i);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("refuses to close without a Site", async () => {
    mocks.read.mockReturnValue({
      platformSuperUsers: [{ email: "op@example.test", passwordHash: "h", enabled: true }],
      database: { uri: "postgresql://db/phis" },
    });
    mocks.sitesList.mockResolvedValue([]);
    await expect(finish()).rejects.toThrow(/redirect:.*Site/);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("closes once both are there", async () => {
    mocks.read.mockReturnValue({
      platformSuperUsers: [{ email: "op@example.test", passwordHash: "h", enabled: true }],
      database: { uri: "postgresql://db/phis" },
    });
    mocks.sitesList.mockResolvedValue([{ key: "site" }]);
    await expect(finish()).rejects.toThrow("redirect:/operator");
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ bootstrap: { enabled: false } }));
  });
});
