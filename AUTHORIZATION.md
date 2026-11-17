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
Who drafts, submits and publishes content -- Widget content apart from structure, and the content types
-- is set out in [CONTENT.md](./CONTENT.md#rights). Writing a Site translation is Publishing, because it
is live the moment it is written. Reading a Page list of an Area (`GET /api/site/cms/pages`) is open to
everybody who writes for the Site -- `Developer | Builder | Author | Publisher` -- because a link is picked
from it; changing a Page's path stays Structure authoring.
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

An account is global: one address, one password, one profile across every Site it belongs to. A Site
Admin changes those only while the account belongs to their Site alone. Once other Sites share it, the
Admin changes what is the Site's own -- membership, Core roles, enabled state -- and the write methods
refuse a new address, name or password reset with `409 account_shared`. Creating a user whose address
already has an account on another Site adds a membership and leaves the account untouched; deleting a
shared account removes only this Site's membership.

## 5. Add-on roles

The implemented v1 Payment contract adds profile/operation grants and merchant-action policies
in [PAYMENTS_STRIPE.md](./PAYMENTS_STRIPE.md#2-merchant-administration-and-grants). Capture, cancel
and refund require both a grant for the consuming Add-on and operator/Site Admin authority, a listed
role of that consumer, or an explicitly listed consumer job/event context. An internal proxy token
or external hook never grants merchant authority. Customer completion retains consumer-enforced
business-resource access and cannot capture a manual authorization. These Payment checks use existing Core roles and Site access masks. A bound job/event id is checked
against that consumer's declaration and policy; generic system authority does not grant merchant
actions.

An Add-on declares named roles in its manifest, each with the policy that decides who may grant it
(`PhisAddonRoleDescriptor` in `@phis/contracts/addon`):

```ts
roles: [
  { name: "market-admin", grantableBy: { siteAccess: "site-admin" }, includes: ["vendor"] },
  { name: "vendor",       grantableBy: { role: "market-admin" } },
]
```

- A role name matches `^[a-z][a-z0-9-]{0,63}$` and is frozen from the first assignment.
- `grantableBy` is either `{ siteAccess }`, one of the Site accesses in section 4, or `{ role }`, another
  role of the same Add-on.
- At least one role must be grantable by a Site access; a set in which every role is granted by another
  role is refused at validation.
- A Site Admin may always grant and revoke any role of any Add-on.
- A Site Admin also **holds** every declared role of every Add-on enabled for the Site, with no stored
  assignment, for as long as they are Site Admin there (an enabled membership with the Core `admin` role;
  an admin of another Site holds nothing here). Taking a role from a Site Admin makes no sense, so none is
  needed.
- `includes` names other roles of the same Add-on that holding this one implies, followed transitively.
  Every check below answers yes for an implied role. Only the granted role is stored; an inclusion may
  not name the role itself or form a cycle.

Assignments are stored in `phis.site_addon_user_roles` (`site_id`, `addon_id`, `user_id`, `role`,
`granted_by_user_id`, `granted_at`), written by `POST`/`DELETE /api/site/addon-roles` after `grantableBy`
is evaluated against the acting user, and by `phis addon role --grant`/`--revoke` for the operator.
Add-ons never write this table.

*Holding* and *stored* are two things. Every check that asks whether the actor holds a role -- `roles:v1`,
`requiresRole`/`alsoAllowedByRole` on a query, a slot's `requiresRole`, the viewer's `addonRoleClaims` -- is
answered by one rule (`resolvePhisAddonHeldRoles`, `src/lib/addons/role-inclusion.ts`): a Site Admin holds all
declared roles, anybody else the stored ones and what they include. The stored assignments stay what they are:
user administration shows them as stored, and writing one for a Site Admin is allowed and takes effect once
that person is no longer Site Admin. Whatever *resolves recipients* -- "everybody who holds role X" -- must
read the stored assignments, not the rule, so that a Site Admin is not addressed by every role's mail or
assignment. Core resolves no such list today; the only reads of everybody with a role are the user-list
filter (below, which answers "who holds") and `phis addon role --user` (which prints what is stored).

User administration reads and writes them through four calls, all Site-scoped:

- `GET /api/site/addon-roles` answers `{ addons: [{ addonId, title, roles: [{ name, description?,
  grantableBy, includes?, grantable }] }] }`: every declared role of every Add-on enabled for the Site, and
  per role whether the caller may grant it (the evaluation that decides the write). `title` is the Add-on id
  until the manifest carries a display name. With `?userId=N` it adds `userId`, `held` (the stored
  assignments of that user across Add-ons) and `holdsAll` (true when that user is Site Admin and so holds every
  role whatever is stored); that needs at least one grantable role, else 403.
- `PUT /api/site/addon-roles` with `{ userId, addonId, roles }` sets the stored roles of that user for that
  Add-on to exactly `roles`. Core takes the difference to what is held, checks the caller's standing for each
  role to give and each role to take back, and writes all of it or nothing; one refusal answers 403
  `{ error: "not_permitted", role }`. The authorization revision of the membership moves once. A stored role the
  manifest no longer declares is left untouched. The answer has the shape of `GET ?userId=`. Nothing is refused or altered because the person is Site
  Admin: the stored roles are written as asked, `held` shows them and `holdsAll` stays true.
- `GET /api/site/admin/users` (Site Admin) lists per user `addonRoles: [{ addonId, role }]`, the stored
  assignments, not those implied through `includes`, for Add-ons that are installed, enabled and available
  on the Site and whose current manifest still declares the role (the rule behind the viewer's
  `addonRoleClaims`). `?addonId=` keeps users with at least one such stored role of that Add-on, and
  every enabled Site Admin; `?addonId=&addonRole=` keeps users who hold the role stored or through `includes`
  of a stored role, and every enabled Site Admin (when the Add-on declares the role). A row shows a Site
  Admin as `roleTags` containing `"admin"` (with `enabled`); its `addonRoles` stay the stored ones. An
  unknown or unavailable Add-on or an undeclared role gives an empty list; a malformed value 400.
  `?userId=N` (the one-user read a dialog pre-fills from) carries `addonRoles` in its `user` as a flat list of
  `"<addonId>:<role>"` strings, one per role.
- `PUT /api/site/admin/users` (Site Admin) takes an optional `addonRoles`: the stored Add-on roles the person
  is to hold afterwards, over every Add-on enabled for the Site, as one flat list of `"<addonId>:<role>"`
  strings, one entry per role (the value the user-management options Provider gives each role; split at the
  last colon; one Add-on may appear several times, e.g. `["@phis/shop:manager", "@phis/shop:editor"]`). The
  object form `{ addonId, role }` is not accepted: an entry that is not a string is a 400. Absent leaves the Add-on
  roles as they are; `[]` takes every role of every enabled Add-on back. Core takes the difference per Add-on
  to the stored roles, checks the caller's standing for each role to give and each role to take back (the
  evaluation `PUT /api/site/addon-roles` uses), and writes the person and the roles in one transaction: any
  refusal or failure stores nothing of the save. Refusals are `{ error, addonId, role }`: 404 `addon_unknown`
  (not installed or not enabled for the Site), 404 `role_undeclared`, 404 `user_not_member`, 403
  `not_permitted`; a malformed list is 400. Stored roles of an Add-on the Site does not run, or that the
  manifest no longer declares, are left as they are. The authorization revision moves once for the Add-on
  roles of one save. The answer carries `addonRoles` in the same string form.

Core does not forbid giving or taking an Add-on role from oneself (the caller's standing is the only
check, and a Site Admin may set their own Add-on roles through either call); only the Core roles of one's
own membership are refused in `PUT /api/site/admin/users`.

Add-on roles are checked in three places, all against the roles the current manifest declares, granted
or implied through `includes`, and held by every Site Admin:

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

- Site **Area** access;
- Navigation projection;
- server-rendered artifact filtering;
- Site API guards;
- client display helpers.

**Not for route resolution, and not per Page.** An Area decides who may enter it; inside one, every
viewer it admitted reaches the same addresses. A route that resolved differently per reader made the
compiled route table, a stored Page reference and the Area's own front door three answers instead of
one, and it protected nothing: a script asks an API, never a Page. A Module that must not show a given
person what its Page holds returns a different tree, and refuses the matching operations here.
`@phis/ui` ACCESS.md section 5 states the same rule from the rendering side.

Client evaluation is presentation only. Every state-changing or protected read API must enforce this
policy server-side; that enforcement is the boundary, and it is the only one.

CMS write validation (`src/lib/cms/write-validation.ts`) checks the policy object in render-block config,
in Command Toolbar button config, and in a Page's `accessPolicy`. A stored Page policy is validated and
persisted but no longer decides whether the Page is routed -- see above; what it may still narrow is an
artifact inside it. An explicitly present malformed policy
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
