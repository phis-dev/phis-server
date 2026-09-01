# User and Group Directory Provider Contract

This document defines the normative target-v1 extension boundary that allows Site user and group
administration to use local Core data in v1 and LDAP, Active Directory, SCIM, Entra ID, or another
Directory Provider later without changing the public Users/Groups ABI.

The first v1 implementation is local only. It must nevertheless use the same provider-neutral Core
facade, stable Phi identities, operation capabilities, and membership provenance required by future
providers. Implementing an external Directory Provider is deferred work; defining a second Users or
Groups API is forbidden.

Authentication and account linking remain governed by [AUTHENTICATION.md](./AUTHENTICATION.md).
Viewer claims and access evaluation remain governed by [AUTHORIZATION.md](./AUTHORIZATION.md). General
groups and Group Media Spaces remain governed by
[GROUPS_AND_STORAGE.md](./GROUPS_AND_STORAGE.md). Provider loading remains governed by
[SERVER_ADDONS.md](./SERVER_ADDONS.md).

## 1. Permanent Core facade

Core always exposes the provider-neutral Site user administration and `groups:v1` services. At minimum,
the Groups HTTP family is rooted at:

```text
/api/v1/groups/*
```

The corresponding Core capability is:

```text
@phis/server/groups:v1
```

The v1 implementation uses the local provider `@phis/server/core`. A future Directory Add-on
registers an internal provider implementation but does not replace the Core route, publish ordinary
Module-facing `/ldap/*` or `/entra/*` management routes, or require the UI to recognize a provider
package.

Every normal command follows:

```text
Users/Groups UI
        ↓
Core Users/Groups route and authorization
        ↓
provider-neutral Core domain service
        ↓
Local repository or one declared Directory Provider
```

Add-on webhook, SCIM-ingress, OAuth callback, and provider setup routes may exist in the Add-on's normal
scoped namespace. They are transport inputs to reconciliation, not another Site administration API.

## 2. Stable Phi identities

Phi identity remains authoritative across provider changes:

```text
Phi User identity   = positive global user_accounts.id
Phi Group identity  = positive Site-scoped site_groups.id plus stable Phi group key
External identity   = opaque provider/connection/subject binding
```

Pages, Navigation, Media Spaces, tickets, orders, CMS content, and access policies reference Phi
identities. They never persist an LDAP DN, Active Directory object path, SCIM resource id, Entra Object
ID, email address, display label, or provider search result as their own identity.

Provider subjects are opaque to Core and Clients. A Provider may internally use LDAP `entryUUID`, Active
Directory `objectGUID`, SCIM `id`, Entra Object ID, or another immutable subject. Mutable DNs, paths,
usernames, email addresses, and display names are not stable subjects.

A Directory change or replacement therefore updates bindings and assertions without remapping Phi user
or group ids.

## 3. Directory connections and bindings

One Site may have zero, one, or several configured Directory connections. A connection is identified by
one package-qualified Provider id plus a stable Site-local connection key. Secrets remain in the Add-on
secret namespace; ordinary database configuration contains only validated non-secret settings and an
opaque secret reference.

User and group bindings conceptually contain:

```text
site_id
phi user or group id
provider_id
connection_key
external_subject
status
provider_revision nullable
last_observed_at
```

`(site_id, provider_id, connection_key, external_subject)` is unique for each resource kind. A Phi user
or group may have several bindings. There is no single global `active directory` switch and no provider
column on `user_accounts` that turns one external directory into the global identity authority.

External groups normally bind to stable Phi groups. A discovered external group may create a new Phi
group through the authorized reconciliation service, but subsequent provider renames update display
metadata rather than changing the Phi group key. Several external group bindings may contribute to one
Phi group so a Site can replace or combine directories without rewriting resource policies.

## 4. Membership assertions and provenance

The membership persistence path is source-aware from v1. One effective membership may be asserted by
local administration and by several Directory sources at the same time. Its durable source rows include:

```text
group_id
user_id
source_provider_id
source_connection_key
source_binding_or_assertion_key
membership_flags
valid_until nullable
provider_revision nullable
timestamps
```

The effective membership is the union of currently effective assertions. Removing or disabling one
source removes only that source's contribution. A local assertion remains effective when LDAP is
disabled; an LDAP assertion remains independent from a SCIM assertion.

Core validates cumulative Member, Author, Editor, and Manager semantics after aggregation. It increments
the affected user's `authorization_revision` only when effective authorization changes, not merely
because a provider repeated the same assertion.

A source contributes at most Editor. The Manager level is local only, and no provider mapping --
an AD `managedBy`, a naming convention, an owner relation -- may assert it. Directories have no
equivalent of the cumulative Member/Author/Editor/Manager ladder in the first place: LDAP and AD groups
have members and nothing else, SCIM carries `members`. Letting a source assert Manager would also make
the level unrevocable locally, because provider-managed assertions are not locally editable, and
[GROUPS_AND_STORAGE.md](./GROUPS_AND_STORAGE.md) reserves granting and revoking it to Developer and
Admin. A Site whose memberships come from a Directory therefore has its Editors and Managers named
locally, as a second source row beside the asserted one.

Provider-managed assertions are not locally editable. The Core route returns their provenance and
operation capabilities so UI can explain why an effective membership exists. Manual deny rows and
Client-side suppression are not v1 conflict-resolution mechanisms; an administrator changes the source
binding or its provider policy instead.

## 5. Provider-neutral resource capabilities

Core API projections never imply that a user, group, field, or membership is locally writable. Each
managed resource returns server-resolved authority metadata and operation capabilities, conceptually:

```text
authority.providerId
authority.connectionKey nullable
provenance
capabilities
```

The common operation catalog covers at least reading, updating, disabling, deleting, adding/removing
members, and changing provider bindings. Core computes the effective set from Site authorization,
resource ownership, Provider capability, connection policy, and current Provider health. A Client may
hide or disable controls from this projection, but the server repeats every check.

The local Core provider supports the approved local operations. A read-only LDAP connection may expose
search and synchronization but reject writeback. A later provider may support selected writes. UI code
must not branch on `providerId`; it composes ordinary Phi Controls from the returned capabilities.

## 6. User attributes and account linking

Directory attributes are provider snapshots, not unrestricted writes to global `user_accounts`. A
connection maps an approved subset such as display name, given name, family name, language, department,
or email into the Site user projection. Each mapped field has one declared authority:

```text
local       = Phi remains authoritative
provider    = Provider is authoritative and normal Phi editing is read-only
writeback   = Core may dispatch an authorized update through a capable Provider
```

Only `local` is required for the first v1 implementation. Returning field authority and operation
capabilities from the beginning prevents later UI and API changes when provider-owned fields arrive.

An external Directory subject maps to an existing global Phi user only through an authorized directory
link. Automatic provisioning may create a new global user and Site membership only when Site policy
allows it. Email equality alone is not stable identity evidence and must not silently link a privileged
account. Authentication identities, password checks, MFA, passkeys, and sessions remain separate even
when the same Add-on can also act as an authentication provider.

## 7. Materialized authorization projection

Normal Page, Navigation, API, and Asset authorization never performs a live LDAP, Graph, or SCIM query.
It reads a compact local projection of only the users, group bindings, and membership assertions relevant
to the Site. This is not a requirement to copy the complete enterprise directory.

Directory connections minimize scope through:

- configured search bases, tenant scopes, filters, mapped groups, and selected attributes;
- users already linked to the Site or reachable through mapped groups;
- provider paging and bounded batch sizes;
- incremental cursors or change tokens;
- push/webhook reconciliation where the Provider supports it;
- expiry of temporary or session-derived assertions.

Preferred synchronization order is:

1. provider push or webhook such as SCIM events;
2. provider delta/change feed such as directory change tokens;
3. incremental queries using stable cursors or change markers;
4. infrequent full reconciliation of the configured Site subset, never an unscoped company-wide scan by
   default.

A direct provider query is permitted for an authorized administrative search/import interaction,
connection test, initial binding, or explicit repair. Results are paginated, rate-limited, minimally
attributed, and returned through the Core facade. They do not become authorization facts until Core
validates and commits the corresponding binding/assertion. Direct provider lookup is therefore a useful
tool, but not the per-request authorization path.

## 8. Reconciliation and failure behavior

Synchronization builds a validated change set before activating it. A partial page, timeout, invalid
cursor, or failed provider request must not be interpreted as deletion of every unseen user or member.
A completed reconciliation atomically applies effective changes and increments authorization revisions
for affected users.

Connections record last successful cursor/revision, last completed time, health, and a bounded
`maxStaleness`. Failure behavior is:

- an explicitly disabled, removed, incompatible, or misconfigured Add-on makes its assertions
  ineffective immediately;
- a transient remote outage may retain the last completed projection only until `maxStaleness`;
- after that bound, the connection's assertions fail closed;
- local assertions and assertions from other healthy sources remain effective;
- recovery with the same external subject reuses the existing binding and Phi identity.

Nested groups are resolved by the Provider or reconciliation service with explicit depth, entry-count,
cycle, and timeout limits. Core stores the resulting effective assertions and does not recursively query
the external Directory during viewer requests. Core groups are flat and carry no edges of their own; the
reasoning, and the shape any future nesting has to take, is in
[GROUPS_AND_STORAGE.md](./GROUPS_AND_STORAGE.md).

A flattened membership still says where it came from. `source_binding_or_assertion_key` names the
Directory group that actually asserted it, not the group the row hangs on, so a nested membership stays
explainable without Core holding the hierarchy.

The stable group key is the source's stable identifier -- `objectGUID` or `SID` for AD, the equivalent
immutable id elsewhere -- never a DN or display name. Directory groups get renamed and moved; a key
derived from a name would drop the group out of every access policy that references it.

## 9. Add-on service boundary

A future Directory Add-on uses the static server Add-on registry and implements the Core-owned service
kind:

```text
@phis/server/directory-provider:v1
```

Its manifest declares one provider key, interface digest, factory, required Core capabilities, jobs,
and any scoped ingress/setup routes. The server-only provider contract may support connection testing,
search, paged/delta reads, reconciliation, health, and optional writeback. It calls approved Core Users
and Groups reconciliation services and never writes Core authorization tables directly.

Examples of later physical packages are `@phis/ldap-server`, `@phis/scim-server`, and
`@phis/entra-server`. Their SDKs and protocol clients remain server-only and never enter
`@phis/ui`, `@phis/groups`, a Site package, or a browser bundle.

## 10. Package and priority boundary

The local `groups:v1` Core route, provider-ready projection, provenance-aware membership model, stable
identities, and operation capabilities are v1/P0 foundations. They do not require a Groups Module or
Directory Add-on.

The first-party Groups administration UI is a separate P2 package, `@phis/groups`, installed and
activated through `phis-cli`. It binds to the Core `groups:v1` capability and contains its own Module
presets, Providers, Controllers, Forms, labels, and Admin/App paths. None of that feature UI belongs in
`@phis/ui`.

Actual LDAP, Active Directory, SCIM, Entra, or other Directory Provider Add-ons are P2 implementations.
Adding one must not change the Core route family, Phi identities, access-policy shape, group references,
Media Space ownership, or generic Groups UI binding.

## 11. Contract governance

Changing, extending, replacing, reinterpreting, or bypassing this contract requires explicit prior
operator approval. Provider-specific Site management routes, raw Directory subjects in resource
policies, synchronous per-request Directory authorization, email-only automatic linking, direct Add-on
SQL writes, unbounded full-directory replication, and UI branches on provider package ids are forbidden
parallel contracts.
