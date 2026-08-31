# Add-on Roles

**Status: planning. The role half is not built.** The group half and the owner half exist and are
described here as they are, because the whole point of the design is how the three fit together.

## Three questions, three mechanisms

An Add-on that governs who may do what is always asking one of three different questions, and the
mistake is to answer all of them with the same tool.

| Question | Answered by |
|---|---|
| May this person do this **at all**? There is no row yet. | **Role** |
| May this person touch **their own** row? | **`owner_user_id`** |
| May several people share a row, each to a different depth? | **Group** and its ladder |

The test to apply: does the question concern a particular row? If not, it is a role. If yes and only
the creator should ever reach it, ownership settles it and nothing else is needed. If yes and several
people share it at different depths, it is a group.

**A group is Core's vocabulary about shared rows. A role is the Add-on's vocabulary about actions.**
Whatever Core has to evaluate must be Core's word — that is the line, and it explains why the ladder
cannot be replaced by roles. The four levels are interpreted by
`mayActOnScopedRow` in `src/lib/addons/capabilities.ts`: Author means "may change what is theirs",
Editor "also what others wrote", Manager "also remove it". Core can only apply that because it knows
what the words mean. Roles are, by design, opaque to Core — it stores them and answers `has()`. An
Add-on wanting its `reviewer` to mean something for an `UPDATE` would have to teach Core that meaning,
and then the vocabulary would have to be Core's after all.

The second reason is dimensional: the ladder hangs on the **group** (`readEffectiveGroupMembershipFlags`
takes a group id), roles hang on the **Add-on**. The same person is Editor in one group and Member in
another. A role table would need a group column to express that, at which point it is the ladder rebuilt
out of strings.

## What already holds today

Core writes the scope columns on insert, and the descriptor has nowhere to name them —
`src/lib/addons/query-sql.ts:190`: "Core's columns first, and written by Core." An Add-on can therefore
not issue a row in somebody else's name.

Ownership works without any group at all. In `mayActOnScopedRow`, a table that is `ownerScoped` and not
`groupScoped` answers `return owns` — read and write for the owner, nobody else, no membership anywhere.

A group means "everyone in here reads everything in here": after the `Member` check, `intent === "read"`
returns true unconditionally. This is a design property, not an oversight, but it decides who may be put
in a group — never a customer, for instance.

`data:v1` enforces the ladder itself on `update` and `delete`, before the statement runs
(`src/lib/addons/data-capability.ts:141`), and it is handed the evaluator whether or not the Add-on
declared `authorization:v1` (`capabilities.ts:258`): "Declaring `data:v1` is not a way to write past the
ladder -- it is the way to write under it." `mayActOnRow` on the authorization capability answers the
same question one step earlier, for deciding what to *offer* somebody. The enforcing check is the one in
the write path, because a check that has to be remembered is one that eventually is not.

## The role, declared

Roles are declared in the manifest, exactly as settings are: the Add-on states its vocabulary, Core
holds the values, and the Add-on reads through a capability and never writes.

```ts
roles?: PhiServerAddonRoleDescriptor[]   // { name, description?, grantableBy }
```

```ts
roles: [
  { name: "support-admin", grantableBy: { siteAccess: "siteAdmin" } },
  { name: "agent",         grantableBy: { role: "support-admin" } },
  { name: "supervisor",    grantableBy: { role: "support-admin" } },
]
```

`grantableBy` is how an Add-on decides for itself who may hand out its roles — declaratively, in a
manifest that is validated at install and covered by the digest, so the running code cannot rewrite it.
The author sets the policy; Core enforces it. That is the same bargain as `settings` and `secrets`,
neither of which has a writer, for the reason stated in `settings-capability.ts`: an Add-on able to
answer for the operator could widen what it was granted.

Two safeguards belong with it. `siteAdmin` may always grant any role of any Add-on — without that floor
a badly declared graph locks everyone out with no way in. And a manifest whose roles grant each other in
a cycle should be refused at install, because nobody could ever start.

## Where it is stored

```sql
CREATE TABLE phis.site_addon_user_roles (
  site_id            int  NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  addon_id           text NOT NULL,
  user_id            int  NOT NULL REFERENCES phis.users(id) ON DELETE CASCADE,
  role               text NOT NULL,
  granted_by_user_id int  NULL REFERENCES phis.users(id) ON DELETE SET NULL,
  granted_at         timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (site_id, addon_id, user_id, role)
);
CREATE INDEX ON phis.site_addon_user_roles (site_id, user_id);
```

One Core table, not one per Add-on. `role` is text rather than a foreign key: which roles exist is
stated by the manifest, and that is the only truth. A role table beside it would be a second one, drifting
at the next update. The price is that an assignment can point at a role a newer version no longer
declares — see below.

`site_id` is in the key because the same person may be a vendor on one Site and nothing on the next. The
index over `(site_id, user_id)` serves user administration, "what does this person hold, across all
Add-ons"; the primary key serves the runtime read.

## Reading

`roles:v1` answers `has(role)` and `all()`, bound to the acting user of the request. No user id leaves
Core: the Add-on learns whether, never who.

Results are filtered against the roles the **current** manifest declares, the same way
`settings-capability.ts` treats stored keys — "a stored key nobody declared is ignored rather than handed
over". An Add-on therefore never sees a role it does not know, whatever has accumulated across versions.

## Writing

Exactly one Core route writes, and the CLI writes beside it. The route takes `(addonId, role, userId)`,
resolves the descriptor from the stored manifest and evaluates `grantableBy` against the acting user:
a site access through the ordinary access policy, a role through this same table, and `siteAdmin`
always.

An Add-on's own UI calls that route. It does not check the policy itself — it renders a screen, and if
somebody reaches the screen who should not, Core refuses the write. The decision never lives in Add-on
code.

## Collecting for user administration

Core reads the manifests of the Add-ons enabled on a Site and takes their `roles[]`. These are stored,
validated manifests: rendering user administration loads no artifact.

One screen carries both cases without being built twice, because it shows only the roles the viewer
could grant under `grantableBy`. An operator sees everything; a `support-admin` sees that Add-on's roles
and nothing else. Reaching the screen through user administration or through the Add-on's own surface
changes nothing about the check.

## A worked example: support

The mechanics dictate the shape, which is worth following through because the result is the ordinary
form of a support desk.

Customers must not be in the team group — a group grants read on everything in it. And an insert into a
group-scoped table takes its group from a parameter, so a customer who is in no group cannot create such
a row. Both facts push to two tables:

```
requests   siteScoped, ownerScoped     what the customer files
tickets    siteScoped, groupScoped     what a team runs
```

The customer files a `request`; Core writes `owner_user_id` from the bound actor, and only they can read
or change it — ownership without a group does not touch the ladder at all. An agent accepts it and
creates a `ticket` in their team, which they may because they are in that group. The customer follows
progress through a declared query filtered `WHERE reporter_user_id = {from: "actor"}`, which Core
substitutes and the Add-on cannot aim at anybody else.

| Person | Role | Team A | Team B | Result |
|---|---|---|---|---|
| customer | – | – | – | sees only their own requests |
| agent K | `agent` | Editor | Member | works A, reads along in B |
| agent O | `agent` | Member | Manager | reads along in A, closes in B |
| lead R | `support-admin`, `supervisor` | Manager | Manager | grants roles, everything in both teams |

K and O hold the **same role** and may do quite different things. That is the argument for the ladder
staying per group, in one table.

The role covers what has no row: opening the agent workspace, accepting a request into a team at all,
starting the nightly SLA job. The group covers which team's tickets and how deep. Ownership covers the
customer, who is nothing in the system beyond signed in.

## Open

- **How a module finds the users it wants to grant to.** Everything above keeps user identity away from
  Add-ons; granting needs a user id. Either Core owns a search route, released under the same rule
  (whoever may grant a role of this Add-on may search), so an Add-on receives ids only in the act of
  granting and never a browsable directory — or granting always happens in Core's user administration
  and the Add-on merely links there.
- **Assignments whose role a new version no longer declares.** The proposal is to keep and report them
  rather than delete: deleting is silent loss of access during an update, reporting leaves the operator
  to decide. The same on uninstall, so an update that briefly uninstalls does not discard the list, with
  an explicit `--purge` to clear it.
- **Binding roles to groups as well as to users.** Attractive operationally, and because the capability
  only answers `has(role)` no Add-on would notice the difference. It can therefore wait.
- **The capability name**, frozen from the first public release.

## Found while writing this

`PhiServerAddonInsertQueryDescriptor` in `@phis/addon-contract` states that on a group-scoped insert
"the group comes from a declared parameter because a row can belong to any group the actor is in, and
Core refuses one they are not". The refusal does not appear to be implemented: `run` in
`data-capability.ts` checks the ladder for `update` and `delete` only, the compiled insert binds the
group argument straight into the statement, and no membership check was found on that path.

The consequence is that an actor can place a row in a group they do not belong to. It is not a read
escalation — they still cannot read that group's rows back — but it is a documented guarantee that does
not hold, and it should be closed before third parties write Add-ons against the contract text.
