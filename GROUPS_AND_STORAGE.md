# Site Groups, Media Spaces, and Storage Provider Contract

This document defines the normative target-v1 contract for Site-scoped groups, Media ownership,
folders, quotas, binary Storage Providers, and protected Asset delivery in `phi-server`. The Asset
Collection, Picker, Inspector, and CMS reference projections in `@phis/ui` consume this
contract; they must not define another ownership, authorization, or Storage model.

Authentication and global user identity are governed by [AUTHENTICATION.md](./AUTHENTICATION.md).
Roles, group claims, and shared resource visibility are governed by
[AUTHORIZATION.md](./AUTHORIZATION.md). Server extension loading and Storage Provider factories are
governed by [SERVER_ADDONS.md](./SERVER_ADDONS.md). Stable CMS Asset references are governed by
[REFERENCES.md](./REFERENCES.md). Local and future external user/group Directory providers are governed
by [DIRECTORY_PROVIDERS.md](./DIRECTORY_PROVIDERS.md).

This target is a v1 ABI break. The existing `media_groups` folder vocabulary, ambiguous Asset
`user_id`, global `local | s3` switch, persisted public URL, and Storage-key delivery path must not
remain as compatibility alternatives.

## 1. Separation of concerns

The following concepts are independent:

- a Site role describes which Site capability a viewer may exercise;
- a Site group describes which audience or collaborative domain a viewer belongs to;
- a Media Space owns one isolated collection of folders and Assets;
- a Media Folder organizes Assets inside one Space and never represents membership;
- a Storage Profile binds an Asset to one physical Storage Provider and configuration;
- an Asset delivery policy determines who may read its binary representation.

Roles must not be inferred from groups. Group membership must not grant Site administration, Builder,
publishing, support, or accounting authority. A Storage Provider must not decide application-level
viewer authorization.

## 2. General Site groups

Core owns normalized Site group persistence and authorization projection:

```text
site_groups
├── id
├── site_id
├── provider_id
├── key
├── name
├── flags
├── created_at
└── updated_at

site_group_members
├── group_id
├── user_id
├── source_provider_id
├── source_connection_key
├── source_binding_or_assertion_key
├── membership_flags
├── valid_until
├── created_at
└── updated_at
```

`(site_id, provider_id, key)` is unique and stable. A group id is an internal relational identity;
serialized access policies use the provider-qualified stable key. A member must have a matching
`user_site_memberships` row. Cross-Site memberships are invalid.

Core membership flags have these cumulative meanings:

```text
Member   = may discover and read group resources
Author   = may create, and may update and delete what they created
Editor   = may update what anyone created
Manager  = may delete what anyone created, and administers membership
```

Assignment validation enforces `Manager => Editor => Author => Member`; a higher level cannot exist
without the lower effective levels. Numeric bit assignments are centralized with the other Core
constants and must not be repeated by Modules.

`Author` is a narrowing of `Editor`, not something beside it: "may edit only their own" is the same
right with a smaller reach, so it sits below on the same ladder. Two consequences follow from the
ordering rather than from a separate decision. An Editor inherits deleting their own work, so deletion
is no longer wholly a Manager matter -- what still needs a Manager is deleting *someone else's*. And
"their own" needs the resource to say who owns it, and ownership is not authorship: `media_assets` carries
`owner_user_id` beside `created_by_user_id`, and an Add-on table states `ownerScoped` so Core adds and
answers for the same column (see [SERVER_ADDONS.md](./SERVER_ADDONS.md), section 15). A row whose owner is
null belongs to nobody, and no level reaches it through ownership.

The membership path is assertion- and provenance-aware from v1. Local Core membership and later LDAP,
SCIM, Entra, or other Directory assertions may contribute independently to one effective membership.
The effective flags are the union of active source rows; removing one source must not remove another
source's contribution. Exact provider bindings, synchronization, expiry, and account-linking behavior
follow `DIRECTORY_PROVIDERS.md`.

Provider-owned group kinds may add provider-local metadata, but they use the same Core membership and
authorization path. They must not create another effective group table or Client-only evaluator.

Changing effective group membership increments the affected user's Site
`authorization_revision`. Group claim caches are keyed by `(site_id, user_id,
authorization_revision)` and must not survive a revision change.

### Groups are flat, deliberately

A group has members; it has no parent and no children. Nesting exists in Directories and is resolved
before Core sees it: a Provider or the reconciliation service flattens it under explicit depth,
entry-count, cycle, and timeout limits, and Core stores the resulting effective assertions. Provenance
survives that flattening -- `source_binding_or_assertion_key` names the group a membership actually came
from, so "member through Dev-Team-Zurich" stays answerable while the stored row hangs on the outer group.

Staying flat now costs nothing later, because the shape that would be expensive to change is the
projection, not the storage. An effective membership is a flat set of stable, provider-qualified keys,
persisted access policies compare against that set, and the read path never resolves recursively. A
derived membership enters that set exactly like a direct one, so nesting can be introduced without
touching a single stored policy.

What is decided now is only the shape nesting must take when it arrives, because getting it wrong is
what would be expensive:

- it is a directed graph, never a tree. A Directory group can be a member of several groups at once, so
  a single `parent_id` on `site_groups` cannot express it and must not be added;
- the relation reads "B is a member of A", and its effect runs upward: B's users become effective
  members of A. A field named `parent` invites the opposite reading;
- an edge carries its own level and never forwards the child's, or a Manager of a small group would
  become a Manager of the group it is embedded in;
- an edge, like any source assertion, contributes at most Editor;
- the effective membership stays flat and materialized whoever resolves it, so the read path is
  unaffected either way.

Core stores no group edges until a case needs them -- local nesting, or a connector that should hand
over edges instead of finished memberships. An edge table nobody writes to only ages against the code
that will eventually need it.

### A Module may bring a group

A Module that needs a shared place for its own domain -- accounting for receipts and invoices, support
for incident attachments -- seeds an ordinary Core group when it is set up, and may set that group's
quota override once as a starting value. It is a preset, not a second kind of group: provider-owned
group kinds "must not create another effective group table or Client-only evaluator", and the group
outlives the Module exactly as group data outlives `@phis/groups`.

A Module declares which Space kinds it needs and seeds what it owns. It does not switch availability on
and it does not become a layer in quota resolution; both are covered in section 7.

Core owns persistence, the provider-neutral `groups:v1` route, the local provider, and enforcement
because Pages, Navigation, Assets, and independent Modules may depend on group visibility. The optional
P2 `@phis/groups` package contributes administration UI, presets, Controllers, and Providers; none of
that feature UI belongs in `@phis/ui`. Disabling the package does not disable Core group
enforcement or erase data.

### Who sees a group's members

Membership is what grants it: someone in a group sees who else is in it. Work is assigned to a person
as readily as to a team, so a list only Managers could read would put every future "assign this to
someone" behind an authority nobody needs for it.

What a member sees of the others is narrower than what administration sees. A colleague is recognized
by name, so name and level are shown and the address is not -- an assignment needs the address on the
server, not in the hands of whoever picks. The company sits in between: unremarkable in one team,
telling in a group where people from several companies work together. That is a judgement only the
group's Manager can make, so it is theirs: `site_groups.flags` carries `ShowMemberCompany`, off by
default, and when it is off the field is absent from the answer rather than hidden in the interface.

A Manager finds people to add through `GET /api/site/groups/candidates`, not through the Site's user
list, which stays Developer-only. It is the narrow middle: open to anyone who manages some group,
matched on name or address, capped, and answering with the name and company rather than the address
that may have been searched by. It is deliberately not per group -- the candidates are the Site's
members either way, and a group id would only have dressed an unchanged list as a per-group one.

Those flags are display bits and never rights. Authority lives in the membership level; a right stored
here would mean two places decide the same question, and the second one would be the one nobody
remembers to check.

`/admin/groups` is where a Site administers them, delivered by that Module: the groups with their
member count and Space usage, the members of whichever group is selected, the form that creates one,
and the level of a membership edited in the cell it is read in. A membership a provider contributes is
listed but not editable -- it is read here and changed at its source. Entry is Developer, widened to Admin by the Core override, because creating a group is Site
administration. A group's own Manager administers their group in `app`, where they are when they
notice it needs doing.

A browser session reaches all of it through `/api/site/groups` -- one address for the resource, with
`?scope=site` for every group and the bare route for the ones the actor is in. Those are the same
question asked with a different scope rather than two things, and splitting them once meant the same
membership write lived in two files. `groups:v1` under `/api/v1` stays separate: that is the
provider-neutral capability a Module speaks to, not a session surface. Both end in the same typed
control-plane functions.

The first-party `@phis/ui/groups` Module is the small half that belongs in the shared package
rather than in that one: groups are needed often, the Module is thin enough not to weigh the package
down, and shipping it here is what makes it installable without the CLI. It declares that a Site's
groups need Group Spaces and carries the one form that creates a group -- one declaration, one form
relaying to `groups:v1`, no Controller, `admin` only -- so the rich administration surface still has
somewhere to land. Both can be active: the Module declares and creates, the package administers.

A later external Directory Add-on synchronizes provider assertions through the approved Core service.
When that provider is disabled, missing, incompatible, misconfigured, or stale beyond its configured
bound, its effective assertions are omitted and protected resources fail closed while local and other
healthy source assertions remain effective.

Support teams remain a Support-domain profile because routing, queues, and ticket assignment are not
generic membership properties. Their membership moves to `site_group_members`; the Support profile
references exactly one group and retains only Support-specific state.

## 3. Media Spaces

Every Media Asset belongs to exactly one Media Space:

```text
Site Space   = Site presentation, CMS content, theme, and published download Assets
User Space   = one user's private application data inside one Site
Group Space  = one Site group's shared application data
```

The normalized owner is:

```text
media_spaces
├── id
├── site_id
├── kind                 SMALLINT: Site, User, or Group
├── user_id              nullable
├── group_id             nullable
├── default_storage_profile_id
├── quota_bytes          nullable override
├── used_bytes
├── reserved_bytes
├── flags
├── created_at
└── updated_at
```

The Space kind determines the only valid owner columns:

- Site Space has neither `user_id` nor `group_id` and is unique per Site;
- User Space has exactly one `user_id` and is unique per `(site_id, user_id)`;
- Group Space has exactly one `group_id` and is unique per group.

The Site Space is not represented by a duplicate persisted `site` group. Its management authority is
derived from the Core role matrix. User and Group Spaces may be created lazily on first authorized use.

A Group Space is materialized by the first authorized *write*, which is an Author operation.
Discovery is a Member right and must not create the row: a group appears in the selectable Space list
from its membership alone, and reading it before anything has been written returns an empty Space. So
a group nobody has stored anything in leaves no trace, while everyone entitled to see it does.

No surface deletes a group; retiring one is what ends its service, and the section below is the form.
The foreign key from `media_spaces` to `site_groups` still does not cascade, so a stray delete against
the database fails rather than taking a Space, its folders, and every Asset in it along. The constraint
is `NO ACTION` rather than `RESTRICT` because it is evaluated at the end of the statement, so deleting
a whole Site still cascades through in one go.

### Retiring a group

Retiring a group rather than deleting it is the form, implemented as of 2026-08-25. Nothing deletes a
group; whether a Directory reconciliation may ever remove one stays open and is a Directory question.

- **A retired group keeps its `(site_id, provider_id, key)`.** Access policies are serialized against
  that provider-qualified key. Releasing it would let a new group of the same name inherit every policy
  the old one had, silently and with nothing to notice -- an authorization defect rather than an
  inconvenience. The key stays taken.
- **That costs Directory groups nothing.** Their key is the source's immutable identifier, an AD
  `objectGUID` or `SID`, never a display name. The same group returning carries the same key and finds
  its own retired row, which is what makes reactivation possible at all; a genuinely new group with the
  same display name carries a different key and collides with nothing. Only locally chosen keys can
  collide, and there the answer is to surface the retired group and offer to reactivate it, or to pick
  another key.
- **`site_groups.retired_at` records when.** `updated_at` cannot answer "retired since when", because
  every later edit overwrites it. Reading the state from one timestamp keeps it to a single source;
  `flags` is deliberately left out of it.
- **A retired group grants nothing.** The filter sits in `readEffectiveGroupFlagsWithDb`, the one claim
  projection every authorization decision reads, so the rule holds everywhere at once rather than at
  each caller that remembered it. Its memberships stop contributing, it takes no new members, it leaves
  group and Space selection, and every affected member's `authorization_revision` moves inside the same
  transaction that writes the state -- in one statement, because the group's claim identity comes from
  that row alone and so every member of it is affected without exception.
- **Selection asks for the groups in service.** `GET /api/site/groups` answers with those by default and
  includes retired ones only for `?scope=site&includeRetired=1`. Administration is the one surface that
  asks: the key stays taken, so the place that reports a name collision has to be able to show what is
  holding the name.
- **A Manager retires, Developer and Admin reactivate.** A Manager runs the team and may end it, from
  the App page they run it on. The way back cannot be theirs: retiring removes the very level that would
  authorize it, so requiring Developer or Admin there keeps the way back open instead of making it
  depend on a right the operation itself took away. Reactivation is therefore only offered where retired
  groups are listed at all, which is administration.
- **Its Media Space is not retired with it.** A Space belongs to a group that is retired; it is not
  itself in a state. It stays where it is and comes back with the group.

A Directory going away is a separate case and needs none of this: an unreachable source's assertions
become ineffective while local and other healthy sources remain, and recovery reuses the existing
binding. The group row, its key, and its Space are untouched throughout.

A Directory going away is a different case and is already settled: an unreachable source's assertions
become ineffective while local and other healthy sources remain, and recovery reuses the existing
binding. The group row and its Space are untouched throughout.

An Asset records immutable `created_by_user_id` attribution separately from custody. An uploader is not
the Asset's custodian; the owning Space is. The two are not the same question and the delivery policy
reads the first, not the second -- see section 6. Moving an Asset between Spaces is an explicit transfer
of custody requiring source and destination authorization, quota reservation, reference validation, and,
when required, physical Storage migration.

## 4. Folders

`media_folders` replaces `media_groups`. Each Folder belongs to exactly one Space and may have one
parent Folder in the same Space. `(space_id, parent_id, lower(name))` is unique.

Folder identity is metadata only. Storage keys must not be derived from the mutable Folder path, and
renaming or moving a Folder must not move binary objects. A Folder cannot be moved between Spaces; that
operation is an explicit recursive Space transfer.

Collection and Inspector APIs use `folderId` and `folderPath`. `groupId` and `groupPath` are not retained
as aliases. The server returns only Spaces and Folders visible to the current viewer.

### Addressing a Space

The destination Space travels in the `spaceId` query parameter on every Media route, reads and writes
alike, so there is one parsing rule rather than a query variant and a body variant that can disagree.

```text
<number>      an existing Space, by id
user          the actor's own User Space
group:<id>    a group's Space, whether or not it has a row yet
user:<id>     one user's Space, named by administration on their behalf
```

A number can only ever address a Space that already exists. The three semantic forms exist for the cases
where the row legitimately may not: an actor's first use of their own Space, a group nobody has stored
anything in, and an administrator assigning capacity before anyone has uploaded. A malformed value is
rejected rather than read loosely.

A Space with no row is still listed -- with `id: null` and its `address` -- because discovery is a Member
right that must not create it. The Core Admin override reaches every Space, so an interface that lists
one for a Developer or Admin can also open it.

## 5. Asset persistence

`media_assets` retains its stable positive id and media metadata but uses these authoritative
relationships:

```text
site_id
space_id
folder_id nullable
created_by_user_id nullable
updated_by_user_id nullable
storage_profile_id
storage_key
original_name
content_type
bytes and checksum
dimensions, blur preview, focal metadata, title, and alternative text
lifecycle_status
delivery_policy
delivery_revision
presentation_flags
timestamps
```

`user_id`, `group_id`, string `storage_provider`, repeated bucket fields, and canonical `public_url` are
removed. A private or signed URL is transient and cannot be persisted as Asset identity. Asset id plus
Storage Profile plus Storage key is canonical.

Image variants retain `(asset_id, variant_key)` identity and record their concrete Storage Profile and
Storage key. They do not resolve through the currently configured default Provider. Changing a Space's
default profile affects only future objects until an explicit migration runs.

Lifecycle, delivery, and presentation are separate closed contracts:

- lifecycle includes pending, ready, archived, quarantined, and failed states;
- delivery includes public, authenticated, user, group, and internal access;
- presentation flags include non-security properties such as featured or mask behavior.

The legacy `Private`, `Restricted`, and `Archived` flag mixture must not remain an alternative
authorization path.

## 6. Authorization matrix

Site Space management uses one centrally declared Core Media policy:

```text
create, use, update, and unreferenced delete
= Builder | Author | Publisher | Developer, plus the Core Admin override
```

Supporter and Accountant do not receive Site Media management authority. Public or authenticated
delivery never grants mutation authority.

User Space operations require the authenticated user to own that Space. Group Space reads require
Member and writes require Author. Every protected read and mutation is enforced server-side from the
trusted Site session and current authorization revision. Client visibility is presentation only.

Two gates, not one. The Space answers whether an actor may put something here at all; the Asset answers
whether they may act on *that*. Creating passes the Space gate alone. Reading, updating, and deleting one
existing Asset are decided against its `owner_user_id`: an Author reaches what is theirs, an Editor reaches
what anyone wrote, and removing someone else's stays a Manager act. A User Space needs no owner column for
this -- it belongs to one person by construction and the Space is the answer.

### Owner is not author

`media_assets` carries both, and they mean different things. `created_by_user_id` is history: who brought
the Asset in, unchanging, and the reason a handed-over Asset stays attributable. `owner_user_id` is
authority: who may act on it now. Both start equal and diverge at the first handover.

They have to be separate, or the ladder would be unsafe in the ordinary case. A receipt uploaded against
an invoice would remain its uploader's to delete for as long as the row existed, however far the booking
had progressed. With the handover, the accounting group takes ownership on acceptance, and the uploader --
an Author -- reaches only what is still theirs.

Handing over is its own operation, `PUT /api/site/media/:id/owner`, and its own authority: the owner gives
away what is theirs, an Editor reaches into someone else's ownership, whether that means taking it,
passing it on, or releasing it to nobody. The recipient must already be in the group, because ownership
carries rights and handing it outside would grant across the group boundary rather than inside it.

### The group is the owner when nobody is

There is no group owner column, because the Space already is one: an Asset in a Group Space is the
group's, and `owner_user_id` only says whether some member holds it personally on top of that. A null
owner therefore reads as "the group's, nobody's in particular" -- which is the ordinary destination for
a receipt handed to a case, not merely the residue of a deleted account.

A second column would have been worse than redundant. It could disagree with the Space, and it would
make the owner polymorphic -- person or group -- for every check from then on.

What follows from that shape:

- an Author reaches nothing that is unowned; that is what "given to the group" means for the person who
  gave it;
- an Editor updates it and a Manager deletes it, by level rather than by ownership;
- an Editor may set themselves as owner, and that is a *signal* -- "I am working on this" -- not a
  permission they needed. They could already edit it. Nothing breaks if they never bother.

Site Media authority passes all of this, as it does everywhere here.

Folders remain Space-scoped: they organize a Space rather than belonging to anyone inside it.

### Who administers a group

Creating a group is Site administration, not a group operation: a group is an authorization unit that
Pages, Navigation, and Assets refer to, and group membership must never confer the authority to create
more of them. Administering the members of an existing group is the group's own business and does not
belong to Site administration either, or every membership change would queue behind an Admin.

```text
create or delete a group                      = Developer | Admin
grant or revoke the Manager level             = Developer | Admin
set the Site quota ceiling per Space kind     = Developer | Admin
set Author, Editor and Member levels        = that group's Manager, or Developer | Admin
set that group's Space quota, up to the Site ceiling
                                              = that group's Manager, or Developer | Admin
write in the group's Media Space              = Author
read and discover the group's Media Space     = Member
```

A Manager's write authority ends below their own level: a membership row carrying the Manager bit is
untouchable for them, since the levels are cumulative and both demoting and removing such a row would
be a demotion. A group therefore cannot lose its last Manager from the inside, and only Developer or
Admin can leave one without.

A Manager admits existing Site users only. Every member needs a matching `user_site_memberships` row,
so there is no invitation path through a group. And a Manager administers the local assertion only:
a membership contributed by a Directory source is not locally editable, which means the effective
membership can be raised locally but never cut below what a source asserts.

Asset deletion additionally requires a zero authoritative reference count. CMS reference indexing and
delete diagnostics follow [REFERENCES.md](./REFERENCES.md).

Builder, Editor, and Public CMS resolution use only Site Space Assets. A User or Group Asset cannot be
embedded into published Site content merely because its id is known. Publish validation rejects an Asset
whose delivery audience is narrower than the published Page audience.

### What a Space answers, and what it must not

A Space answers two questions: who pays for these bytes, and who administers them. It must not also
answer who may read them.

Deriving the audience from custody is what breaks the first real case. A submitted receipt belongs in
its accounting group's custody -- a business record has to outlive the account of whoever handed it in,
and must not sit on that person's quota forever. But its audience is not the group: another member of
the same group has no business reading someone's receipt. Today that separation cannot be expressed at
all. Delivery policy `Group` reaches every effective member of the owning group, and policy `User`
additionally demands that the Space itself be a User Space -- so a receipt in group custody marked
`User` would be readable by nobody, not even its submitter.

Two rules keep the axes apart:

- **`User` means the person the file belongs to, not the Space it sits in**: its `created_by_user_id`,
  and the owner of the Space when that Space is a User Space. Custody may then move without the audience
  moving with it.
- **Material a Module mediates is `Internal`**: no browser URL reaches it, and the Module decides on its
  own surface who is shown it, because only the Module knows that this is the handler of invoice 4711.
  Core is not the place where that question can be answered.

A per-Asset audience descriptor -- naming people, groups, or roles independently of both custody and
purpose -- is deliberately not introduced. The two rules above carry every case in sight, and a
descriptor nothing fills would only be a contract to get wrong later.

### Moving an Asset between Spaces

Transfer is a change of custody and nothing else. It does not widen, narrow, or otherwise touch an
Asset's audience: what a transferred Asset was readable by before, it is readable by afterwards.

There is deliberately no generic transfer endpoint: what does not exist as a route cannot be called. The
mechanism is server-internal and reachable only from a Module handler, which has already authorized its
own operation.

The two sides check what each of them knows:

```text
Core     may the actor reach the SOURCE Space?     the ordinary Space authorization
         is the Asset in a usable state?           lifecycle, Space membership
         does it fit the TARGET quota?             the atomic reservation
Module   is the occasion real?                     "invoice 4711 belongs to this user"
```

A client names the occasion, never the target. "A receipt for invoice 4711" leaves the destination to
the Module, which derives it; a request that could name a Space would have bypassed the authorization
before anything was checked.

Submissions are created in the submitter's own Space and only then taken over by the occasion. That is
also what limits abuse without any additional mechanism: whoever floods a group fills their own quota
first, because the file is theirs until the operation accepts it. How many submissions one occasion
accepts is the Module's business -- Core counts bytes, not meaning.

Whether a transfer copies or moves follows from the occasion. A submitter may keep their receipt; a
record taken into custody does not need to stay behind in two places.

The Site Space is not a transfer target. Nothing produces publishable material outside it: Builder and
Editor write into it directly, and CMS resolution reads only from it. A promotion command would be a
crossing without a case, and the case is what would have to define whether it copies, what happens to
the audience, and who may invoke it. When a contributor flow exists that authors publishable material
without Site Space authority, that is when this is decided -- not before.

Every transfer is recorded durably with source, target, actor, occasion, and mode, queryable per Space.
If a group does fill up, that record is what says who put what there, and on what grounds; a rotating
log file cannot answer it.

## 7. Quotas and upload reservations

The Site Media configuration owns default User-Space and Group-Space quotas, allowed content types,
maximum object sizes, and allowed Storage Profiles. A Space-level `quota_bytes` value is an explicit
override; `NULL` inherits the Site default. Per-user administration writes the User Space override and
does not alter global account identity.

The Site configuration additionally owns a maximum per-Space override for each Space kind. A group's
Manager may set that group's `quota_bytes` up to that ceiling; only Developer or Admin may move the
ceiling itself. Without it, delegating capacity would delegate the Site budget: an actor who can raise
their own allowance has no allowance.

### Availability is separate from capacity

Whether a Space kind exists at all is a capability, not a quota, and it is declared by the Modules that
need it. A Module states which Space kinds it requires; the Site's availability is the union of those
declarations across its active Modules.

```text
@phis/ui/groups   requires Group Spaces   general group use -- the one that exists today
@phis/accounting          requires Group Spaces   plus its own group, seeded with a starting quota
@phis/profile             requires User Spaces    an avatar is a User Space Asset
```

One switch, not two. A Site that activates none of them has no User or Group Space, and activating a
Module is the administrative act that grants what the Module needs -- which is the same act an
administrator already performs per Area. Two Modules requiring the same kind do not collide, and
removing one leaves the kind available while the other still declares it.

Being authorized is never sufficient: the lazy creation on first authorized use described in section 3
requires the kind to be available first, and a request that fails this check is rejected as unavailable
rather than as over quota. The two rejections stay distinguishable so an interface can tell "not
enabled" from "quota exceeded" without inspecting quota numbers.

The Site Space is not governed by any declaration. It always exists and is governed by the Core Media
role matrix in section 6. A Group Space additionally requires its group to exist, which is ordinary
Core data rather than a second switch.

A Space kind that stops being available hides its Spaces rather than deleting anything, exactly as a
disabled flag did before. The Assets remain, they keep counting against their quota, and Developer and
Admin must still be able to see that they are there -- the same reasoning that keeps a group with a
Space from being deleted.

A Module declares a need; it never writes the availability itself. `@phis/groups` in particular is
optional administration UI: a Module that seeds its own group speaks to the Core `groups:v1` route and
works without it.

#### How a declaration reaches the control plane

Module definitions live in the shared UI and the control plane holds no Module metadata -- it stores the
active Modules of an Area as opaque ids. The declaration therefore travels with the Area preset, and the
control plane materializes the result rather than re-deriving it:

```text
PhiRuntimeModuleDefinition.mediaSpaceKinds   the Module states its need
└── resolvePhiDeclaredMediaSpaceKinds()      the Builder derives the Area's union when it saves
    preset.config.mediaSpaceKinds            the Area preset carries it, next to runtimeModules
    └── publishing an Area                   the control plane unions every *published* Area
        site_media_config.flags              the materialized result, read at request time
```

`flags` stays a column and stays authoritative at request time, but it stops being a switch: nothing
writes it except this materialization. `PATCH /api/site/admin/media` rejects `userSpacesEnabled` and
`groupSpacesEnabled` instead of accepting them, the installation configuration seeds capacity only, and
a Site that wants a kind activates a Module that needs it.

Publishing is the materializing act because publishing is what changes which Modules the Site actually
runs. A draft therefore never widens a running Site, and the pointer and the availability it implies
move in one transaction so the two are never observable apart. Deactivating the last Module that
declared a kind narrows availability again on the next publish, which hides its Spaces without deleting
anything -- the rule above.

A kind the control plane does not know is ignored rather than rejected: a newer Module must not make an
older control plane refuse a publish, and an undeclared kind is simply unavailable.

### Configuration layers

Default quotas use the same two-layer split the platform already applies to the Site source locale: a
versioned operator-owned installation default, and an effective per-Site value. Availability is not part
of this: it comes from the Module declarations described above.

```text
config/phis-config.json          versioned installation seeds, operator owned
└── media.defaults.*             seeds site_media_config for a newly created Site
    media.storageKeyPrefix       seeds the Local Storage Profile config
    media.local.rootDir          seeds the Local Storage Profile config

site_media_config                the effective per-Site Media policy
└── default_user_quota_bytes
    default_group_quota_bytes
    max_user_quota_bytes
    max_group_quota_bytes

media_storage_profiles.config    the effective Provider configuration
```

Capacity resolves in exactly two steps -- a Space's own override, otherwise the Site default for its
kind -- and a Module never becomes a third. A Module that seeds a group may set that group's override
once, as a starting value, in the same way configuration seeds a row. Afterwards the number belongs to
the Space and to the Site, and the Module does not speak to it again.

The same rule governs both rows: configuration seeds them once at materialization and is never
consulted again at request time. A Provider's configuration belongs to its Profile, so the Local
adapter reads its key prefix and root directory from `media_storage_profiles.config` rather than from a
global switch.

The JSON layer is read exactly once, when a Site's Media configuration row is first materialized. It is
operator-owned and is never written by Site administration, because a Site Admin must not be able to
change instance-level configuration.

After that the row is authoritative and there is no request-time fallback to the JSON layer. Raising an
installation default therefore does not silently widen existing Sites, and a Site that has been
configured keeps its values across releases. The row is also what makes the values correct once a Site
runs on more than one Instance: a JSON file lives on one host, while every Instance reads the same row.

### Resolving an effective quota

`quota_bytes` on a Space is capacity only, and resolution is live rather than a creation-time snapshot:

- `NULL` resolves against the current Site default for that Space kind, so changing the default changes
  every Space that has not been overridden;
- `0` is an explicit administrative revocation of capacity. The Space and its existing Assets remain,
  and remain readable; only new reservations fail;
- a positive value is that Space's own capacity.

Lowering a default or an override below current usage never deletes or hides an Asset. The Space simply
accepts no new reservation until usage falls below the effective quota.

All four kinds ride the same two rails, and the fourth needs them most. An Add-on Space has no owner: no
user whose page shows the figure, no group Manager to notice it filling. If it did not inherit
`default_addon_quota_bytes` it would be the one delegated Space born unlimited, and nothing would say so
until the disk did. The ceiling `max_addon_quota_bytes` is there for the same reason as the other two --
capacity delegated without one is not delegated capacity -- and applies wherever the override is set by
authority short of Developer and Admin.

Setting one is the ordinary Space route, `PATCH /api/site/media/spaces/<id>`, because an Add-on Space is
a Space. What it needs beyond the others is a way to be found: it is deliberately absent from every Space
listing, so `GET /api/site/admin/media` reports the Add-on Spaces a Site holds beside the defaults. What
is *in* them stays the Add-on's business; what they cost is the Site's.

Quota enforcement is transactional:

1. resolve the trusted destination Space and operation policy;
2. validate declared size and reserve it in `reserved_bytes`;
3. create a short-lived upload session bound to Site, Space, actor, Folder, and Storage Profile, and
   record the upload plan the Provider issued for this body;
4. deliver the body the way that plan states, and verify the object;
5. atomically create the Asset, then move reserved bytes to used bytes and close the session in one
   transaction -- while the session row exists its bytes are reserved, while it is gone they are used,
   never both and never neither;
6. release reservations on abort, and on expiry through the next request that reserves against the same
   Space. A reservation only reduces its own Space's headroom, so nobody but the next uploader into
   that Space is waiting for it; a Space nobody uploads into needs no sweep. Staging objects are not
   chased from there: what no request can reach belongs to a bucket lifecycle rule for S3 and to a
   deliberate operator command for Local, to the maintenance contract in `AGENTS.md`.

### When a body stops arriving

The session's expiry bounds a whole upload and is checked before one starts. It is not what catches a
body that stops mid-transfer: that session is valid and that request is open, so without a second
measure Core would hold the request, the connection and the reservation for as long as the network is
willing to pretend the socket is alive.

Two endings hide behind that, and step 4 keeps them apart because they are answered differently:

- **The Client is gone.** The transport says so. There is nobody left to answer, so the reservation is
  released, the torn object removed, and the event recorded at `info` -- a closed tab is the most common
  thing that happens to an upload, and filing it as a Server fault would make it the loudest line in the
  log and bury the faults somebody has to act on. Its rate is what is worth reading, which is why it is
  an event of its own rather than a variant of `media.upload.failed`.
- **The Client is silent.** The connection is open and no byte has arrived for
  `PHI_MEDIA_UPLOAD_STALL_TIMEOUT_MS`. Nothing announces this; the absence of bytes is the only evidence,
  so it is measured -- between two bytes, not across the upload, and armed before the first byte as well,
  since a request that sends nothing at all is the same silence. Recorded at `warn`, because it is also
  the shape a timeout set too tight for an honest slow network takes, and that is a question nobody can
  ask of a log that calls both endings "failed".

Both raise the abort on the read itself and not only on the Adapter's `signal`, which is optional: an
Adapter is entitled to ignore it, and ending the read is what makes the write end regardless of who wrote
the Provider. An Adapter that honours it stops paying for the write as well, which for a remote Provider
is a request in flight.

Nothing about the abort is kept in the session row. The reason is read by whoever is still listening --
the Client that is still there gets it in the response, and the operator gets it in the log. A Client
that has gone reads nothing, and a Client that comes back starts a new upload rather than asking why the
old one ended, so a stored reason would be kept for a reader who never arrives. Deleting the row stays
what makes the release happen exactly once.

### The upload plan

How a body reaches storage is the Provider's to state and the Client's to carry out. `init` answers with
a typed plan, and a generic executor obeys it without knowing which Provider issued it -- before the plan
existed, the rule "one PUT, to a Core route, with the file's content type" lived in the Client as
knowledge, which is true for Local storage and false for any Provider that takes a body directly.

Two kinds exist: `proxy-stream`, where the body streams through Core with the Site session, and
`presigned-put`, where the body goes to the Provider's own endpoint and Site credentials must not travel
with it. The union is meant to grow -- a Provider that needs several requests for one body adds a kind
rather than a second upload lifecycle -- and an executor refuses a kind it does not know instead of
falling back to a transport that would send the body to the wrong place.

Which of the two a Profile may be given is decided by measurement, not by its Provider. `presigned-put`
is only safe where the endpoint checks a declared SHA-256 against the bytes it stores: the digest is then
established by the refusal of anything else, and Core can take the client's figure as true without having
seen a byte. One adapter serves AWS, MinIO and Garage alike and they do not agree, and no field of the
configuration says which is behind it, so the answer comes from a probe recorded against the Profile.

Absent means no, and that makes when the probe runs part of the design rather than an operator's habit.
It runs where a Profile is written -- `storage add` and `storage set`, which replaces the old answer
because it described the endpoint the old configuration reached -- and once, lazily, on the request that
first needs it, for a Profile that reached service through neither: restored from a dump, written by a
migration, configured before the probe existed. A failure is recorded like any other answer and not
retried per request, because an endpoint that is down would otherwise be dialled again by every upload
into it; `phis storage probe` is what tries it again.

### What the digest is worth, and where it stops being one

`checksum_value` never travels without `checksum_algorithm`, and that is the whole design. One column
holding "a checksum" is how an MD5 ends up in a field named for SHA-256: an `ETag` is an HTTP cache
validator that each Provider fills as it likes -- a real SHA-256 for Core's own storage, an MD5 for a
single-request S3 PUT, and a digest of part digests above that, which hashes no bytes anyone uploaded.

A digest reaches the column three ways, and the algorithm is recorded with it every time:

- **The endpoint verified it.** The client stated a digest, the plan signed it into the request, and the
  Provider refused anything that did not match. Trustworthy without Core having seen a byte, because
  what makes it true is the refusal.
- **Core hashed it in flight.** The body came through the proxy plan and Core computed a SHA-256 over
  exactly the bytes it stored.
- **The Provider attested it.** `PhisMediaObjectHead.checksum` -- deliberately not `etag`. A Provider
  that cannot say answers `null`, and null is recorded. A missing digest is a fact; a wrong one invites
  a comparison.

**Not every digest may answer every question.** Two grades exist, and only one of them identifies:

- **Identity-grade**: SHA-256 and SHA-512. Duplicate detection compares these.
- **Integrity-grade**: CRC32/CRC32C/CRC64NVME, MD5, XXHASH. These prove a transfer intact and are
  recorded as such, and are never compared.

The distinction is not fussiness. CRC is linear, so a second file colliding with a stored one is algebra
rather than computation, and MD5 collisions are a download. What rides on it is duplicate detection, and
a collision there is a *refused* upload rather than a substituted file -- so the cost of trusting a weak
digest is that someone who may already write to a Space can keep one particular file out of it. Small,
but free to avoid, so the index is restricted to the two that cannot be gamed.

Which algorithm a Profile records is settled **once, when it is probed**, and read from the Profile
afterwards rather than derived again. Deriving it every time works only until the rule changes, and then
it moves every already-probed Profile onto a new algorithm at once -- splitting each Space's objects
into cohorts that can never be told to match. The consequence to accept is that duplicate detection is
cohort-wise: two identical files recorded under different algorithms are not recognisably the same. That
was already true before any of this; it was simply invisible.

### Objects too large for one request

A checksum signed into a PUT covers that PUT. Above the single-request limit an object arrives in parts,
and the digest of the assembled object is normally a composite of the part digests -- correct, and about
nothing anyone uploaded.

The probe therefore asks a sharper question than "does this endpoint support whole-object checksums":
`verifiesWholeMultipartObject` is true only where the endpoint will compute one of the *identity-grade*
algorithms over the whole assembled object. With a CRC most endpoints will, and a CRC cannot answer
whether two objects are the same.

Where the answer is no, such an object is still **accepted and fully verified**, part by part; it simply
carries no digest that duplicate detection can use. Pulling the body back through Core to hash it was
considered and rejected: duplicate detection is a saving, not a guarantee, and buying it for the largest
objects with a full extra read of every byte inverts the cost it exists to avoid.

The S3 Provider issues no multipart plan today (see `TODOS.md`), so the boundary is not reached: `nginx`
caps a proxied body at `client_max_body_size 2g` and S3 accepts a single PUT up to 5 GB.

Finalizing is always Core's: only the Server turns a delivered body into an Asset. It settles the staged
object with the Provider first, carrying through whatever the plan asked the Client to report back,
opaque to Core. Everything after delivery is therefore judged once, for every plan alike: what actually
landed, whether it matches the declared size, whether that object is already an Asset in this Space, and
what the Asset becomes.

Assets and active upload sessions remain the reconstructable source of truth. Counters are maintained
transactionally, and every read of a Space discounts what expired sessions still hold, over the same
predicate the release uses -- so the capacity a Client is shown is the capacity the next request gets.
Physical deduplication must not change logical quota accounting. Observable duplicate detection is
scoped to one Space so it cannot disclose another user's or group's Asset.

New uploads enter a non-deliverable pending or quarantine state until size, content type, checksum,
sanitization, and any configured malware policy succeed.

## 8. Storage Providers and Profiles

Local filesystem Storage is the mandatory Core Provider. S3-compatible Storage is implemented by an
operator-installed Add-on and contributes no browser code.

A Provider is executable code registered under one package-qualified provider key. A Storage Profile
is Site-scoped configuration selecting that Provider:

```text
media_storage_profiles
├── id
├── site_id
├── key
├── provider_id
├── configuration_json
├── secret_reference
├── configuration_version
├── status
├── flags
└── timestamps
```

Configuration JSON contains only schema-validated non-secret settings. Credentials and encryption keys
remain in the server secret facility under the Add-on, Site, and profile namespace; section 16 of
[SERVER_ADDONS.md](./SERVER_ADDONS.md) states what that facility is and why `secret_reference` does not
name a storage location. A Site admin may
select an operator-allowed profile but cannot install provider code, choose package versions, or read
secrets.

A Provider whose upload plan addresses its own origin needs a cross-origin rule on the bucket, and
setting one is part of provisioning a profile rather than an afterthought. A browser sends a preflight
before a presigned PUT, and a bucket without a matching rule refuses it -- with the body never leaving
the browser and the Site's own logs showing nothing at all. Two details are worth recording because
they cost a debugging session each: a rule must name one origin per entry, since at least one
S3-compatible server answers a multi-origin rule by echoing the whole list in a single
`Access-Control-Allow-Origin` header, which every browser rejects; and a server-side test proves
nothing here, because a server-side HTTP client has no same-origin policy to fail.

The Storage Provider interface is stream-first and exposes only approved object operations:

- put and get stream;
- head, delete, and copy;
- create, complete, and abort a direct or multipart upload plan;
- resolve public, signed, or proxy delivery;
- report capabilities, limits, and diagnostics.

`listPrefix` is a maintenance and reconciliation operation, never the normal Asset catalog. Database
records remain the authoritative catalog.

Provider unavailability never falls back to Local. Existing profile and Asset rows remain intact, new
writes are blocked, reads fail closed with a typed diagnostic, and reactivation restores the same
binding. A profile change does not reinterpret existing Assets.

## 9. Add-on service-provider boundary

Storage uses the installed Add-on desired state and Site activation state from
[SERVER_ADDONS.md](./SERVER_ADDONS.md). It does not call an Add-on through a private HTTP loopback route.

The Add-on ABI therefore has one central internal service-provider extension point. A manifest declares
a provider key, one Core-owned service kind, interface digest, and factory export. The runtime exposes
the matching factory. Core validates `(service kind, provider key)`, interface digest, installed entry,
global activation, Site activation, configuration, and instance readiness before constructing the
service.

Service Providers are distinct from Module server bindings: the Core-bound Asset Module consumes the
Core Media service, while Core selects a configured Local or Add-on Storage implementation internally.
The Asset Module must not bind directly to S3 and must not import an S3 package.

All serving instances in one release must contain the same enabled provider code and secret access.
Local Storage is suitable only for a single instance or a deliberately shared filesystem. Independent
multi-host or round-robin instances require a shared object store such as S3.

## 10. Upload and delivery

The upload service returns a Provider-neutral upload plan:

- Local may return an authenticated same-origin proxy stream;
- S3 may return presigned PUT or multipart instructions;
- the Client follows the plan without branching on a Provider package id;
- finalize always returns to `phi-server` for authorization, verification, persistence, and quota commit.

Finalize must not require buffering an arbitrary object in memory. Metadata extraction, SVG
sanitization, image processing, variant creation, and scanning use bounded streams, temporary files, or
asynchronous jobs as appropriate.

Canonical delivery resolves by stable Asset id and optional variant key, not by a browser-supplied
Storage key. Public Site Assets may resolve to an immutable proxy or CDN URL. User, Group,
authenticated, and internal Assets use private proxy responses or short-lived signed URLs. Protected
responses never use shared public immutable caching.

### Who may see an Asset

Ownership and visibility are separate axes. The Space says who owns and administers an Asset; the
delivery policy says who may read its bytes, and it is enforced per Asset regardless of which Space it
sits in:

```text
Internal        server-to-server only, internal token
Public          anyone, no session
Authenticated   any signed-in user of this Site
User            the owner of that User Space
Group           effective members of that group
```

That is what makes an avatar and a payment receipt the same mechanism with different values. An avatar
lives in its owner's User Space and is `Public`, so everyone sees it while its owner administers it; a
receipt sits in the accounting group and is `Group`, so only that group reads it. Only `Public` is ever
cached publicly and immutably -- everything else answers `private, no-store`.

**A Module sets the classification, never the uploader.** It follows from the purpose an Asset was
accepted for: an avatar surface writes `Public` because an avatar is visible by definition, a receipt
submission writes `Group`. Nobody picks a level from a list, because "who may see this" is a publishing
decision and publishing decisions belong to whoever owns the purpose. The default for an Asset created
in a User Space is `User`, and a Module deliberately widens it.

There are two delivery paths and they answer different questions. A `phi:asset/...` reference inside CMS
content resolves through the Core resolver, which admits Site Space Assets only -- that keeps a Page
from embedding someone else's file. A Module rendering its own collection resolves through its own data
source and is bound by the delivery policy alone. Neither needs to be relaxed for the other.

`delivery_revision` invalidates previously issued grants without changing Asset identity. A `change
key` operation increments this revision and revokes old signed links. Physical provider encryption-key
rotation is a separate operator Storage migration and must not be conflated with delivery grant
rotation.

## 11. Storage migration and failure behavior

Changing an existing Asset's profile is an explicit resumable job:

1. copy to the target Provider;
2. verify size, checksum, content type, and required metadata;
3. atomically switch the Asset or variant profile/key while preserving its id;
4. retain the old object for a bounded recovery window;
5. remove it only after successful reconciliation.

A failed migration leaves the original binding authoritative. Folder moves, title edits, and delivery
policy changes do not start Storage migration.

Normal queries resolve accessible Space ids once per request and filter indexed Asset and Folder rows.
They must not issue one membership query per Asset or list a Storage prefix. Group membership changes
invalidate authorization-sensitive caches through `authorization_revision`.

## 12. Shared UI boundary

`PhiCollectionViewWidget`, its Binding, and its Provider remain the only Asset collection path. The
Asset Provider owns resource queries, authorization-aware actions, Folder options, upload plans, and
domain item rendering. The Widget persists presentation and selected capabilities only.

The trusted Provider context determines the active Space, and which Area a surface runs in decides
whether it may name one at all:

```text
app                    the actor's own User Space and their groups
builder, editor        the Site Space only
public                 no picker and no upload
admin, accounting      no Space selector in the shared picker
```

The rule is the Area, not the surface, because the Media Widgets -- picker, preview grid, area upload --
can be placed anywhere by an author, including in Widgets that do not exist yet. The Area alone is not
enough to read it off, though: a Builder canvas renders the Area it edits, so its Area really is `app`
while it previews the App. The signal partition settles it -- a live Area partition is someone working
in that Area, a `canvas` partition is always authoring -- and both have to agree before a selector
appears. Builder and Editor stay
on the Site Space because that is where publishable content comes from: an Asset from a group cannot be
rendered by a `phi:asset` reference, so offering it there would only produce images that vanish on the
published page. It also keeps ordinary authoring independent of the optional `@phis/groups` package.
Anyone who needs their groups switches to `/app`, where the same memberships apply.

Administration does not get its Space selector in the shared picker either. Seeing other people's
Spaces is its own surface, delivered by the Media module, where the view can be what that task actually
needs -- grouped by user and group, with usage against quota and orphaned holdings -- rather than a
picker bent into a different shape. Developer sees group Spaces there, Admin additionally User Spaces;
another user's User Space is never listed anywhere and is reachable only by naming it, which is logged.

A selector offers only Spaces the server returned as accessible. The Folder filter is scoped to the
active Space. Upload inherits only the trusted active Space and explicitly selected Folder;
presentation filters do not grant ownership or authorization. Inherited means exactly that: the Space
an upload names is the one the control plane last said it served, so it follows the eye rather than a
second choice, and a surface that may not select names none at all.

Third-party Modules may bind the generic Collection View to their own resource Providers. They do not
gain access to Core Media tables, Storage adapters, or arbitrary Space ids.

## 13. Contract governance

Changing, extending, replacing, reinterpreting, or bypassing this contract requires explicit prior
operator approval. Group-like domain tables, Asset-owner flags, raw bucket access, Module-local signed
URLs, direct Ant Design collection paths, Client-only access checks, global Storage fallbacks, and
Storage-key identity are forbidden parallel contracts.
