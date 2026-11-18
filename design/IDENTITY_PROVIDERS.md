# Identity providers from Add-ons

**Status: design, decided 2026-11-18 (section 8).** Nothing of this is built. Google, Apple, GitHub and Microsoft stay
Core adapters (`src/lib/site-auth`); this document is the contract through which an Add-on supplies a
further login provider -- a Keycloak or another OpenID Connect server, a SAML identity provider, a
national eID, a company SSO. It follows the service-kind boundary of
[SERVER_ADDONS.md](../SERVER_ADDONS.md), "Internal service providers", and does not change
[AUTHENTICATION.md](../AUTHENTICATION.md): Core stays the one authentication authority.

## 1. What an Add-on supplies, and what it does not

An identity provider Add-on speaks one protocol with one kind of provider: it builds the address the
browser is sent to, and it turns what comes back into a validated identity. That is all.

| Core keeps | The Add-on supplies |
| --- | --- |
| the transaction: state, nonce, PKCE verifier, `next`, expiry, one use | the authorization address for a state, nonce and PKCE challenge Core made |
| the flow cookie and the check that this browser started the flow | the exchange of what came back for tokens, and their validation |
| the start and callback routes, including the form-post turn | the subject, address and whether the provider verified it |
| the issuer namespace (section 4) | a stable issuer of its own inside that namespace |
| users, linking, registration policy, membership, factors, sessions, audit | nothing of these |
| the installation row, its settings and its secret reference | the settings it needs, as a schema, and reading its own secret |

An Add-on never sees a session, a user id, a cookie, another installation's secret, or the Site's
policy. It cannot sign anybody in: it can only answer "this provider says the person is subject X",
and Core decides what that means on this Site, exactly as for Google.

**Why a service kind and not `authentication:v1`.** A capability has one supplier, and Core is the
supplier of `@phis/server/authentication:v1`: it is what a Site Module binds to, and it stays that. A
provider is one of several implementations Core chooses between per installation -- the shape Payments
and Media Storage already have. `authentication:v1` keeps its meaning and its name.

## 2. The service kind

```text
service kind      @phis/server/service/identity-provider
interface         PhisIdentityProviderAdapterV1   (@phis/contracts/identity-provider)
provider key      package-qualified, e.g. @acme/keycloak
```

The manifest descriptor carries the service kind, the provider key, the interface digest, the factory
export and the required Core capabilities, as for every service kind. Several identity provider Add-ons
may be installed at once; one Add-on may supply several provider keys.

## 3. The adapter

```ts
/** What the Admin surface and the Login page show, and how Core runs the flow. */
export type PhisIdentityProviderDescriptionV1 = {
  label: string;                       // "Keycloak", shown in the provider select and as the button
  icon: string | null;                 // a sign from the Site's icon set, never a URL
  stages: readonly ("primary" | "step-up")[];
  responseMode: "query" | "form_post"; // how the provider calls back; see "Form-post callbacks"
  pkce: boolean;                       // whether Core makes a PKCE pair for this provider
  settings: PhisIdentityProviderSettingsSchemaV1; // the fields an installation takes, with their checks
  secret: { label: string; hint: string } | null; // null: the provider needs none
  testable: boolean;
};

export type PhisIdentityProviderContextV1 = {
  providerKey: string;
  siteKey: string;
  installationKey: string;
  clientId: string;
  settings: Readonly<Record<string, unknown>>;        // validated against the schema it declared
  readSecret(): Promise<string | null>;               // this installation's secret, and only it
};

export type PhisIdentityProviderIdentityV1 = {
  issuer: string;          // stable per provider instance, see section 4
  subject: string;         // stable and never reassigned by the provider
  email: string | null;
  emailVerified: boolean;  // only what the provider asserts; Core applies the trust rules
  displayName: string | null;
};

export interface PhisIdentityProviderAdapterV1 {
  describe(): PhisIdentityProviderDescriptionV1;
  probe(input: { signal: AbortSignal }): Promise<{ status: "ok" | "failed"; detail: string | null }>;
  begin(input: {
    callbackUrl: string;
    state: string;
    nonce: string;
    pkceChallenge: string | null;
    signal: AbortSignal;
  }): Promise<{ redirectUrl: string }>;
  complete(input: {
    callbackUrl: string;
    parameters: Readonly<Record<string, string>>;  // the callback's answer, after Core checked state
    nonce: string;
    pkceVerifier: string | null;
    signal: AbortSignal;
  }): Promise<PhisIdentityProviderIdentityV1>;
}
```

The factory is called per request with the context of one installation, as Support Forwarding and
Media Sources are. `begin` runs after Core has written the transaction; `complete` runs after Core has
consumed it and checked the state against the flow cookie, so an Add-on is never asked about a callback
Core would refuse. Deadlines: probe 10 s, begin 10 s, complete 20 s, passed as `AbortSignal`.

A throw or an answer that does not hold the contract ends the login as `provider_failed`, is logged
with the provider key, and touches no account.

`displayName` names a newly created account and nothing else: an existing account keeps its name, and
the person can change it afterwards like any name.

### Form-post callbacks

A provider that answers with a form post (`form_post`, SAML's POST binding) does not get its answer
carried in a query: a SAMLResponse does not fit an address, and an answer does not belong in one.
Core reads the posted fields on `POST providers/<method>/callback`, keeps them encrypted in the
transaction the posted `state` (or SAML's `RelayState`) names, and answers `303` to the GET with that
state only. The GET checks the flow cookie as for every provider, takes the kept fields out of the
transaction and hands them to `complete` as `parameters`. Core's own Apple flow moves to the same rule
when this is built (today it carries `code` and `state` in the query).

## 4. Issuers are namespaced

An external identity is `(issuer, subject)`. An Add-on states its issuer, and Core stores it as

```text
addon:<provider key>:<issuer the Add-on stated>
```

So an Add-on can never claim an identity of another provider: whatever it answers, it cannot produce
`https://accounts.google.com`, nor an identity of another Add-on. The issuer it states must stay the
same for the same provider instance (a Keycloak realm URL, a SAML entity id); changing it orphans every
linked identity, and Core treats a different issuer as a different provider.

## 5. Trust

- `trustedEmailLink` is off by default for an Add-on provider and is the operator's decision per
  installation, as for Core providers. Privileged auto-linking never applies to an Add-on provider.
- `emailVerified` is what the Add-on reports the provider asserted. Core does not take it as its own
  verification of the address beyond what the linking policy allows.
- An Add-on provider is offered on a Site only when the Add-on is active on that Site and the
  installation's probe has passed at least once since its last change.

## 6. Installations and the Admin surface

Add-on providers live in the same installation table and the same Admin surface as Core providers. The
provider select lists Core providers and every resolved Add-on provider key. The settings an Add-on
declared are drawn as fields for that provider only (the same `visibleWhen` rule the Core providers
use), stored in the installation's `config` under the Add-on's own keys, and validated by Core against
the declared schema before the Add-on sees them. The secret is written through the same write-only path.

The method key and callback path of an Add-on installation are its installation key,
`/api/auth/providers/<installation key>/callback`, because a provider key contains `@` and `/`. The
installation key is a stable slug per Site and the Admin surface already shows it with the callback
address. An installation key may not be one of Core's method keys.

## 7. Not covered

- **Factors.** A second factor (a hardware token, a push approval) is not a login provider; factors stay
  Core (passkeys and OTP are designed in AUTHENTICATION_PLANNED.md).
- **Directories.** Who exists and who is in which group is
  [DIRECTORY_PROVIDERS.md](./DIRECTORY_PROVIDERS.md). One Add-on may supply both kinds.
- **Provider tokens.** Login tokens are discarded after the identity is resolved. An Add-on that needs
  to call the provider's API on the user's behalf needs a separate integration contract.

## 8. Decisions (2026-11-18)

1. **Core gets a generic OpenID Connect provider** (`oidc`): an installation names the issuer URL,
   Core reads its discovery document and runs the flow it runs for Google today. It covers Keycloak,
   Authentik, Okta, Auth0 and most company SSO without an Add-on to build and audit. This contract is for
   what Core does not speak: SAML, national eIDs, providers outside OpenID Connect. Its identities keep
   the discovered issuer, not the `addon:` namespace, because Core validates them itself.
2. **Form-post answers are kept in the transaction**, not carried in the query (section 3,
   "Form-post callbacks").
3. **The installation key is the method key and the callback path segment** of an Add-on installation
   (section 6).
4. **`displayName` names a new account only** (section 3).

## 9. Build order

0. The generic OpenID Connect provider in Core (decision 1), with the form-post answer kept in the
   transaction (decision 2), which Apple then uses too.
1. Types in `@phis/contracts/identity-provider` and the service kind in the Core catalogue (contracts
   release).
2. Core: resolve Add-on providers, the namespaced issuer, start and callback through the adapter, the
   Admin surface listing them with their declared fields.
3. A reference Add-on (a SAML provider proves the form-post path) and THIRD_PARTY documentation.
