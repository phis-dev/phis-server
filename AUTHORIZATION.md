# Phi Viewer Authorization Contract

This document is the v1 contract for Site-scoped viewer roles, provider-qualified group claims, Add-on
roles, access evaluation, persistence, and API enforcement in `@phis/server`. Site rendering and
responsive visibility consume this contract through `@phis/ui`; they must not define a second
authorization model. General group persistence, membership semantics, and Media Space authorization
are governed by [GROUPS_AND_STORAGE.md](./GROUPS_AND_STORAGE.md). Local and external user/group Directory
provider bindings and assertion provenance are designed in
[DIRECTORY_PROVIDERS.md](./design/DIRECTORY_PROVIDERS.md).

Authentication, global user identity, Site membership admission, and session creation are governed by
[AUTHENTICATION.md](./AUTHENTICATION.md). This document begins after a valid Site session exists; role
claims never serve as credentials or identity-linking evidence.

The claim shapes, policy shapes, and the evaluator live in `@phis/contracts/access`
(`phis-contracts/src/access.ts`). `@phis/server` re-exports them from `src/lib/authorization.ts` and adds
only the named Core policies.

## 1. Roles, groups, and claims

There are three kinds of claim.

**Core role claim.** Core's roles are bit flags in the namespace of the Core role provider
`@phis/server/core`:

```ts
type PhiRoleProviderId = `@${string}/${string}`;

type PhiViewerRoleClaim = {
  providerId: PhiRoleProviderId;
  flags: number;
};
```

Every authenticated Site viewer has one effective Core claim, even when its flags are zero. A role is not
an individual permission. A flag value that is not a non-negative integer is read as no flags.

**Group claim.** A group is a stable provider-qualified Site audience, not a role or permission:

```ts
type PhiGroupProviderId = `@${string}/${string}`;

type PhiViewerGroupClaim = {
  providerId: PhiGroupProviderId;
  key: string;
  flags: number; // membership level bits: Member, Author, Editor, Manager
};
```

Group keys are provider-local and immutable after publication. Membership levels govern domain
operations server-side; the shared access policy tests only effective membership in one of the declared
groups.

**Add-on role claim.** An Add-on's roles are named strings, declared in its manifest:

```ts
type PhiViewerAddonRoleClaim = {
  providerId: PhiRoleProviderId; // the Add-on id
  roles: readonly string[];
};
```

Names rather than bits, because an Add-on's roles are declared in its own manifest: a bit position
would have to be handed out and kept forever, and reordering the manifest would silently change what a
policy means. Core never interprets the names.

A Server Add-on never evaluates any of this itself. It declares `@phis/server/authorization:v1` and
`@phis/server/roles:v1` and receives bound objects on its request context: whether the acting user may act
on one of its rows, what level they hold in a group, whether they hold a Site access, and whether they
hold one of the Add-on's own roles. These answer and grant nothing. See
[SERVER_ADDONS.md](./SERVER_ADDONS.md), section 13.

## 2. Runtime authorization snapshot

The authenticated viewer response (`GET /api/v1/auth/me`, `user`; a Site's `/api/auth/me`) carries compact claims, not expanded
role names or permission lists:

```ts
{
  roleClaims: readonly PhiViewerRoleClaim[];
  groupClaims: readonly PhiViewerGroupClaim[];
  addonRoleClaims: readonly PhiViewerAddonRoleClaim[];
  authorizationRevision: number;
}
```

`authorizationRevision` is the Site membership's `authorization_revision`. It changes whenever the Core
role claim or a group membership changes, and is part of authorization-sensitive cache identity. Runtime
snapshots carry only compact stable group keys; expanded group labels, descriptions, member lists, and
domain metadata remain in dedicated authorized endpoints.

The response's `area` is a separately derived landing preference (`src/lib/user-area.ts`). It does not
authorize or prohibit Area access. Area access is evaluated through the same access policy as every other
contribution.

The Areas are `public`, `app`, `admin`, `builder`, `editor`, and `accounting`
(`src/lib/constants/cms-areas.ts`). The `admin` Area is the shared Site control-plane host for Core Admin
and Developer viewers: Core Developer resolves to `admin`, while user, role and Site administration remain
protected by Core-Admin-only policies. Observability and developer tooling use the Core Developer policy
and are also reachable by Core Admin through the Site-superuser override.

## 3. Shared access policy

Server routes, CMS Pages, Areas, Navigation contributions, renderable artifacts, and API guards use one
policy shape:

```ts
type PhiViewerAccessPolicy =
  | { access: "anyone" }
  | { access: "anonymous" }
  | { access: "authenticated" }
  | { access: "roles"; providerId: PhiRoleProviderId; allowedRoleFlags: number }
  | { access: "groups"; providerId: PhiGroupProviderId; allowedGroupKeys: readonly string[] }
  | { access: "addon-roles"; providerId: PhiRoleProviderId; allowedRoles: readonly string[] };
```

Combined `allowedRoleFlags`, `allowedGroupKeys`, and `allowedRoles` always mean OR: the viewer needs at
least one. The v1 policy does not define `allFlags`, deny flags, arbitrary boolean policy trees, or
implicit per-feature permission lists.

Evaluation (`canPhiAccessSubjectReach`) is:

1. A missing policy is `anyone`, and `anyone` always allows.
2. `anonymous` allows only an unauthenticated viewer.
3. Every other policy requires authentication; `authenticated` then allows.
4. For `roles`, `groups`, or `addon-roles`, a viewer with the Core `Admin` role is allowed before
   provider-specific matching.
5. `groups` requires a matching group claim of that provider.
6. `addon-roles` requires a matching Add-on role claim of that provider. A viewer that carries no
   `addonRoleClaims` is denied.
7. `roles` requires `allowedRoleFlags > 0` and an overlapping flag in the claim of that provider.

The Core Admin override is a normative Site-superuser rule. It applies to every Site-scoped Core or
Add-on role or group policy, but it does not:

- satisfy `anonymous`;
- make an unavailable Server capability available;
- enable a disabled, missing, incompatible, or misconfigured Add-on;
- bypass an external provider's own authorization;
- grant global operator, infrastructure, or cross-Site authority.

A factual helper that asks whether a claim contains a role (`hasProviderRole`, `hasPhiBaseRole`,
`hasProviderGroup`, `hasProviderAddonRole`) does not apply the Admin override. Only the evaluator applies
it.

A Module may reference Core roles and groups, and additionally the roles and groups of its own
`serverBinding` provider. Referencing a different provider creates an undeclared second dependency and is
invalid (`isPhiAccessPolicyProviderOwned`). The Core provider is universal and does not count as a second
binding.

## 4. Core role matrix

Core keeps stable individual role flags (`PhiBaseRole`): Admin, Builder, Publisher, Author, Developer,
Supporter, and Accountant. Reusable access policies are centrally declared masks in
`src/lib/authorization.ts`, not separate permissions:

```text
Site administration  = Admin only
Developer tools      = Developer
Structure authoring  = Developer | Builder
Content editing      = Developer | Author | Publisher
Publishing           = Developer | Publisher
Site Media           = Developer | Builder | Author | Publisher
Support              = Developer | Supporter
Accounting           = Developer | Accountant
```

Core Admin is omitted from the masks because the evaluator grants the Site-admin override centrally.
These are also the Site accesses an Add-on names in `grantableBy` or `hasSiteAccess`: `site-admin`,
`developer-tools`, `structure-authoring`, `content-editing`, `publishing`, `site-media`, `support`,
`accounting`.

Site groups are not roles and follow their own split: creating a group, putting a retired group back in
service, and granting or revoking the Manager level are `Developer | Admin`; a group's Manager retires
their group and administers its Author, Editor and Member levels. There is no group deletion. Group
membership never confers any Core role. The full table is in [GROUPS_AND_STORAGE.md](./GROUPS_AND_STORAGE.md).

Only Core Admin may assign or remove Core role flags on a Site (the write methods of
`/api/site/admin/users`, or
`phis site admin` for the operator). Add-on roles are granted separately (section 5) and grant authority
only inside that Add-on; they never grant Core user or role administration.

## 5. Add-on roles

An Add-on declares named roles in its manifest, each with the policy that decides who may grant it
(`PhisAddonRoleDescriptor` in `@phis/contracts/addon`):

```ts
roles: [
  { name: "market-admin", grantableBy: { siteAccess: "site-admin" } },
  { name: "vendor",       grantableBy: { role: "market-admin" } },
]
```

- A role name matches `^[a-z][a-z0-9-]{0,63}$` and is frozen from the first assignment.
- `grantableBy` is either `{ siteAccess }`, one of the Site accesses in section 4, or `{ role }`, another
  role of the same Add-on.
- At least one role must be grantable by a Site access; a set in which every role is granted by another
  role is refused at validation.
- A Site Admin may always grant and revoke any role of any Add-on.

Assignments are stored in `phis.site_addon_user_roles` (`site_id`, `addon_id`, `user_id`, `role`,
`granted_by_user_id`, `granted_at`), written by `POST`/`DELETE /api/site/addon-roles` after `grantableBy`
is evaluated against the acting user, and by `phis addon role --grant`/`--revoke` for the operator.
Add-ons never write this table.

Add-on roles are checked in three places, all against the roles the current manifest declares:

- the handler, through `roles:v1` (`has(role)`, `all()`);
- a declared query stating `requiresRole` or `alsoAllowedByRole`;
- a browser or server access policy `{ access: "addon-roles", providerId, allowedRoles }`, evaluated
  against the viewer's `addonRoleClaims`.

The full declaration, granting, and data-path rules are in [SERVER_ADDONS.md](./SERVER_ADDONS.md),
section 13, *Add-on roles*.

## 6. Site-scoped persistence

Core role flags are stored in `phis.user_site_role_claims`:

```text
user_site_role_claims
├── user_id
├── site_id
├── provider_id
├── role_flags     INT, > 0
├── created_at
└── updated_at
```

The primary key is `(user_id, site_id, provider_id)`. The row references the Site membership
`(user_id, site_id)` and is deleted with it. The Core role assignment is the row whose provider is
`@phis/server/core`. A zero assignment is represented by deleting the row; runtime resolution still
materializes the authenticated viewer's effective Core claim with zero flags. Core writes only the Core
provider's row.

Add-on role assignments are stored in `phis.site_addon_user_roles` (section 5).

Provider-qualified group claims use the one normalized `site_groups` and `site_group_members` path from
[GROUPS_AND_STORAGE.md](./GROUPS_AND_STORAGE.md). Core role and group membership writers increment the
Site membership's `authorization_revision`; Modules and Add-ons never maintain an independent
effective-membership table.

Claims are written only through authorized `@phis/server` routes and CLI commands. Site Modules and
Add-ons never write authorization tables directly.

## 7. Provider lifecycle

Claim effectiveness requires the provider to be `available` in the Site's capability snapshot: installed,
registered, globally enabled, Site-enabled, compatible, and correctly configured. Core's own provider is
always effective.

- A role flag claim of an unavailable provider is omitted from the effective claims.
- A group claim is omitted when the group's provider or the membership's source provider is unavailable,
  when the group is retired, or when the membership has expired.
- An Add-on role claim is omitted when the Add-on is not enabled globally or for the Site, and a role the
  current manifest no longer declares is omitted from `addonRoleClaims` and from `roles:v1`.

Disabling or removing an Add-on keeps its persisted rows; re-enabling a compatible provider restores
them. `phis addon purge` deletes the Add-on's role assignments and retires its groups. Core-owned groups
remain effective when an optional Groups administration Module is disabled, because that Module is UI,
not the security authority.

## 8. Enforcement

One pure evaluator, `canPhiAccessSubjectReach` from `@phis/contracts/access`, implements this policy
contract. It is compiled once and used by `@phis/server` (as `canPhiViewerAccess`) and by `@phis/ui` for:

- Site Area and Page access;
- active route resolution;
- Navigation projection;
- server-rendered artifact filtering;
- Site API guards;
- client display helpers.

Client evaluation is presentation only. Route resolution and every state-changing or protected read API
must enforce the same policy server-side.

CMS write validation (`src/lib/cms/write-validation.ts`) checks the policy object in render-block config,
in Command Toolbar button config, and in a Page's `accessPolicy`. An explicitly present malformed policy
makes the write invalid; it is never normalized to public access. The validator accepts every shape in
section 3 and refuses anything else, by reading the policy through `readPhiViewerAccessPolicy` from
`@phis/contracts/access` rather than restating the shapes: the provider id, the group keys, the Add-on
role names, and `allowedRoleFlags > 0` are checked exactly as the evaluator's own reader checks them. A
Page's `accessPolicy` is stored as that reader returns it, with each group key and role name once.

A stored policy states a requirement, not a fact about the Server. Whether the named provider is
installed, enabled for the Site, compatible, and correctly configured is decided on every read
(section 7), so a policy naming an Add-on that is absent is **accepted at write and matches nobody at
render**: its claims are simply not among the viewer's, so the surface is hidden until the Add-on is back,
apart from the Core Admin override. Refusing it at write would instead make the Page unsavable for as
long as the Add-on is off and lose what the author stated. Module artifact minima and provider ownership
are resolved by the compiled `@phis/ui` Module catalog, while `@phis/server` remains the authority for
claims and protected API operations.

Role-specific convenience guards may exist, but they must delegate to the shared evaluator and must not
reproduce independent `allowAdmin`, `allowDeveloper`, or similar decision logic.

## 9. Responsive visibility

Viewport visibility is not authorization. `@phis/server` may persist the shared viewport flag matrix, but
it must never use viewport or user-agent detection to grant API, Area, Page, or role access. The
normative display policy and inheritance rules live in `@phis/ui`.
