import { describe, expect, it, vi } from "vitest";

vi.mock("@/db/site-auth", () => ({
  countSiteUserIdentitiesByIssuer: vi.fn(),
  listAuthProviderInstallations: vi.fn(),
  listSiteAuthMethods: vi.fn(),
}));
vi.mock("@/lib/site-auth/secret-store", () => ({
  hasSiteAuthSecrets: vi.fn(),
  readSiteAuthSecret: vi.fn(),
}));

const {
  buildAuthInstallationConfig,
  findAuthProviderCatalogEntry,
  normalizeAuthInstallationSecret,
  resolveAuthInstallationClientSecret,
} = await import("./installation-catalog");

const apple = findAuthProviderCatalogEntry("apple")!;
const github = findAuthProviderCatalogEntry("github")!;
const google = findAuthProviderCatalogEntry("google")!;
const microsoft = findAuthProviderCatalogEntry("microsoft")!;

function config(result: ReturnType<typeof buildAuthInstallationConfig>) {
  if ("error" in result) {
    throw new Error(`Expected a config, got: ${result.error}`);
  }
  return result.config;
}

/*
 * The one writer for everything the provider flow reads out of an installation's config.
 *
 * Every key here was read on every login and written by nothing: the two admin routes each built a
 * config carrying `tenant` and nothing else, so a scope, a restriction or an email-linking trust could
 * only be set by editing the Site's Auth document in the database. The restriction is the one that
 * mattered -- an organization nobody could enter is a closed door that is open.
 */
describe("the config a provider installation is given", () => {
  it("stores a list as a list, however it was typed", () => {
    expect(config(buildAuthInstallationConfig(github, {}, { scopes: "read:user user:email read:org" })).scopes)
      .toEqual(["read:user", "user:email", "read:org"]);
    expect(config(buildAuthInstallationConfig(github, {}, { scopes: "read:user, read:org" })).scopes)
      .toEqual(["read:user", "read:org"]);
    expect(config(buildAuthInstallationConfig(github, {}, { scopes: ["read:user", "read:org"] })).scopes)
      .toEqual(["read:user", "read:org"]);
  });

  it("refuses a list that is neither, rather than reading it as none", () => {
    // Silently dropping a restriction somebody wrote down opens the Site wider than they think it is.
    expect(buildAuthInstallationConfig(github, {}, { restrictions: 7 }))
      .toEqual({ error: "restrictions must be a list of words or a separated string." });
  });

  it("clears a list an operator emptied out", () => {
    const base = { scopes: ["read:user"], allowedOrganizations: ["example-org"] };
    expect(config(buildAuthInstallationConfig(github, base, { scopes: "", restrictions: "" })))
      .toEqual({});
  });

  it("stores the restriction under the name its provider is narrowed by", () => {
    expect(config(buildAuthInstallationConfig(github, {}, { restrictions: "example-org" })))
      .toEqual({ allowedOrganizations: ["example-org"] });
    expect(config(buildAuthInstallationConfig(google, {}, { restrictions: "example.com" })))
      .toEqual({ hostedDomains: ["example.com"] });
  });

  it("refuses a setting the provider has no use for", () => {
    expect(buildAuthInstallationConfig(github, {}, { tenant: "common" }))
      .toEqual({ error: "GitHub installations take no tenant." });
    expect(buildAuthInstallationConfig(github, {}, { prompt: "consent" }))
      .toEqual({ error: "GitHub installations take no prompt." });
    expect(buildAuthInstallationConfig(microsoft, {}, { restrictions: "example.com" }))
      .toEqual({ error: "Microsoft installations take no login restriction." });
  });

  it("reads an empty one of those as nothing said", () => {
    // The Admin Form posts one body for every provider and leaves what does not apply empty.
    expect(config(buildAuthInstallationConfig(github, {}, {
      tenant: "",
      prompt: "",
      restrictions: "",
      scopes: "read:user",
    }))).toEqual({ scopes: ["read:user"] });
  });

  it("gives a tenant provider one whether or not the body named it", () => {
    expect(config(buildAuthInstallationConfig(microsoft, {}, {})).tenant).toBe("common");
    expect(config(buildAuthInstallationConfig(microsoft, {}, { tenant: "Organizations" })).tenant)
      .toBe("organizations");
    expect(config(buildAuthInstallationConfig(microsoft, { tenant: "consumers" }, {})).tenant)
      .toBe("consumers");
  });

  it("takes the email-linking trust as a boolean and nothing else", () => {
    expect(config(buildAuthInstallationConfig(github, {}, { trustedEmailLink: true })).trustedEmailLink)
      .toBe(true);
    expect(config(buildAuthInstallationConfig(github, { trustedEmailLink: true }, { trustedEmailLink: false })).trustedEmailLink)
      .toBe(false);
    expect(buildAuthInstallationConfig(github, {}, { trustedEmailLink: "yes" }))
      .toEqual({ error: "trustedEmailLink must be a boolean." });
  });

  it("leaves a key the body did not mention where it was", () => {
    const base = { scopes: ["read:user"], allowedOrganizations: ["example-org"], trustedEmailLink: true };
    expect(config(buildAuthInstallationConfig(github, base, { }))).toEqual(base);
  });
});

/*
 * Apple issues no client secret. The installation keeps the `.p8` signing key as its secret and the
 * Team ID and Key ID in its config, and a client secret is signed from the three for each token request.
 */
describe("an Apple installation", () => {
  it("stores the Team ID and Key ID it is signed with", () => {
    expect(config(buildAuthInstallationConfig(apple, {}, { teamId: "ab12cd34ef", keyId: "ZY98XW76VU" })))
      .toEqual({ teamId: "AB12CD34EF", keyId: "ZY98XW76VU" });
  });

  it("refuses an id that is not Apple's ten letters and digits", () => {
    expect(buildAuthInstallationConfig(apple, {}, { teamId: "AB12" }))
      .toEqual({ error: "teamId must be the ten letters and digits of the Apple Team ID." });
    expect(buildAuthInstallationConfig(apple, {}, { keyId: "ZY98XW76VU-1" }))
      .toEqual({ error: "keyId must be the ten letters and digits of the Apple Key ID." });
  });

  it("is the only provider that takes them", () => {
    expect(buildAuthInstallationConfig(google, {}, { teamId: "AB12CD34EF" }))
      .toEqual({ error: "Google installations take no Team ID." });
    expect(buildAuthInstallationConfig(microsoft, {}, { keyId: "ZY98XW76VU" }))
      .toEqual({ error: "Microsoft installations take no Key ID." });
    expect(config(buildAuthInstallationConfig(github, {}, { teamId: "", keyId: "" }))).toEqual({});
  });

  it("takes no prompt, which Apple's authorize endpoint does not know", () => {
    expect(buildAuthInstallationConfig(apple, {}, { prompt: "consent" }))
      .toEqual({ error: "Apple installations take no prompt." });
  });

  it("stores the key as a PEM even when the password field dropped its line breaks", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const pasted = pem.replace(/\n/g, "");
    const stored = normalizeAuthInstallationSecret(apple, pasted);
    expect(stored).toEqual({ secret: pem });
  });

  it("refuses a paste that is no signing key", () => {
    expect(normalizeAuthInstallationSecret(apple, "a-client-secret"))
      .toEqual({ error: "The Apple key must be the contents of the .p8 file from Keys in the Apple Developer account." });
    // Every other provider stores the secret as typed.
    expect(normalizeAuthInstallationSecret(google, "a-client-secret")).toEqual({ secret: "a-client-secret" });
  });

  it("signs a client secret only with both ids", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const installation = { providerKey: "apple", clientId: "com.example.web", config: { teamId: "AB12CD34EF" } };
    expect(() => resolveAuthInstallationClientSecret(installation, pem)).toThrow("AUTH_PROVIDER_SECRET_INVALID");
    const secret = resolveAuthInstallationClientSecret(
      { ...installation, config: { teamId: "AB12CD34EF", keyId: "ZY98XW76VU" } },
      pem,
    );
    expect(secret.split(".")).toHaveLength(3);
    expect(resolveAuthInstallationClientSecret({ ...installation, providerKey: "google" }, "kept")).toBe("kept");
  });
});
