# Phi Viewer Authorization Contract

This document is the normative target v1 contract for Site-scoped viewer roles, provider-qualified
group claims, access evaluation, persistence, and API enforcement in `@phis/server`. Site rendering and
responsive visibility consume this contract through `@phis/ui`; they must not define a second
authorization model. General group persistence, membership semantics, and Media Space authorization
are governed by [GROUPS_AND_STORAGE.md](./GROUPS_AND_STORAGE.md). Local and external user/group Directory
provider bindings and assertion provenance are governed by
[DIRECTORY_PROVIDERS.md](./DIRECTORY_PROVIDERS.md).

Authentication, global user identity, Site membership admission, and session creation are governed by
[AUTHENTICATION.md](./AUTHENTICATION.md). This document begins after a valid Site session exists; role
claims never serve as credentials or identity-linking evidence.

The migration to this contract is an ABI break. The old Base/Custom flag transport and the new provider
claim transport must not coexist as alternative authorization paths.

## 1. Roles, providers, and claims

A role is one stable flag in the namespace of exactly one role provider. A role is not an individual
permission. A provider owns its flag meanings, labels, and assignment validation.

```ts
type PhiRoleProviderId = `@${string}/${string}`;

type PhiViewerRoleClaim = {
  providerId: PhiRoleProviderId;
  flags: number;
};
```

`@phis/server/core` is the universal Core role provider. Every authenticated Site viewer has one
effective Core claim, even when its flags are zero. An enabled compatible Add-on may contribute at most
one additional claim for its own provider id.

Role flag spaces are provider-local. The same numeric bit used by two providers has no relationship and
cannot collide.

A group is a stable provider-qualified Site audience, not a role or permission:

```ts
type PhiGroupProviderId = `@${string}/${string}`;

type PhiViewerGroupClaim = {
  providerId: PhiGroupProviderId;
  groupKeys: readonly string[];
};
```

Group keys are provider-local and immutable after publication. Membership capabilities such as Member,
Author, Editor, or Manager govern domain operations server-side; the shared visibility policy tests only
effective membership in one of the declared groups.

A Server Add-on never evaluates any of this itself. It declares `@phis/server/authorization:v1` and
receives a bound evaluator on its request context, which answers whether the acting user may act on one
of its rows, what level they hold in a group, and whether they hold a Site access. The evaluator answers
and grants nothing: it is the consulting surface for this document, not a second place where the model
is decided. See [SERVER_ADDONS.md](./SERVER_ADDONS.md), section 13.

## 2. Runtime authorization snapshot

The authenticated viewer response exposes compact role claims, not expanded role names or permission
lists:

```ts
type PhiViewerAuthorization = {
  authenticated: boolean;
  roleClaims: readonly PhiViewerRoleClaim[];
  groupClaims: readonly PhiViewerGroupClaim[];
  authorizationRevision: number;
};
```

`authorizationRevision` changes whenever an effective Site membership, provider role assignment, or
group membership changes. It is part of authorization-sensitive cache identity. Runtime snapshots carry
only compact stable group keys; expanded group labels, descriptions, member lists, and domain metadata
remain in dedicated authorized endpoints.

`resolvedArea` is a separately derived landing preference. It does not authorize or prohibit Area
access. Area access is evaluated through the same access policy as every other contribution.

The `admin` Area is the shared Site control-plane host for Core Admin and Developer viewers. Core
Developer therefore resolves to `/admin`, while user/role/Site administration remains protected by
Core-Admin-only contribution policies. Observability and developer tooling use the Core Developer
policy and are also accessible to Core Admin through the Site-superuser override. There is no
separate `dev` Area or `/dev` compatibility route in v1.

Role catalogs, labels, and descriptions are loaded only by role-administration surfaces. They are not
included in every viewer runtime response.

## 3. Shared access policy

Server routes, CMS Pages, Areas, Navigation contributions, renderable artifacts, and API guards use one
policy shape:

```ts
type PhiViewerAccessPolicy =
  | { access: "anyone" }
  | { access: "anonymous" }
  | { access: "authenticated" }
  | {
      access: "roles";
      providerId: PhiRoleProviderId;
      allowedRoleFlags: number;
    }
  | {
      access: "groups";
      providerId: PhiGroupProviderId;
      allowedGroupKeys: readonly string[];
    };
```

Combined `allowedRoleFlags` always means OR: the viewer needs at least one listed role. The v1 policy
does not define `allFlags`, deny flags, arbitrary boolean policy trees, or implicit per-feature
permission lists. Combined `allowedGroupKeys` also means OR and must contain at least one valid stable
key.

Evaluation is:

1. `anyone` always allows.
2. `anonymous` allows only an unauthenticated viewer.
3. `authenticated` allows any authenticated viewer.
4. `roles` requires authentication and a matching provider claim.
5. `groups` requires authentication and a matching effective provider group claim.
6. For `roles` or `groups`, a viewer with the Core `Admin` role is allowed before provider-specific
   matching.

The Core Admin override is a normative Site-superuser rule. It applies to every Site-scoped Core or
Add-on role or group policy, but it does not:

- satisfy `anonymous`;
- make an unavailable Server capability available;
- enable a disabled, missing, incompatible, or misconfigured Add-on;
- bypass an external provider's own authorization;
- grant global operator, infrastructure, or cross-Site authority.

A factual helper that asks whether a claim contains a role must not apply the Admin override. Only the
access-policy evaluator applies it. The same rule applies to factual group-membership helpers.

## 4. Core role matrix

Core keeps stable individual role flags such as Admin, Developer, Builder, Author, Publisher,
Supporter, and Accountant. Reusable access groups are centrally declared masks, not separate
permissions:

```text
Site administration  = Admin only
Developer tools      = Developer
Structure authoring  = Developer | Builder
Content editing      = Developer | Author | Publisher
Publishing           = Developer | Publisher
Support              = Developer | Supporter
Accounting           = Developer | Accountant
```

Core Admin is intentionally omitted from reusable masks because the evaluator grants the Site-admin
override centrally.

Site groups are not roles and follow their own split: creating or deleting a group, and granting or
revoking the Manager level inside one, is `Developer | Admin`, while a group's Manager administers the
Author, Editor and Member levels of their own group. Group membership never confers any Core role. The
full table is in [GROUPS_AND_STORAGE.md](./GROUPS_AND_STORAGE.md).

Only Core Admin may assign or remove Site user role claims. A Developer may receive provider roles such
as an Add-on's `Admin` or `Maintainer` role, but those roles grant authority only inside that provider
and never grant Core user or role administration.

## 5. Add-on role declarations

An Add-on may declare a provider-local role catalog in its Add-on manifest:

```ts
roles: [
  { key: "maintainer", flag: 1 << 0, label: "Maintainer" },
  { key: "triage", flag: 1 << 1, label: "Triage" },
]
```

Role keys and flags are immutable ABI identities for a published provider version. `@phis/server`
validates that:

- every flag is a single positive supported bit;
- keys and flags are unique within the provider;
- assigned flags are a subset of the active provider catalog;
- an Add-on resolves or mutates only its own claim namespace;
- only `@phis/server` constructs the Core claim.

A Site Module may always reference Core roles. It may additionally reference roles of its own
`serverBinding.providerId`. Referencing a different third-party provider creates an undeclared second
dependency and is invalid.

The Core provider is universal and does not count as a second Add-on binding.

## 6. Site-scoped persistence

Core and Add-on role claims use one persistence path:

```text
user_site_role_claims
├── site_id
├── user_id
├── provider_id
└── role_flags
```

The primary key is `(site_id, user_id, provider_id)`. The row references the Site membership and is
deleted with it. `role_flags` is an `INT`; each provider therefore owns its own bounded positive flag
space.

The Core role assignment is the row whose provider is `@phis/server/core`. The target v1 schema
does not keep `base_role_flags` or `custom_role_flags` as parallel effective-authorization columns.

A zero assignment is represented by deleting the provider row, except that runtime resolution still
materializes the authenticated viewer's effective Core claim with zero flags.

Provider claims are written only through an authorized generic `@phis/server` role-assignment service.
Site Modules and Add-ons never write authorization tables directly.

Provider-qualified group claims use the one normalized `site_groups` and `site_group_members` path from
`GROUPS_AND_STORAGE.md`. Group membership writers increment the same Site membership
`authorization_revision`; Modules and Add-ons never maintain an independent effective-membership table.

## 7. Custom Site roles

A Site-defined custom role is a named administrative bundle that expands server-side into registered
provider role flags. It is not another global numeric flag namespace.

The viewer runtime receives only the resulting effective provider claims. Custom-role ids may be
returned by dedicated user/role administration endpoints, but authorization never branches between
Base Roles and Custom Roles.

## 8. Provider lifecycle

Disabling an Add-on preserves its persisted user claim rows but omits those claims from effective viewer
authorization. Re-enabling a compatible provider restores them.

The same lifecycle applies to provider-owned group claims. Core-owned groups remain effective when an
optional Groups administration Module is disabled because that Module is UI, not the security
authority.

Unknown or removed role bits make the provider claim diagnostically incompatible. They must not be
silently masked into a partially valid assignment.

Claim effectiveness requires the same provider state used by Server capability resolution: compiled,
registered, globally enabled, Site-enabled, compatible, and correctly configured.

## 9. Enforcement

One pure evaluator implements this policy contract and is shared by:

- Site Area and Page access;
- active route resolution;
- Navigation projection;
- server-rendered artifact filtering;
- Site API guards;
- client display helpers.

Client evaluation is presentation only. Route resolution and every state-changing or protected read API
must enforce the same policy server-side.

CMS write validation accepts the same canonical policy object in Region, Layout, Surface, and Widget
render-block config and in Command Toolbar button config. An explicitly present malformed policy makes
the write invalid; it is never normalized to public access. Module artifact minima and provider
ownership are resolved by the compiled `@phis/ui` Module catalog, while `@phis/server` remains
the authority for claims and protected API operations.

Role-specific convenience guards may exist, but they must delegate to the shared policy evaluator and
must not reproduce independent `allowAdmin`, `allowDeveloper`, or similar decision logic.

## 10. Responsive visibility

Viewport visibility is not authorization. `@phis/server` may persist the shared viewport flag matrix, but
it must never use viewport or user-agent detection to grant API, Area, Page, or role access. The
normative display policy and inheritance rules live in `@phis/ui`.
