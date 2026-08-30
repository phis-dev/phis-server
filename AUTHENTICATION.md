# Phi Authentication Contract

This document is the normative target v1 contract for Site authentication, global Phi user identity,
authentication-method policy, account linking, Site sessions, bootstrap recovery, and the corresponding
`@phis/ui` Auth Module. Authorization starts only after this contract has established a Site
session and follows [AUTHORIZATION.md](./AUTHORIZATION.md).

This contract intentionally breaks the pre-v1 ABI. Email-address upserts, `user_accounts.site_ids`, a
Medusa-owned browser session, and UI-owned authentication decisions must not remain as parallel identity
or session paths. The complete v1 schema is defined directly by `scripts/sql/001_create_phis.pgsql`; Core
does not ship incremental migration scripts before v1.

Platform-operator authentication under `/api/operator/*` is a separate infrastructure boundary and is
not covered by this Site-viewer contract.

## 1. Ownership and trust boundaries

`phi-server` Core is the authentication authority. It owns:

- global Phi users, verified email addresses, credentials, external identities, and Site memberships;
- Site authentication policy and provider-installation validation;
- password verification, OAuth 2.0/OpenID Connect callbacks, WebAuthn, TOTP, one-time codes, recovery,
  account linking, and session creation or revocation;
- CSRF protection, OAuth state, nonce, PKCE, redirect validation, rate limiting, and audit events;
- the common first-party adapters for password, passkey, Google, Apple, GitHub, Microsoft identity
  platform, TOTP, email OTP, SMS OTP, and recovery codes.

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

- `user_accounts` has no `site_ids` array and no home-Site identity rule;
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

## 4. Target persistence model

The normalized target model includes at least these relations:

- `user_accounts`: global identity, global non-role state, locale preference, and timestamps;
- `user_emails`: global user, normalized address, verification, primary state, source, and timestamps;
- `user_password_credentials`: one current password hash and credential-change metadata per user;
- `user_auth_identities`: global user plus stable issuer and subject;
- `user_site_memberships`: the unique global-user/Site relation and Site-local state;
- `user_site_role_claims`: Site- and provider-scoped authorization claims;
- `site_auth_config`: one versioned Site JSON document containing policy, enabled method/stage
  combinations, order, presentation, and non-secret provider installation configuration;
- `user_auth_factors`: Site-scoped passkey, TOTP, and recovery-code enrollments with a compact numeric
  factor type;
- `user_site_external_accounts`: Site-scoped Medusa or other domain-system account mappings outside the
  Auth identity model;
- `user_sessions`: Site membership, hashed session secret, authentication time, assurance/method state,
  expiry, revocation, and request metadata;
- short-lived authentication transactions and challenges, stored in PostgreSQL or an equivalent central
  expiring store.

Provider secrets, TOTP seeds, recovery codes, reset tokens, session secrets, and one-time codes are never
stored in plaintext. A provider installation stores only an opaque secret reference where the deployment
secret system is authoritative.

The current `email_normalized`, `password_hash`, `medusa_customer_id`, `customer_number`, and `site_ids`
fields on `user_accounts`, the `medusa_auth_token` session field, and email-based `ensureUserAccount()`
upserts are migration input only. They are not a second target-v1 path.

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

Method and stage are separate. Password, passkey, and Google/Apple/GitHub/Microsoft login are common
primary methods. Passkeys may also satisfy second-factor or step-up policy. TOTP is a second-factor or
step-up method. Email OTP may be enabled as primary, second-factor, or recovery according to Site policy.
SMS OTP is normally second-factor or recovery. Recovery codes are recovery only.

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

The provider flow is:

1. The browser starts a method through the Site's same-origin Auth endpoint.
2. Core resolves the trusted Site, enabled method, and active provider installation.
3. Core creates an opaque, expiring, one-use transaction containing the Site id, installation id, hashed
   state and nonce, PKCE verifier where applicable, and a validated relative `next` destination.
4. The browser is redirected to the provider, where the user authenticates and grants any requested
   consent.
5. The provider redirects to the registered callback with an authorization code and state.
6. Core consumes the transaction, exchanges the code server-side, validates issuer, audience/client,
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
`phis-cli` recovery. Email equality alone never moves an existing external identity, merges two users,
or overrides a disabled account.

Concurrent registration/link attempts must serialize on the unique email and external-identity keys. A
conflict is re-resolved under the same rules; it must not create a second user.

## 8. Passwords, passkeys, factors, and recovery

Password credentials are global user credentials whose availability is controlled per Site. Password
hashing, verification, rehash policy, reset-token consumption, and session revocation are Core-only
operations. Login and recovery responses must not disclose whether an email or account exists.

Passkeys use WebAuthn. Enrollment and assertion validation are server-generated challenges bound to the
Site's approved origin and RP id. A passkey credential stores the credential id, public key, signature
counter/backup state, transports where useful, user handle, RP scope, and timestamps; the private key
never leaves the authenticator. A passkey may serve as primary authentication or satisfy a stronger
factor according to Site policy.

TOTP enrollment is Site-scoped. Core creates the secret and `otpauth` payload; the Auth UI may render its
QR code and manual setup key. Enrollment becomes active only after the user confirms a valid six-digit
code. Recovery codes are generated once, displayed once, stored only as hashes, and consumed atomically.

Email and SMS delivery are transports, not trust authorities. Core creates and validates the one-time
challenge while the configured mail/SMS service only delivers it. Codes are short-lived, attempt-limited,
single-use, and bound to Site, user/workflow, and intended stage.

The server chooses the next challenge and returns an opaque challenge id plus a closed UI challenge kind.
The client renders that challenge; it must not reconstruct the authentication state machine from enabled
buttons or decide that MFA can be skipped.

## 9. Assurance gate and mandatory factor enrollment

Core owns the authentication state machine. Its semantic progression is:

```text
anonymous
  -> primary-verified
  -> factor-enrollment-required or factor-challenge-required
  -> complete
```

Successful primary authentication does not by itself create a fully authorized Site session when the
current Site policy requires greater assurance. Core may retain the intermediate state only in a
short-lived Auth transaction or restricted pre-session. That state authorizes the current Auth workflow,
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

The canonical `phi-server` API lives under `/api/v1/auth/*`. A Site runtime exposes the browser-facing
same-origin facade under `/api/auth/*`, injects trusted Site/server credentials, forwards only approved
headers and payload fields, and transports the host-bound session cookie. Browser code never receives the
server API token or provider secret.

The target facade includes these semantic operations:

- `GET /api/auth/manifest` and `GET /api/auth/me`;
- `POST /api/auth/password/login`;
- `POST /api/auth/providers/:provider/start`;
- `GET /api/auth/providers/:provider/callback`;
- `POST /api/auth/providers/link/confirm`;
- `POST /api/auth/challenges/:challengeId/verify`;
- `POST /api/auth/logout`;
- authenticated identity, passkey, TOTP, recovery-code, and session-management operations under
  `/api/auth/account/*`;
- authorized Site Auth policy and provider-installation operations under `/api/auth/admin/*`.

Exact payload schemas are versioned wire contracts. Unknown method keys, challenge kinds, stages, callback
origins, and fields are rejected. Redirect destinations are normalized relative Site paths from an
allowlisted Area/path policy; open redirects are forbidden.

## 12. One multi-Area Auth Module

The first-party frontend feature is one logical optional Module, `@phis/ui/auth`, not separate
login, settings, and account-security Modules. Its target Area eligibility is exactly `public`, `admin`,
and `app`. App and every other authenticated Area consume an existing Core session without the Module;
App activation supplies the first-party authenticated self-service security surface.

The default Phi Site preset activates that same Module id in all three eligible Areas:

- Public contributions: `/login`, `/logout`, `/register`, `/confirm`, `/reset-password`, the reusable
  `PhiLoginWidget`, challenge/mandatory-enrollment surfaces, and the modal-capable Auth Controller;
- Admin contribution: the Site Auth settings route through the Admin `settings` route mount. The module id
  maps to the effective path `/settings/phis+ui+auth` and injects its navigation item below the
  Area-owned Settings container;
- App contribution: `/security`, a composed credential/identity/factor/recovery/session management
  surface, an Account Widget menu contribution targeting effective `/app/security`, and in-place
  reauthentication for an already mounted App document whose complete session subsequently expires.

The App surface is available only to a complete Site session. Mandatory enrollment before session
completion remains a Public Auth workflow even when it reuses the same presentation components.

Navigation overlays may reorder, reparent, or tombstone those items without changing their effective
route paths. Tombstoning the Area-owned Settings container hides its remaining subtree at runtime while
Builder navigation authoring retains the disabled source items, as defined by the route-mount/navigation
contract.

The Auth Module owns one meaningful Area-mounted Auth Controller type. Its Public instance coordinates
login modal, provider redirect, challenge, mandatory enrollment, and return-state presentation. Its Admin
instance coordinates provider configuration status, setup tests, and settings feedback. Its App instance
coordinates account-security presentation and in-place session reauthentication. No instance owns
security decisions or secret state. Another authenticated Area may expose in-place reauthentication only
when its resolved Auth provider projection explicitly declares `primary-login`.

The same `PhiLoginWidget` is the content primitive for both the real `/login` Page and modal login. A
modal is a container/host mode, not a second login implementation. `/<locale>/login` is a real localized
Public Page resolved from the active Public Auth Module's canonical `/login` route preset, never a route
whose only purpose is to open a modal.

## 13. Replaceable Auth UI provider

Runtime Modules may contribute an immutable, owner-scoped Auth UI provider descriptor and separate lazy
Client implementation, following the existing provider/Client-manifest boundaries. Global mutable
registries, import-side-effect registration, request-derived imports, and Core imports of the first-party
login implementation are forbidden.

For one Area's active module set:

- zero Auth UI providers is valid and means that Area exposes no Auth presentation;
- exactly one provider is the active presentation provider;
- more than one provider is a hard descriptor-resolution error, never a first-match choice.

A third party replaces authentication presentation by activating its Module and deactivating
`@phis/ui/auth` in the relevant Areas. Tooling should offer an atomic Public, Admin, and App
replacement, but Area activation remains independent: a Site may replace Public login while retaining the
first-party Admin settings or App security surface when the provider contracts remain compatible.

Every resolved Area projection of a provider descriptor declares its closed Core
workflow-presentation capabilities, including the applicable primary-login, factor-challenge,
factor-enrollment, recovery, account-security, and site-settings kinds. Capabilities are resolved per
Area and must not be copied as one global union onto every eligible Area. Area eligibility does not imply
support. Core rejects a policy activation when the active presentation cannot complete its required
workflows and fails closed if a required capability later disappears. A provider submits responses to
Core; it cannot declare a factor, assurance result, or session complete.

The first-party Public projection exposes login and pre-session workflow presentation, Admin exposes Site
settings, and App exposes account security plus `primary-login` for in-place session recovery. A
third-party replacement may provide the same App capability or omit it; omission selects the canonical
Public login redirect rather than a first-party or Core-owned modal fallback.

The stable replacement route is `/login`. A third-party Auth Module replaces it by deactivating the
first-party Module in Public and contributing its own canonical `/login` route preset and compatible Auth
UI provider. Site access guards resolve that stable Public route and must never import, reactivate, or
special-case the first-party login implementation. Area activation remains independent, so compatible
first-party Admin settings or App security may remain active while Public login is replaced.

The provider is presentation-only. It consumes the public Auth manifest and opaque server workflow. If a
third party also needs new server behavior, its Module binds to its own Add-on under `SERVER_ADDONS.md`;
that Add-on still returns Core-compatible identity and session outcomes.

## 14. Account Widget and profile ownership

`PhiAccountWidget` remains a Core/shared account surface because guest/account state, profile links,
commerce links, and logout are useful in several Areas independently of the first-party Auth Module.

It consumes the generic viewer/session snapshot. For a guest, it delegates login presentation to the
single resolved Auth UI provider. If no provider is active, it must not import or silently render the
first-party login form. For an authenticated viewer, it may invoke the Core logout action directly.

The account menu accepts owner-scoped contributions such as profile, orders, billing, identity security,
and logout. Personal profile data and user administration are not made Auth-Module concerns merely because
they appear in the same menu. Credential, passkey, TOTP, linked-identity, and session management remain
authentication-security surfaces.

The first-party Auth Module contributes the Account Widget's security item and targets `/app/security`.
The Account Widget does not import or implement that route and remains functional without Auth.

## 15. Admin settings and secrets

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

The store is `phis.server_secrets`, described in section 16 of
[SERVER_ADDONS.md](./SERVER_ADDONS.md): one encrypted row per secret, under a root key that stays in each
instance's runtime configuration. A provider installation holds the reference
`site:<site key>:core:auth.<installation key>` and never a value.

It used to be a line in `config/phis-runtime.json`, written there by an admin request. That made every
provider an operator configured live on exactly one host -- a second instance cannot be handed that file
without copying it, and a rotation had to reach every copy. An installation still carrying the old field
runs `phis auth import-secrets` once; it moves the values into the store, rewrites the stored references,
and removes the field.

The status an admin surface reports is an existence check, not a decryption, and so is the question the
public method manifest asks about whether a provider is offered at all. Only a flow that actually
authenticates resolves a value.

## 16. Bootstrap, disablement, and preset restore

The first Site Admin is created out of band through `phis-cli` or through a single-use, short-lived setup
token produced by `phis-cli`. First-time setup is accepted only while the Site has no Admin and the token
is valid. It may bind a password, passkey, or validated external identity and must create the global user,
Site membership, and Core Admin role claim atomically. Public registration never grants an Admin role.

`phis-cli` also owns emergency recovery: unlock an Admin, reset factors, revoke sessions, or issue a new
single-use bootstrap flow under explicit operator authority.

Disabling the Auth Module is permitted and has no hidden runtime fallback. Existing sessions and Core
logout continue to work; login/settings routes contributed by the disabled Module do not. The Builder may
warn when no Public Auth UI provider is active, but it must not auto-enable one.

The CLI operation `phis-cli auth restore-preset --site <site-key>` is the semantic recovery contract. It
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

## 17. Security and audit requirements

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
