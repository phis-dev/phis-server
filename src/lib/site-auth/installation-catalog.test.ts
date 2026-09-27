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

const { buildAuthInstallationConfig, findAuthProviderCatalogEntry } =
  await import("./installation-catalog");

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
    const base = { scopes: ["read:user"], allowedOrganizations: ["phi-systems"] };
    expect(config(buildAuthInstallationConfig(github, base, { scopes: "", restrictions: "" })))
      .toEqual({});
  });

  it("stores the restriction under the name its provider is narrowed by", () => {
    expect(config(buildAuthInstallationConfig(github, {}, { restrictions: "phi-systems" })))
      .toEqual({ allowedOrganizations: ["phi-systems"] });
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
    const base = { scopes: ["read:user"], allowedOrganizations: ["phi-systems"], trustedEmailLink: true };
    expect(config(buildAuthInstallationConfig(github, base, { }))).toEqual(base);
  });
});
