# Phi Authentication Contract

This document is the server-side contract for Site authentication, global Phi user identity,
authentication-method policy, account linking, Site sessions, and bootstrap recovery. Authorization starts
only after this contract has established a Site session and follows [AUTHORIZATION.md](./AUTHORIZATION.md).
The presentation side -- the `@phis/ui/auth` Module, its Areas, the Auth UI provider, and the Account
Widget -- is specified in [phis-ui AUTHENTICATION.md](../phis-ui/AUTHENTICATION.md).

Email-address upserts, a Medusa-owned browser session, and UI-owned authentication decisions are not
identity or session paths. The schema is defined by `scripts/sql/001_create_phis.pgsql`; table columns are
described in [DB.md](./DB.md).

Platform-operator authentication under `/api/operator/*` is a separate infrastructure boundary and is
not covered by this Site-viewer contract.

## 1. Ownership and trust boundaries

`@phis/server` Core is the authentication authority. It owns:

- global Phi users, verified email addresses, credentials, external identities, and Site memberships;
- Site authentication policy and provider-installation validation;
- password verification, OAuth 2.0/OpenID Connect callbacks, TOTP, recovery codes, account linking, and
  session creation or revocation;
- CSRF protection, OAuth state, nonce, PKCE, redirect validation, rate limiting, and audit events;
- the common first-party adapters for password, Google, Apple, GitHub, Microsoft identity platform,
  TOTP, and recovery codes. Passkey, email OTP, and SMS OTP are reserved method keys with policy fields
  but no adapter; their design is in [AUTHENTICATION_PLANNED.md](./design/AUTHENTICATION_PLANNED.md).

The first-party Site/client Auth Module is `@phis/ui/auth`. It owns presentation and browser
orchestration only. It may render login, registration, challenge, enrollment, recovery, and Site Auth
settings surfaces, but it never validates provider tokens, verifies credentials, decides account
identity, or creates sessions.

The first-party Auth Module binds to Core. A third-party replacement using only the standard Auth API also
binds to Core; only a replacement requiring a new server authentication capability binds to its one
audited Add-on.

Authentication is not a required Site Module. A Site may disable or replace every authentication UI
contribution. Doing so never disables Core session validation or authorization for an already issued
session, and it never installs a hidden fallback UI.

A third-party Site Module may replace the first-party Auth Module UI while continuing to use Core Auth.
A new server-side authentication protocol or identity authority requires an audited Server Add-on bound
to that Module. A Module alone must never receive credentials, load secret material, or become a second
session authority. Every successful Add-on authentication still resolves to one Core-owned Phi user,
Site membership, and Site session.

## 2. Global user identity and Site membership

`phis.user_accounts.id` is the single global Phi user id. One logical Phi account keeps the same user id
across every Site.

Site access is represented only by `phis.user_site_memberships(user_id, site_id)`. The membership owns
Site-local account state such as enabled or disabled access, consent, last login, authorization revision,
and role claims. A user without a membership for the current Site is not an authenticated member of that
Site.

The target model therefore has these hard rules:

- `user_accounts` stores no Site list and has no home-Site identity rule;
- a global user row does not itself permit login on any Site;
- adding a Site never creates a second global user merely because the Site is new;
- one Site may admit an existing global user according to its registration or invitation policy;
- sessions are always Site-scoped and never imply automatic cross-Site SSO;
- Site role claims remain separate from identity and follow `AUTHORIZATION.md`.

Commerce and other external customer records are Site-scoped relations. A value such as a Medusa
customer id belongs in a `(user_id, site_id, provider)` external-account relation, not on the global
`user_accounts` row.

## 3. Durable identifiers and email addresses

An external identity is keyed by the provider's stable `(issuer, subject)` pair. For OpenID Connect,
these are the validated `iss` and `sub` claims. A non-OIDC adapter must define an equivalent stable
issuer and durable provider user id; the GitHub adapter, for example, uses GitHub's durable numeric user
id as `subject`, never the mutable login name.

Display name, username, access token, provider installation, client id, and email address are not
external identity keys. One global user may own several external identities and several verified email
addresses. One external identity may belong to exactly one global user.

`phis.user_emails` is the durable email relation. Normalized email addresses are globally unique across
Phi users; registration workflow snapshots remain outside that table until the address is accepted as a
durable account address. Verification state, primary-address state, and source are explicit. Email is a
contact and account-discovery attribute, not proof of identity by itself.

`phis.user_auth_identities` maps a unique `(issuer, subject)` to one `user_id`. The provider installation
used for a login is validated for the current Site before this global mapping is resolved. This permits
several Site-specific provider clients to resolve to the same Phi user while preventing a client or
audience accepted for Site A from being replayed as a login for Site B.

## 4. Persistence model

Authentication uses these relations:

- `user_accounts`: global identity, global flags, locale preference, and timestamps;
- `user_emails`: global user, normalized address, verification time, primary flag, source, and timestamps;
- `user_password_credentials`: one current password hash and credential-change metadata per user;
- `user_auth_identities`: global user plus stable issuer and subject;
- `user_site_memberships`: the unique global-user/Site relation and Site-local state;
- `user_site_role_claims`: Site- and provider-scoped authorization claims;
- `site_auth_config`: one versioned Site JSON document containing policy, enabled method/stage
  combinations, order, presentation, and non-secret provider installation configuration;
- `user_auth_factors`: Site-scoped TOTP and recovery-code enrollments with a compact numeric factor type;
- `user_site_external_accounts`: Site-scoped Medusa or other domain-system account mappings outside the
  Auth identity model;
- `user_sessions`: Site membership, hashed session secret, authentication time, assurance level,
  workflow state (`auth_state`), the accepted Site policy revision, method keys, preserved `next` path,
  expiry, revocation, and request metadata;
- `auth_transactions`: short-lived, one-use provider and link transactions with hashed state and nonce and
  an encrypted payload;
- `user_password_reset_tokens`: hashed, expiring, one-use reset tokens per Site membership;
- `registration_intents`: pending registrations awaiting email verification.

Provider secrets, TOTP seeds, recovery codes, reset tokens, session secrets, and one-time codes are never
stored in plaintext. A provider installation stores only an opaque secret reference where the deployment
secret system is authoritative.

## 5. Site authentication policy

Every authentication decision resolves a trusted Site before reading method policy. The Site comes from
the server-owned host/request context or a server-to-server Site binding; a browser query parameter,
posted Site id, OAuth callback parameter, or provider claim must never select it.

The methods array in `site_auth_config.config` configures each `(methodKey, stage)` independently. It
controls whether the combination is enabled, its order, its public label/icon metadata, and its provider
installation key where applicable. The supported stages are:

- `primary`: establishes the initial authenticated user;
- `second-factor`: completes a configured multi-factor login;
- `step-up`: raises assurance for a sensitive action or privileged session;
- `recovery`: restores access after the normal method is unavailable.

Method and stage are separate. The allowed stages per method key are fixed by `PHI_CORE_AUTH_METHODS`
(`src/lib/site-auth/contracts.ts`): password and Google/Apple/GitHub/Microsoft login are `primary` or
`step-up`; TOTP is `second-factor` or `step-up`; recovery codes are `recovery` only. The reserved keys
`passkey`, `email-otp`, and `sms-otp` carry stage definitions but no adapter.

The public Auth manifest exposes only currently usable method keys, stages, order, presentation metadata,
and same-origin start actions. It exposes no client secret, secret reference, raw provider-installation id,
TOTP seed, policy-internal trust decision, or account-existence signal.

Site policy also owns:

- registration mode: `disabled`, `invite-only`, or `automatic`;
- existing-account linking mode: `disabled`, `verified-email-confirm`, or `verified-email-auto`;
- whether privileged-account automatic linking is explicitly allowed, defaulting to `false`;
- password, passkey, MFA, step-up, recovery, and session policy;
- required-factor enforcement timing and membership/role scope;
- provider restrictions such as Google hosted domains or GitHub organizations;
- approved callback origins and relative post-authentication destinations.

Global identity existence never enables that identity's method on another Site. Site A may offer Apple
and Google while Site B offers password only.

## 6. Provider installation and callback flow

In v1, each Site operator registers the Site with Google, Apple, GitHub, Microsoft identity platform, or
another provider and records the exact callback URI required by that provider. The Site Auth settings
flow stores the public client metadata and writes or rotates the secret through a server-only secret path.
Provider registration is a deployment/configuration step; an OAuth callback is not a webhook.

Provider installations and enabled login methods are separate Site configuration. A stable installation
contains its provider kind, public client id, opaque write-only secret reference, provider-specific
restrictions, enabled state, exact callback URI, and validation/test status. More than one installation of
a provider kind is permitted. Core derives the fixed issuer/discovery rules for built-in providers;
arbitrary browser-supplied issuer URLs are not trusted configuration. Microsoft configuration uses the
Microsoft name and an explicit `common`, `organizations`, `consumers`, or concrete-tenant policy.

An installation's provider settings are written in one place, `buildAuthInstallationConfig`
(`src/lib/site-auth/installation-catalog.ts`), which both the create and the update route go through
and which the Admin Form reaches through those routes. The settings are the requested `scopes`, the
login `restrictions`, the OAuth `prompt`, the Microsoft `tenant`, and `trustedEmailLink`, the
per-installation half of verified-email auto-linking. A restriction is stored under the name its
provider is narrowed by, declared as `restrictionKey` in the provider catalog: Google is narrowed by
hosted domain against the `hd` claim, GitHub by active membership of an organization. Apple and
Microsoft declare none, and a setting a provider has no use for is refused rather than stored. Empty
clears a setting, and the provider flow then asks for its own default scope -- `read:user user:email`
at GitHub, `openid email profile` at an OIDC provider. A GitHub organization restriction also needs
`read:org` among the scopes, because the membership is read with the login's own token.
`scripts/validate-auth-installation-config-keys.mjs` holds both halves of that: every setting the
provider flow reads is written there, and nothing is written that nothing reads.

The provider flow is:

1. The browser starts a method through the Site's same-origin Auth endpoint.
2. Core resolves the trusted Site, enabled method, and active provider installation.
3. Core creates an opaque, expiring, one-use transaction containing the Site id, installation id, hashed
   state and nonce, PKCE verifier where applicable, and a validated relative `next` destination. The
   state also goes to the starting browser in an `httpOnly` cookie, so the callback can tell the
   browser that began the flow from one that was merely handed its URL.
4. The browser is redirected to the provider, where the user authenticates and grants any requested
   consent.
5. The provider redirects to the registered callback with an authorization code and state.
6. Core refuses the callback unless the state in the URL is the one in that browser's cookie, then
   consumes the transaction, exchanges the code server-side, validates issuer, audience/client,
   signature, expiry, nonce, PKCE, and provider-specific requirements, then resolves `(issuer, subject)`.
7. Core resolves or links the global user, applies the current Site membership policy, completes any
   required challenge, and only then issues a Site session.

Login-only provider tokens are discarded after identity resolution. Persistent tokens used to access a
provider API belong to a separately authorized integration/Add-on contract and encrypted token store;
they must not be retained merely because the provider was used for login.

Standards-compliant protocol libraries such as `openid-client` may implement OAuth/OIDC mechanics inside
Core, but a library's user adapter, database model, session model, or framework middleware is not the Phi
identity contract.

## 7. Registration and account linking

Identity resolution is transactional and follows this order:

1. If `(issuer, subject)` already exists, Core uses its linked global user.
2. If that user has a current Site membership, Site policy and any required factor determine whether a
   session may be issued.
3. If the user has no current Site membership, the Site's registration/invitation policy decides whether
   that membership may be added. Core does not create a second user.
4. If the external identity is new and supplies no provider-verified email, Core requires an explicit
   verification or authenticated linking flow before creating or linking an account.
5. If it supplies a provider-verified email with no Phi match, Core may create the global user and Site
   membership only when registration policy permits it.
6. If exactly one existing verified Phi email matches, Core must not create a duplicate user. It either
   links safely under the configured policy or returns a non-enumerating `link_required` workflow.

`verified-email-confirm` requires the user to prove control of an already linked method, complete a
separate verified-email challenge, or use an authorized recovery/bootstrap flow. `verified-email-auto`
may link without that extra prompt only when all of these conditions hold:

- the provider response and token are fully validated for the current Site installation;
- the provider is explicitly trusted by Site policy for verified-email linking;
- the provider supplies an explicit verified-email assertion normalized to exactly one verified Phi
  email;
- the external identity is not linked to another Phi user;
- the target user and Site membership state permit login;
- the account is not privileged, unless privileged automatic linking was explicitly enabled.

After a validated provider callback resolves `link_required`, Core stores the validated external identity
only in an encrypted, expiring, one-use `step-up` transaction. The browser receives a host-bound HttpOnly
confirmation cookie, not the provider claims, candidate user id, or email. `POST
/api/auth/providers/link/confirm` proves an already linked method, consumes the transaction even when the
proof fails, revalidates the Site membership and identity collision, links the identity, and only then
starts the normal Site assurance/session flow. An expired or failed confirmation requires a fresh provider
login. The UI returns to the normal Login Widget with a non-enumerating failure message and preserves the
validated `next` destination; it must not leave the user in a consumed confirmation state. The first v1
confirmation mechanism is the existing password; passkey and other linked-method proofs extend the same
transaction without changing the account-linking decision.

Core Admin and other privileged accounts default to confirmation with an existing method, step-up, or
`phis` CLI recovery. Email equality alone never moves an existing external identity, merges two users,
or overrides a disabled account.

Concurrent registration/link attempts must serialize on the unique email and external-identity keys. A
conflict is re-resolved under the same rules; it must not create a second user.

## 8. Passwords, passkeys, factors, and recovery

Password credentials are global user credentials whose availability is controlled per Site. Password
hashing, verification, rehash policy, reset-token consumption, and session revocation are Core-only
operations. Login and recovery responses must not disclose whether an email or account exists.

TOTP enrollment is Site-scoped. Core creates the secret and `otpauth` payload; the Auth UI may render its
QR code and manual setup key. Enrollment becomes active only after the user confirms a valid six-digit
code. Recovery codes are generated once, displayed once, stored only as hashes, and consumed atomically.

Passkeys (WebAuthn) and email or SMS one-time codes are not implemented; see
[AUTHENTICATION_PLANNED.md](./design/AUTHENTICATION_PLANNED.md).

The server chooses the next step. `GET /api/v1/auth/workflow` returns the session's workflow state
(`factor-enrollment-required`, `factor-challenge-required`, or `complete`), the method key, and the
preserved `next` path. The client renders that state; it must not reconstruct the authentication state
machine from enabled buttons or decide that MFA can be skipped.

## 9. Assurance gate and mandatory factor enrollment

Core owns the authentication state machine. Its semantic progression is:

```text
anonymous
  -> primary-verified
  -> factor-enrollment-required or factor-challenge-required
  -> complete
```

Successful primary authentication does not by itself create a fully authorized Site session when the
current Site policy requires greater assurance. Core retains the intermediate state as a restricted session
whose `auth_state` is not complete. That state authorizes the current Auth workflow,
approved recovery/support escape paths, and Core logout only. It never authorizes App, Admin, Builder,
Editor, Accounting, their APIs, or another protected resource.

When policy requires Site-scoped TOTP and the user has no acceptable active TOTP factor, Core returns a
mandatory enrollment workflow instead of issuing the complete session. Core creates the pending secret
and `otpauth` payload, accepts the submitted six-digit confirmation, and activates the factor only after
successful verification. A user with an acceptable active factor receives the corresponding challenge.
Only Core may mark enrollment, challenge, achieved assurance, and the Site session complete.

Once complete, Core issues or upgrades the Site session and resolves the preserved, validated `next`
destination inside the server-selected Area. If that destination is not present in the access-filtered
Site route catalog, navigation falls back to that Area's root.

The same assurance result is mandatory at every protected Area route and API boundary. Client redirects,
navigation visibility, and UI state are not enforcement. Sessions record the Site Auth policy revision
under which they were accepted. When policy changes, Core reevaluates stale sessions according to the
configured activation mode: immediately, at the next login, or after an explicit grace deadline. The
policy may apply to every Site membership or an explicit role scope. An insufficient session becomes
restricted to the required Auth workflow until policy is satisfied.

External-provider MFA may satisfy policy only when Core validates an explicit provider assurance signal,
such as configured OIDC `amr`/`acr` semantics, against a Site-owned trust mapping. Generic external MFA
never satisfies a policy that explicitly requires a local Site TOTP enrollment.

A required-factor policy cannot become effective unless the active Auth UI provider set declares the
necessary enrollment and challenge presentation capabilities and at least one compliant recovery or
operator-recovery path remains available. Core fails closed if those capabilities later disappear.

## 10. Sessions, logout, and authorization handoff

A successful workflow issues a session bound to exactly one `(user_id, site_id)` membership. The session
records authentication time, authentication method references, achieved assurance, expiry, revocation,
and a hashed secret. Role claims are resolved separately through `AUTHORIZATION.md`.

A global user logged into Site A is not implicitly logged into Site B. A future explicit federation/SSO
feature may streamline authentication between Sites, but it must still create a separate Site B session
after Site B policy and membership checks.

Logout is a Core session operation and is available even when the Auth Module is disabled. It is a
CSRF-protected `POST`; `GET /logout` may render an Auth-Module confirmation/transition page but must not
revoke a session merely by being fetched. Sites may revoke the current session, all sessions for the
current Site, or all user sessions only through explicitly distinct authorized actions.

A protected Area document rendered under a complete session may later observe Core's canonical
expired/invalid-session result. If the active Auth UI provider projection for that Area declares
`primary-login`, the Site may present the same login workflow in an Area-local modal while masking and
disabling the stale protected surface. Core continues to reject every protected request until a new
complete session exists. Successful reauthentication may revalidate or reload the preserved relative
path, but a state-changing request is never replayed implicitly.

This in-place flow does not weaken the server boundary. A direct navigation, reload, or server render
without a complete session is redirected to the active Public Auth Module's canonical localized
`/login?next=...` Page before the protected Area is rendered. Closing or escaping in-place
reauthentication uses the same Public route. When the current Area lacks a provider projection with
`primary-login`, client-observed session expiry redirects there immediately. Redirect destinations remain
server-validated relative Site paths.

## 11. HTTP boundary

The canonical `@phis/server` API lives under `/api/v1/auth/*` and requires the internal API token. A Site
mounts the browser-facing same-origin facade `/api/auth/*` from `@phis/ui/next/route-handlers`; it forwards
`/api/auth/<path>` to `/api/v1/auth/<path>`, injects the Site key and the internal token, and transports the
host-bound session cookie. Browser code never receives the server API token or provider secret.

The `/api/v1/auth/*` operations are:

- `GET manifest`, `GET me`, `GET csrf`;
- `POST password/login`, `POST password/reset/request`, `POST password/reset/confirm`;
- `POST providers/:provider/start`, `GET providers/:provider/callback`, `POST providers/link/confirm`;
- `GET workflow`, `POST workflow/verify`, `POST workflow/totp/enroll`, `POST workflow/totp/confirm`;
- `POST logout`;
- `GET account/security`, `DELETE account/factors/:factorId`, `DELETE account/sessions/:sessionId`;
- `PATCH profile/name`, `PATCH profile/locale`, `PATCH profile/theme`, `PATCH profile/newsletter`,
  `PATCH profile/password`, `POST profile/email/request`;
- Site Admin operations: `PATCH admin/policy`, `PATCH admin/password-method`, `PATCH admin/totp-policy`,
  `GET|POST|PATCH admin/installations`, `PATCH|DELETE admin/installations/:installationKey`,
  `POST admin/installations/:installationKey/test`.

The request and response schemas are listed in the generated [API reference](./docs/API.md).

The implementations of `csrf`, `password/login`, `logout`, `me`, `password/reset/*` and `profile/*` live
in `src/lib/site-auth/handlers/` and are reachable only through the matching `/api/v1/auth/*` routes, which
require the internal token. A Site's `/api/auth` door forwards to them. The operator console asks
`/api/operator/auth/csrf` for its own token.

Unknown method keys, stages, callback origins, and fields are rejected. Redirect destinations are
normalized relative Site paths; open redirects are forbidden.

## 12. Auth UI Module, Areas, and Account Widget

The first-party Auth Module, its Public/Admin/App contributions, the replaceable Auth UI provider, and the
`PhiAccountWidget` boundary are specified in [phis-ui AUTHENTICATION.md](../phis-ui/AUTHENTICATION.md).
Core's obligations toward them are the ones in this document: Core owns every security decision, and a
provider submits responses to Core but cannot declare a factor, assurance result, or session complete.

## 13. Admin settings and secrets

The Auth Module's Admin settings surface is restricted by the Core Site-Admin policy and manages only the
current Site. It may configure method/stage
enablement and order, provider installation status, registration, account-linking, password/passkey,
MFA/step-up, recovery, session, callback-origin, hosted-domain, and organization policies.

The surface uses a provider catalog rather than treating provider buttons as configuration. It keeps
installation enablement separate from login-method presentation and exposes provider-specific non-secret
fields, exact callback URI, ordering, restrictions, and validation/test state. It also configures whether
a factor is allowed or required, its enforcement timing and scope, and accepted recovery paths.

Secrets are write-only. Admin reads return only configured/missing/invalid/rotation-needed status and
non-secret identifiers. Secret creation, replacement, test, and rotation use an authorized server-side
flow and emit an audit event. Auth configuration is semantic Site state backed by normalized Auth tables
and the secret store; it is not theme data, generic Module Storage, or browser-owned config.

The store is `phis.server_secrets`, described in
[SERVER_ADDONS.md](./SERVER_ADDONS.md): one encrypted row per secret, under a root key that stays in each
instance's runtime configuration. A provider installation holds the reference
`site:<site key>:core:auth.<installation key>` and never a value.

Provider secrets are never read from `config/phis-runtime.json`; configuration validation rejects an
`auth.secrets` field. `phis auth import-secrets` moves the values of such a field into `phis.server_secrets`,
rewrites the stored installation references, and removes the field from the file.

The status an admin surface reports is an existence check, not a decryption, and so is the question the
public method manifest asks about whether a provider is offered at all. Only a flow that actually
authenticates resolves a value.

## 14. Bootstrap, disablement, and preset restore

The first Site Admin is created out of band through `phis site admin --site <site key> --email <email>`,
which creates the global user with a password when the address is new, and writes the Site membership and
the Core Admin role claim in one transaction. `--list` and `--revoke` read and remove the grant. Public
registration never grants an Admin role. A setup-token flow and further CLI recovery operations are
planned in [AUTHENTICATION_PLANNED.md](./design/AUTHENTICATION_PLANNED.md).

Disabling the Auth Module is permitted and has no hidden runtime fallback. Existing sessions and Core
logout continue to work; login/settings routes contributed by the disabled Module do not. The Builder may
warn when no Public Auth UI provider is active, but it must not auto-enable one.

The CLI operation `phis auth restore-preset --site <site-key>` is the semantic recovery contract. It
restores the first-party `@phis/ui/auth` activation and its code-owned route presets in Public,
Admin, and App. Because this is an explicit operator recovery command, it deactivates conflicting
Auth UI provider Modules in those three Areas and reports every activation change, but does not uninstall
or delete them. Auth-owned Page snapshot pointers are cleared so the installed code preset becomes
effective again, together with the deletion mark that travels with them -- a page an operator deleted is
restored, not merely unpointed; their historical revisions remain recoverable. Before committing, the
operation reads the Site back and refuses when Public still names no active first-party owner, so a
repair never reports success over a login that stays unreachable. An already identical effective preset
is idempotent and creates no new revision.

Navigation is deliberately not part of the operation. An Auth navigation item is contributed by the
Module and returns with it; what the control plane would have to know to restore one -- which items the
Module injects, under which keys -- is Module metadata it does not hold, and carrying that list as a copy
would make a repair silently incomplete the moment the Module gained an item. An override or tombstone an
operator placed on such an item is ordinary Site customization, it locks nobody out, and it survives the
repair. The command does not create users, enable authentication methods, overwrite provider policy,
replace secrets, relink identities, or mutate sessions.

## 15. Security and audit requirements

All credential, provider-start, callback, code-verification, linking, enrollment, recovery, and logout
operations use method-appropriate CSRF/replay protection and rate limits. Authentication transactions,
reset tokens, challenges, and bootstrap tokens are short-lived, single-use, and invalid after successful
consumption.

Security-relevant operations emit structured audit events with Site, global user when known, method,
outcome, reason category, transaction correlation, and request metadata. Logs and analytics must never
contain passwords, session secrets, provider tokens, authorization codes, TOTP seeds, OTP values, recovery
codes, or raw secret references.

User-facing failures are non-enumerating. Detailed causes remain server-side and access-controlled. Core
must fail closed for unknown providers, stale installations, issuer/audience mismatch, untrusted email
claims, disabled methods, invalid membership, missing factor policy, callback replay, or conflicting
identity ownership.
