# Threads: Planned Design

**Status: every step of the order in section 15 is built except step 6, `@phis/github`.** The schema,
the visibility predicate, `/api/site/threads`, the recut `threads:v1`, `resource-links:v1`, verified
hooks and the event outbox are in the server; [DB.md](../DB.md) holds the tables and
[SERVER_ADDONS.md](../SERVER_ADDONS.md) sections 8, 10, 13 and 18 hold the contracts. Step 4 arrived
differently from how it was planned, and section 15 says how: the listing is a generic Table over a data
provider and the composer is two Forms, so the Module contributes one Widget where three were expected.
Attachments carry, and a message can be read in the reader's own language.

What is described here and is not built, besides step 6, is the custody transfer an accepted attachment
would pass through. That is [GROUPS_AND_STORAGE_PLANNED.md](./GROUPS_AND_STORAGE_PLANNED.md) section 2,
it is stated where it arises in section 5, and Support is its first caller
([SUPPORT.md](./SUPPORT.md)).

Decisions taken while writing this are stated where they apply. One question is deliberately left open
and is named where it arises: whether an attachment on an `External` ticket is mirrored outward, which
belongs to the Add-on that would carry it. What otherwise remains is building it in the order of
section 15.

## 1. Why the current model is not enough

Threads were built as internal Support messaging, and three cases outgrew that at once: Staff talking to
Staff, people in a group talking to each other -- customers among them when an Add-on forms the group --
and a GitHub integration that has to hold a conversation open in both directions.

What stands in the way today:

- **Only Support roles reach threads.** Every thread route is guarded by `PHI_ACCESS_SUPPORT`
  (`Developer | Supporter`, widened to Admin). A Builder cannot write to a Publisher.
- **Membership is a second group system.** Thread visibility joins `support_team_members`, while
  [GROUPS_AND_STORAGE.md](../GROUPS_AND_STORAGE.md) makes `site_groups` the one membership source.
  (Settled by step 2: the table is gone and a queue references a group.)
- **The recipient list is the Site's user list with addresses.** `listSupportRecipientUsers` answers
  every user holding a claim, with `email`. The Site route and `threads:v1` project the same thread two
  ways -- with addresses and without -- and `@phis/support` types itself against the first.
- **Two message models.** A ticket conversation lives in `support_ticket_messages` with its own
  visibility and external reference; a thread lives in `support_thread_messages`. An integration would
  have to synchronize both.
- **An actorless Add-on can open a thread and never touch it again.** `threads:v1` leaves ownership
  "for when something real needs it". GitHub is that.
- **An unauthenticated hook may call `threads.create`.** The hook rule says a request with no actor may
  read and may not write; `threads:v1` does not apply it.
- ~~**The capability snapshot reports the whole catalogue as available**, including `resource-links:v1`
  and `support:v1`, which nothing builds.~~ Fixed: the snapshot reports the catalogue, and the gate that
  admits an Add-on asks what Core delivers instead. Both are delivered now.

## 2. Vocabulary: groups, not teams

There is one membership concept and it is the Site group. It already has what a team would need: a
cumulative level ladder (`Member`, `Author`, `Editor`, `Manager`), provider ownership so an Add-on can
form its own, retirement, Directory assertions, and the rule that a member sees the other members by
name and never by address.

A separate "team" would have to answer the same questions again, and two answers drift. What a Support
team has beyond membership -- routing, a queue, a default assignee -- is not membership, and it stays a
Support profile *over* a group, named a **queue**:

```text
group   who belongs, at which level            Core, site_groups
queue   where Support work is routed           @phis/support, references one group
```

The words that follow: thread kinds are `Group` and `CrossGroup`; the Module that offers group spaces is
the groups Module; "team" does not appear in schema, contracts or routes. An interface may still say
"Team" as a label where a Site prefers it.

## 3. Who may thread

### Staff

`PhiBaseRole.Staff = 1 << 7` is added. It grants nothing beyond being Staff.

**Staff is whoever holds any Core role** -- `role_flags` of `@phis/server/core` non-zero. The bit exists
for people who work for the Site and need none of the other roles. Roles an Add-on defines never make
anybody Staff: they are provider-local and describe what someone may do *in that Add-on*, which is how a
customer can hold an Add-on role and remain a customer.

### Visibility runs through groups

A person is visible to another only through a group they share. There is no Site-wide user list for
threads, and nothing about a person crosses except `PhisUserProjection` -- display name always, company
only where the group sets `ShowMemberCompany`, address never.

A retired group grants nothing here either: sharing a retired group is sharing no group.

### The Site with no shared group

The rule above has a consequence worth stating before somebody meets it as a bug: two Staff who share no
group cannot start a conversation. On a Site with no groups at all nobody can; on a Site whose groups
follow its teams, a developer and a supporter cannot, which is exactly the ad-hoc contact -- *can you
look at this* -- that a thread is most useful for.

**This is correct and stays.** The alternative is a Site-wide Staff list, and the section above refuses
one deliberately: a person is visible to another only through a group they share. Bending it for
`Direct` would not be a small exception, it would be that list, reachable by every Core role holder and
arriving without the Site ever deciding to have one.

**The answer is a group, not a rule.** A Site that wants its Staff to reach each other gives them a
group -- and then the existing rule does it, with the existing candidates route and no special case
anywhere. What the threads Module deliberately does **not** do is seed one: a group containing everybody
who holds a Core role is a Site-wide Staff list by another name, and whether to have one is the Site's
decision rather than a Module's to take on its behalf.

Two consequences follow. **Admin and Developer are the way in**, and their reach -- already settled below
-- is what lets a Site that has just installed the Module hold its first conversation and form the group
from there. And **the candidates route says why it is empty**: a blank list reads as a broken surface,
where *you share no group with anyone yet* is the one sentence that leads somebody to the fix.

### Thread kinds

| Kind | May open | Participants | Available when |
|---|---|---|---|
| `Direct` | Staff | Staff who share a group with the opener | Site kind `Direct` |
| `Group` | `Author` of the group | the group | Site kind `Group` and group flag `Threads` |
| `CrossGroup` | `Author` of one group | two or more groups | Site kind `CrossGroup` and group flag `CrossGroupThreads` on every group involved |
| `Support` | any authenticated Site member | the requester and a queue's group | Site kind `Support` |

Settled: opening a `Group` or `CrossGroup` thread needs `Author`; reading and replying need `Member`.
Admin and Developer are covered below.

**Archiving is for everyone, so not everyone may do it.** The status is one row, and closing a thread
ends it for every participant. Whoever opened it, Staff, and a `Manager` of a group taking part may
archive or reopen it; any other participant is refused (403). A Support thread's status belongs to the
ticket's workflow, so its requester is refused even though they opened it. Add-ons and Core itself reach a
thread through their own rules and are not asked again.

**Admin and Developer may always write.** They may open a `Direct` thread to any Staff member and add
any Staff member or group to a thread they are in, without sharing a group. This is authority to *reach*
someone, not to *read*: it does not open a thread they are not a participant of.

### The group flags

`site_groups.flags` gains two bits:

```text
Threads            members may hold Group threads here
CrossGroupThreads  the group may address, and be addressed by, other groups
```

[GROUPS_AND_STORAGE.md](../GROUPS_AND_STORAGE.md) says group flags are display bits and never rights.
These two are neither a display bit nor a person's right: they switch a surface on for the whole group,
the way a Space kind is available or not, and what anyone may do there is still decided by their level.
They are needed because groups are also audiences -- a group of five thousand customers used for Page
access must not become a chat room because the Site offers `Group` threads.

Who sets them: Developer or Admin for Core groups, since that is who creates groups. An Add-on sets them
for its own groups through its group writer, which is how customers in an Add-on's group come to talk to
each other without the Site doing anything.

### Which kinds a Site offers

`site_thread_config.flags` holds `Direct | Group | CrossGroup | Support`. It is not a switch anyone
flips: it is materialized from what the active Modules declare, the path Media Space kinds already take
(`PhiRuntimeModuleDefinition.mediaSpaces` → the Builder's union on save → the stored result read at
request time).

```text
@phis/ui/threads   Direct
groups Module      Group, and CrossGroup where its settings enable it
@phis/support      Support
```

A kind that stops being declared hides its threads; nothing is deleted, and they return with the Module.

### Support

`@phis/support` seeds a group of its own (`provider_id = '@phis/support'`, key `support`) when it is set
up, and its queues reference groups. It does not require the groups Module: the group is a Core group,
and only its administration surface would come from there.

A customer opens a `Support` thread and is its participant with `ParticipantFlag.Requester`. They see
their own Support threads and nothing else, and they see **the names of the people answering them**:
Support is personal, and escalation needs a name to escalate past. Escalating adds a queue's group or a
person as a participant and writes a system message naming them. The customer never sees a group's
member list, and never an address.

## 4. Message confidentiality

Two independent message flags, and they answer different questions:

```text
Internal       who may read it     Staff participants only; hidden from everyone else in the thread
Confidential   where it may go     nowhere outside Core
```

`Internal` is for a note to colleagues inside a thread a customer can see. Only Staff may set it.

`Confidential` is for content that must not leave: a password a customer pasted, a bank account, a
medical detail. Anyone may set it, a customer included, and it stays readable to whoever may read the
message. What it withholds is every path out of Core:

- no export to any integration;
- no body in notification mail or push;
- `threads:v1` hands the message to an Add-on with `bodyText` and `bodyMarkdown` withheld and the flag
  set -- whatever its actor could read.

Both may be raised after writing. Lowering either is Admin-only and leaves a system message, because
lowering releases something the author meant to hold back.

## 5. Attachments

A thread carries text and nothing else. `thread_messages` holds `body_text` and `body_markdown`, and no
row in the schema points an Asset at a message or at a ticket. Every case in section 1 wants files: a
customer sends the log that shows the fault, a colleague drops a screenshot into a group, and an issue
imported from GitHub arrives with what hung on it.

### The conversation is the audience

An attachment is readable by whoever may read the message it hangs on. That is the whole rule.

It has to be, because the alternative is to derive it from custody, and custody cannot answer it. A
Media Space says who pays for bytes and who administers them
([GROUPS_AND_STORAGE.md](../GROUPS_AND_STORAGE.md) section 6). The four kinds would give one
conversation four different answers depending on who happened to attach the file: a customer may write
into their own User Space and nowhere else, a Supporter is an Author in the queue's group, an Add-on has
a Space of its own. The same thread, three custodians, and no reader who is the same in all three.

Section 4 already cuts finer than any Space can. An `Internal` note is invisible to the customer in a
thread the customer otherwise reads, and no custodian expresses that -- the file would sit in the same
Space as the message beside it. The message is where the answer already lives, so reading it from there
costs no new vocabulary and cannot drift from the body it belongs to.

This is [GROUPS_AND_STORAGE_PLANNED.md](./GROUPS_AND_STORAGE_PLANNED.md) section 1 applied: `Internal`
is what material a Module mediates carries, and the mediator decides on its own surface who is shown it.
Threads are the first mediator. They are Core's rather than a Module's, so the decision is Core's too,
and every thread kind and every Add-on inherits it without asking.

A per-Asset audience descriptor stays refused, for the reason that document gives: the rules carry every
case in sight, and a descriptor nothing fills is only a contract to get wrong later.

### The link

```text
thread_message_assets
├── message_id   → thread_messages(id)   ON DELETE CASCADE
├── asset_id     → media_assets(id)      ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
├── flags
└── sort_order
```

`CASCADE` on the message and a refusal on the Asset, and the asymmetry is the point. A message that goes
takes its links with it, because a link to nothing is not a record of anything. An Asset that something
still hangs on does not go at all.

That refusal is what stops a submitter pulling the evidence out from under a ticket. They own the file
-- it sits in their Space, on their quota, and everything else about it is theirs -- but while a message
points at it, their delete is refused. Nothing else has to be built for that, and no separate retention
rule has to be remembered.

It is a deferred `NO ACTION` rather than `RESTRICT`, which is the same refusal at a different moment and
is the only one available. `RESTRICT` is checked the instant the referenced row goes and cannot be
deferred, and deleting a Site reaches this table twice -- down the message's cascade and down the
Asset's -- in no fixed order, so the Asset's arm would refuse a link the message's arm was about to take
away. Checked at commit instead, a Site goes and a single attached Asset still does not.

**The CMS reference index is not the place for this.** [REFERENCES.md](../REFERENCES.md) admits only
Site Space Assets as reference targets and says User and Group Space Assets are invalid ones, which is
right and must not be relaxed. It also explains why that index exists: CMS references hide inside opaque
bodies and have to be collected. An attachment is a row. A foreign key does the whole job, with no
collector, no index maintenance and no delete diagnostic of its own -- but the Asset delete path has to
learn about it, or a refusal that should read as "still attached" arrives as a constraint violation.

### Delivery

```text
GET /api/site/threads/:threadId/messages/:messageId/assets/:assetId
```

Core's route, on the thread surface, authorized by the predicate of section 7 and the flags of section
4. The delivery policy of such an Asset is `Internal`: no browser URL reaches the Asset by its own id,
whichever Space holds it, and the only way to its bytes is through the message that names it.

One route serves all of it. A customer's upload in their User Space, a Supporter's in theirs, a file an
Add-on imported into its Add-on Space -- the reader is decided the same way each time, because none of
the three questions the route asks is about where the bytes sit.

### Whoever attaches it writes into their own Space

Custody follows the uploader, never the thread:

```text
a person        their own User Space
an Add-on       its own Add-on Space
```

One rule rather than a table of cases. The tempting second case -- let Staff write straight into the
queue's group Space, since they are Authors there -- is refused: it would make custody depend on who is
speaking, and the transfer below would then need two shapes. The other tempting case, granting a
requester a one-off write into the group, is worse: that is writing into a group you are not in, and it
makes flooding free.

This is [GROUPS_AND_STORAGE_PLANNED.md](./GROUPS_AND_STORAGE_PLANNED.md) section 2's submission model,
and it carries its own abuse bound: whoever floods fills their own quota first, because the file is
theirs until an occasion accepts it.

It follows that a Site whose customers attach anything must have the User Space kind available, and
availability is a Module declaration
([GROUPS_AND_STORAGE.md](../GROUPS_AND_STORAGE.md) section 7). `@phis/support` declares it; see
[SUPPORT.md](./SUPPORT.md). A Site that runs no Module declaring `user` has no requester attachments,
and is refused as unavailable rather than as over quota.

### What custody transfer does not change

Taking a ticket's files into the queue group's custody -- so the record outlives the account that
handed it in and stops sitting on that person's quota -- is
[GROUPS_AND_STORAGE_PLANNED.md](./GROUPS_AND_STORAGE_PLANNED.md) section 2, and it is not built.

Attachments do not wait for it. Because the audience never came from custody, a transfer moves who pays
and who administers and touches nothing about who reads -- which is exactly what that section requires
of a transfer and could not have promised if the two axes were the same one. The order in section 15
therefore builds attachments first and leaves the transfer to its own occasion.

### What leaves Core

`Confidential` already forbids every path out (section 4), attachments included.

Whether an ordinary attachment on an `External` ticket is mirrored outward is left to section 12. It
cannot be answered here: the bytes sit in a Space the Add-on cannot reach, so the answer is a mechanism
and not a policy, and the Add-on that would need it is the one that has to state what it does with an
attachment that arrives the other way.

### One object cap, and what it is not

The largest single object is `site_media_config.max_object_bytes`, one number per Site, defaulting to
128 MiB, and delivery streams rather than reads -- so what an attachment may weigh is a Site's policy
rather than the memory a download costs ([GROUPS_AND_STORAGE.md](../GROUPS_AND_STORAGE.md) section 7).
That it does not yet know which Storage path will carry the object is
[GROUPS_AND_STORAGE_PLANNED.md](./GROUPS_AND_STORAGE_PLANNED.md) section 6.

## 6. Schema

Reshaped freely: this is before v1, so existing rows are swept rather than migrated behind a shim.

```text
threads
├── id SERIAL
├── site_id SMALLINT
├── kind SMALLINT                Direct | Group | CrossGroup | Support
├── status SMALLINT              Open | Archived
├── subject VARCHAR(255) NULL
├── flags INT                    ThreadFlag: Locked
├── owner_provider_id TEXT NULL  NULL = Core; otherwise the Add-on or Module provider that owns it
├── created_by_user_id INT NULL
├── last_message_id INT NULL     denormalized for the inbox
├── created_at, updated_at

thread_participants
├── id SERIAL
├── thread_id INT
├── participant_kind SMALLINT    User | Group
├── user_id INT NULL
├── group_id INT NULL            → site_groups
├── flags INT                    ParticipantFlag: Requester, ExternalConsent, Left, Muted
├── created_at
    exactly one of user_id / group_id; unique per (thread_id, user_id) and (thread_id, group_id)

thread_messages
├── id SERIAL
├── thread_id INT
├── author_kind SMALLINT         User | Integration | System
├── author_user_id INT NULL
├── author_provider_id TEXT NULL
├── body_text TEXT
├── body_markdown TEXT NULL
├── flags INT                    MessageFlag: Internal, Confidential, Edited, Redacted, Imported
├── meta JSONB                   external author name and URL, system message parameters
├── created_at, updated_at

thread_reads                     unchanged: (thread_id, user_id) → last_read_message_id, read_at

thread_message_refs
├── message_id INT
├── provider_id TEXT
├── external_id VARCHAR(256)
├── flags INT                    RefFlag: Imported, Exported
    UNIQUE (provider_id, external_id)

resource_links                   resource-links:v1; replaces support_ticket_links
├── id SERIAL
├── site_id SMALLINT
├── subject_kind SMALLINT        Thread | Ticket | TicketTask
├── subject_id INT
├── provider_id TEXT
├── type SMALLINT                provider-local
├── external_id VARCHAR(256)
├── url TEXT NULL
├── state SMALLINT NULL          provider-local
├── flags INT                    LinkFlag: Synced
├── meta JSONB
├── created_by_user_id INT NULL
├── created_at, updated_at
    UNIQUE (site_id, provider_id, type, external_id)
```

Leaving:

- `support_thread_recipients` becomes `thread_participants`, with groups instead of Support teams.
- `support_team_members` goes; membership is `site_group_members`.
- `support_teams` becomes `support_queues (site_id, group_id, key, flags, sort_order)`.
- The fixed `SUPPORT_TICKET_TYPE_*` vocabulary becomes a Site catalogue,
  `support_ticket_types (id, site_id, key, name, flags, close_policy SMALLINT, requester_window_days
  SMALLINT, sort_order)`, with `TicketTypeFlag: External, CodeChange` and `close_policy`
  `Confirm | CodeAccepted`; `support_tickets.type` becomes `type_id` (section 12).
- `support_ticket_messages` goes. A ticket has exactly one thread (`support_tickets.thread_id`, unique,
  not null); its visibility becomes `MessageFlag.Internal`, its `external_message_ref` a
  `thread_message_refs` row. A ticket stays the workflow record -- status, priority, assignment, tasks --
  and the thread is its conversation.
- `support_ticket_links` goes into `resource_links`.

## 7. One visibility predicate

A thread is visible to a user when all of these hold:

1. its kind is in `site_thread_config.flags`;
2. the user is a participant, or an effective member of a participating group that is not retired and
   whose provider is available;
3. for `Group` and `CrossGroup`, the participating group still carries its flag;
4. for a `Requester` participant, the thread is `Support`.

A message is visible when its thread is, and additionally not `Internal` unless the viewer is Staff.

This is one function in the database layer. The Site routes and `threads:v1` call it and nothing else,
which is what keeps the two projections from drifting again.

## 8. Contracts

`@phis/contracts/src/threads.ts` owns the shape both surfaces return:

```ts
PhisThreadKind, PhisThreadStatus, PhisThreadFlag, PhisThreadParticipantFlag,
PhisThreadMessageFlag, PhisSiteThreadKindFlag

PhisThreadSummary      id, kind, status, flags, subject, createdAt, updatedAt, latestMessageAt, unread
PhisThreadParticipant  { kind: "user"; user: PhisUserProjection; flags }
                     | { kind: "group"; groupId; name; flags }
PhisThreadMessageAuthor
                       { kind: "user"; user: PhisUserProjection }
                     | { kind: "integration"; providerId; externalName?; externalUrl? }
                     | { kind: "system" }
PhisThreadMessage      id, author, bodyText | null, bodyMarkdown | null, flags, createdAt, updatedAt
PhisThreadDetail       thread, participants, messages, hasMoreMessages
```

The types move out of `capabilities.ts`. `@phis/support` drops `PhiSupportInbox*` and uses these.

**Site API.** `/api/site/threads` belongs to Core and requires a Site session; which kinds a person may
reach is the predicate's answer, not the guard's. One message write is offered at two addresses:
`POST /api/site/threads/<threadId>/messages` for a caller holding a thread id, and
`POST /api/site/threads/messages` with `threadId` in the body, which is what a declared Form submits to --
a Form handler relays to one static path and sends its values, and the conversation is one of them. Both
are the same write, sharing one implementation, and neither trusts the id: the row is read through the
caller's own visibility predicate, so one they may not see is not found. Needed beyond today: status changes, adding
participants, message paging (`beforeMessageId`), a status filter, and a candidates route that answers
the people and groups this actor may address -- projections, capped, never addresses.
`/api/site/support` keeps tickets and queues.

**`resource-links:v1`** is built in `@phis/contracts/src/resource-links.ts`: a subject that is a thread,
a ticket or a ticket task, `PhisResourceLinkFlag.Synced`, and `list`, `link`, `setState`, `unlink`,
`findByExternalId`. Reads are bounded by the actor seeing the subject; writing needs an actor at all,
because a link is a person saying two things belong together.

**The Support vocabulary both ends share** is `@phis/contracts/src/support.ts`:
`PhisSupportTicketTypeFlag` (`External`, `CodeChange`), `PhisSupportClosePolicy` (`Confirm`,
`CodeAccepted`) and the 14-day requester window default.

**`threads:v1`** lives beside its vocabulary in `threads.ts` rather than in `capabilities.ts`, the way
`assets:v1` lives in `assets.ts`: `list`, `get`, `create`, `reply`, `addParticipants`, `setStatus`,
`markRead`, `findByExternalRef`.

**The capability snapshot** reports the catalogue; the gate that admits an Add-on asks what Core
delivers. `@phis/support` requires `threads:v1`, `resource-links:v1` and `support:v1`, and all three are
built -- the last so that a package in its own repository, `@phis/github` among them, can reach a Site's
tickets without depending on the Support Module.

## 9. Add-ons without an actor

With an actor, `threads:v1` is what it is today, through the predicate in section 7.

Without one -- a job, a verified hook, an event handler -- an Add-on reaches a thread when either holds:

- **it owns it**: `owner_provider_id` is its id, because it opened the thread with no actor; or
- **it is linked to it**: a `resource_links` row with its `provider_id` and `LinkFlag.Synced` points at
  the thread, or at a ticket or ticket task whose thread it is.

The second is what makes this safe rather than merely possible. A link is written by a person who can
see the thread, so it is that person's consent for this one integration and this one thread; removing
the link withdraws it. There is still no listing: an actorless Add-on finds a thread by
`findByExternalRef`, never by walking.

Actorless calls: `create` (owned), `get`, `reply({ threadId, message, externalRef, externalAuthor })`
idempotent on `externalRef`, `setStatus`, `findByExternalRef`. A reply is written with
`author_kind = Integration`. `Internal` messages are never handed to an actorless Add-on;
`Confidential` ones arrive with their bodies withheld.

## 10. Verified hooks

A hook descriptor gains:

```ts
verification?: {
  scheme: "hmac-sha256";
  header: string;          // "x-hub-signature-256"
  prefix?: string;         // "sha256="
  secret: string;          // a secret name the manifest declares
  deliveryIdHeader?: string; // "x-github-delivery"
}
```

Core verifies the signature over the raw body, timing-safe, before the handler runs, and rejects a
delivery id it has already accepted (`addon_hook_deliveries (addon_id, delivery_id, received_at)`,
pruned by age).

- **An unverified hook writes nothing** -- not `data:v1`, and no longer `threads.create`.
- **A verified hook** writes as a job does: system authority over its own tables, and the actorless
  thread access of section 9.

## 11. Events to Add-ons

Outbound synchronization needs Core to tell an Add-on that something happened; today nothing does.

An Add-on declares `eventHandlers` in its manifest: `thread.message.created`, `thread.message.updated`,
`thread.status.changed`, `thread.link.removed`. Core writes an `addon_event_outbox` row in the same
transaction as the change, dispatches it after commit, and `phis addon job run` retries what failed --
consistent with Core keeping no scheduler.

**An event reaches only an Add-on linked to that thread.** Delivering every thread event to every
declaring Add-on would be the Site-wide listing section 9 refuses, arriving by push instead of by pull.
Messages carrying `Imported` from that same provider are not delivered back to it, which is what stops
an echo.

## 12. `@phis/github`

One package, both halves, requiring `threads`, `resource-links`, `data`, `secrets`, `settings`, `roles`.

### Only tickets are linked

GitHub is linked to **Support tickets**, never to a `Direct`, `Group` or `CrossGroup` thread. Whoever
wants an issue out of a Staff conversation opens a ticket from that thread first.

The ticket is where everything the integration has to decide already lives: a type that says whether the
conversation may leave, a status that closing an issue moves, tasks for the engineering work, and the
links. Linking free threads would need each of those again on the thread, and a thread is a
conversation, not a workflow record.

### Identity and configuration

A GitHub App, not personal tokens: installation tokens are short-lived and scoped to repositories, and
minting them needs only `node:crypto` and `fetch`.

**One App per Site.** A GitHub App has one webhook URL. Pointing it at the Site's own domain lets the
Site proxy add `x-phis-site-key`, and the hook is Site-scoped by construction. One App serving several
Sites would need Core to resolve a Site from an installation id -- an actorless cross-Site lookup, the
thing every capability is built to rule out.

- secrets: App id, private key, webhook secret
- settings: installation id, allowed repositories, the ticket type and queue for imported issues, which
  comment authors are imported, whether releases are tracked ("Delivery and the requester window")

### The ticket type decides what leaves

Ticket types stop being a fixed vocabulary and become a Site catalogue, `support_ticket_types`
(section 6), each with flags and a close policy:

```text
TicketTypeFlag.External     the ticket's conversation is mirrored to GitHub
TicketTypeFlag.CodeChange   the work is a code change; see "Closing"
```

`External` is a flag rather than a type because it cuts across types: a bug may be internal or external.
It replaces any per-link export mode -- the type says whether anything leaves, and there is nothing to
choose per message beyond the flags every message already has.

**Never exported, whatever the type:** `Internal`, `Confidential`, system messages, messages imported
from GitHub.

**An `External` ticket says so, where people write.** The composer and the thread show a notice whose
wording follows the repository's actual visibility, checked on every export rather than at link time:

- public repository -- *everything you write here becomes public, including your name*;
- private repository -- *everything you write here is sent to GitHub and visible to everyone with access
  to the repository, including your name*.

Guards around it:

- **A ticket that is not `External` cannot be linked to a public repository.** If a linked repository
  turns public later, export stops, the thread says why, and a Supporter confirms before it resumes.
- **A requester's words need the requester's consent.** A customer sees the same notice. Their messages
  are exported only once they have acknowledged it, recorded as `ParticipantFlag.ExternalConsent`; until
  then only the Staff side is mirrored. A customer's message is their personal data, and handing it to a
  third party is not a Staff decision.
- **Changing the type away from `External` stops export from that moment.** What was sent cannot be
  recalled, and the system message that records the change says so.

Comments are posted by the App with the author's display name.

### Issues belong to tasks

A linked issue or pull request creates an engineering task on the ticket (`support_ticket_tasks`, type
`ENGINEERING`), and the link hangs on the task. One ticket may need several issues, and
[DB.md](../DB.md) already holds that resolving an issue does not resolve the Support work -- so an issue
completes its task, and the ticket decides for itself when it is done.

Inbound:

- `issues.opened` in an allowed repository → a ticket of the configured type in the configured queue,
  its thread owned by the Add-on, a task with a `Synced` link, the issue body as the first message.
- `issue_comment.created` → an `Integration` reply, idempotent on the comment id.
- `issue_comment.edited` / `.deleted` → the message updated with `Edited`, or emptied with `Redacted`.
- `issues.closed`, `issues.reopened`, `pull_request.closed`, `milestone` changes, `release.published` →
  "Closing" and "Delivery and the requester window" below.

Comments are imported by `author_association`: by default `OWNER`, `MEMBER` and `COLLABORATOR` only. On
a public repository anybody may comment, and a ticket is not a place strangers should write into.

Outbound: a person holding the Add-on's role creates or links an issue from a ticket through an Add-on
API route -- with an actor, so `threads.get` answers whether they may. From then on the event handler
posts new exportable messages as comments and records each comment id in `thread_message_refs`.

**Built: forwarding is a Core service kind, and GitHub one implementation of it.** A Supporter forwards
from the ticket, to any installed `@phis/server/service/support-forwarding` implementation that resolves
for the Site and probes usable (`GET/POST /api/site/support/forward`). Core asks the implementation to open
the external record -- from the title alone where the type is not `External`, with the first message only
where the requester consented -- and then writes the engineering task, the synced link from it in the
implementation's name, and the ticket waiting on the work. What the implementation reads afterwards is
withheld by the same rule: an Add-on reading a Support thread sees no text but its own where the type is
not `External`, and none of a requester's who did not consent. When every engineering task is finished,
`CodeAccepted` resolves the ticket and `Confirm` hands it back to Support; a task reopened puts it back in
progress.

**Built in `@phis/github` (first round):** the forwarding implementation (a GitHub App opening an issue in
the Site's repository), and one verified webhook that finishes, ends or reopens the engineering task as the
issue is closed as completed, closed as not planned, or reopened, and imports maintainers' comments into the
conversation.

**Built in the second round:** mirroring -- a message written in phis becomes a comment on the ticket's
open linked issues, naming its author, when Core hands the text over (`External`, consent, never `Internal`)
and never for what came from outside; `threads:v1.recordExport` keeps it to once per message. Issues opened
in GitHub become tickets of the Site's `import-type` category, owned by the integration, with an
engineering task and a synced link -- `resource-links:v1` lets an Add-on link what it owns without an
actor, and the outbox tells a thread's owner as it tells its linked integrations. A comment edited or
deleted in GitHub is `Edited` or `Redacted` in phis (`threads:v1.amendImported`).

**Built in the third round:** the requester is told when the merge resolves their ticket, with the issue's
milestone, and corrected when it moves; with `track-releases`, a published release tells every resolved
ticket it carries a fix for, read from its commits against the previous release. The window waits for it:
`support:v1.awaitDelivery` holds a resolved ticket's window from the merge (`PhisSupportTicketFlag
.AwaitingDelivery`), `markDelivered` starts it at the release (`delivered_at`), and any status move lets go
of both.

**Built: the link panel, in `@phis/support` rather than in a GitHub Module half.** Forwarding is a Core
service kind, so where the work went is not GitHub's to show: the ticket route answers Staff with every
`resource_links` row on the ticket and its tasks (where, through which Add-on, since when -- not the
provider's `type`, `state` or `meta`) and with `outbound`, what of the conversation those systems receive.
The Support Page lists them under the conversation as a Table, one row per external record with its task's
state and a link to it, following the open ticket on the same binding param as the history; its footer
says what leaves. A second integration appears there without a Module of its own.

**Built: linking a record that already exists.** *Link issue* on the ticket row takes what the Supporter
pastes -- a URL, `owner/name#12` -- and `POST /api/site/support/link` asks each implementation in turn
(`lookup`) until one knows it; it answers `unknown`, `refused` with a reason the Supporter reads, or the
record and its title. Core then writes the task and the synced link exactly as for a forward, and only once
that stands tells the record (`linked`), so a refused link leaves nothing said there. GitHub accepts an open
issue in a repository the installation reaches and comments where it is linked from. A record is linked to
one ticket: the uniqueness of `resource_links` refuses a second, which is what a duplicate report would need
-- one issue for many tickets is a change to `resource-links:v1`, `threads:v1` and the schema, not built.

### Closing

`RESOLVED` and `CLOSED` already exist on tickets and take distinct meanings: **resolved** is technically
done, **closed** is confirmed.

| Close policy | Trigger | Task | Ticket |
|---|---|---|---|
| `Confirm` (default) | issue closed as `completed` | done | a Supporter confirms → `CLOSED` |
| `CodeAccepted` (with `CodeChange`) | linked pull request merged into the default branch | done | `RESOLVED` once every engineering task is done; `CLOSED` by a Supporter or the requester window |
| any | issue closed as `not_planned` | done | never automatic; a Supporter decides |
| any | issue reopened | reopened | back to `IN_PROGRESS`, event `REOPENED` |

**Settled: the merge is acceptance.** Delivery decides only what is said. A merge is the moment the code
change is accepted, and it is the one event the repository reliably produces; waiting for a release
would leave a ticket open for work nobody is doing any more. When the ticket turns
`RESOLVED`, the requester is told, with the milestone of the pull request or issue where one is set:

> Fixed. Expected to ship in v2.4.1.

and without one, that the fix ships with an upcoming update. A milestone is a plan, not a promise, so
the wording says *expected*, and a milestone changed after the merge produces a correcting message.

### Delivery and the requester window

With release tracking enabled, `release.published` whose range contains the merge commit adds a message
-- *now available in v2.4.1* -- and changes no state.

After `RESOLVED` the requester may answer; an answer returns the ticket to `IN_PROGRESS`, silence closes
it after the configured window. **The window starts at the release message when releases are tracked,
otherwise at the merge**, so it cannot run out before the requester could have the fix. A ticket with no
requester has no window: it closes when a Supporter confirms.

**The window is ours, not GitHub's.** GitHub knows nothing about tickets, requesters or Support work, and
what it does offer -- stale automation closing inactive issues, locking conversations -- acts on issues
rather than on this workflow. Relying on it would also let a repository's own bot decide when a
customer's ticket closes. A repository that closes stale issues as `not_planned` is already handled: that
reason never resolves a ticket here.

So it is Core's own: the length is configured per ticket type, falling back to a Site default of
**14 days**, and `0` means that type's tickets wait for a Supporter. A Site switches automatic closing
off in one place rather than by setting every type to `0` -- a rule spread over a catalogue is one the
next new type quietly escapes. It is enforced by a bounded, idempotent `phis maintain` task
beside `upload-sessions` and `addon-assets`, which an operator already runs from a timer -- not by an
Add-on job, because closing a Support ticket is Core's work and must keep happening when `@phis/github`
is not installed.

Built, and not dependent on the task: every read of a ticket derives the close from the window, and
every write that locks the ticket records it first, so a Site whose operator never runs `phis maintain`
loses nothing. The `support-requester-window` task only writes the close down for tickets nobody touches
again. The requester's answer reopens in the message write. The Site's `requester_window_days` at `0` is
the one place that switches it off.

## 13. Modules

### One conversation view, and more than one listing

The two surfaces three Modules share are the **conversation** and the **composer** -- a widget and, since
the composer became a declared Form, a Form id. The **listing** is not shared, and the tempting version of this -- one inbox holding everything a person may see -- is wrong for
a reason that only shows up at the scale a working Site has.

A Supporter may see every ticket standing in their queue's group. Put those in the same list as messages
from colleagues and the list is mostly other people's unclaimed work: fifty rows, of which five are
theirs. Worse, it is the wrong ordering. Ticket work is done by status, priority and the two clocks;
correspondence is done by recency. A single list has to pick one, and whichever it picks makes the other
kind of work harder than it was before.

So: **the inbox lists `Direct`, `Group` and `CrossGroup`.** Support threads are listed by Support's own
surfaces -- the queue view for work that is not yet anybody's, the customer widget for one's own
requests. This is not two inboxes to check, because nothing appears in both and nothing is in one by
accident: the kind decides, and the kind is already what the Site declared.

What that buys is that the listing can embody a way of working while the conversation stays identical.
A Supporter reading a customer's reply and a colleague reading a direct message are looking at the same
widget, with the same attachment rules and the same composer beneath it. Only the way they arrived
differs -- and arriving is exactly the part that should differ.

- **`@phis/ui/threads`** -- thin, first-party, like `@phis/ui/groups`: inbox, conversation, composer, the
  candidates picker. Declares `Direct`. The composer is where an attachment is offered, so it is the one
  surface both other Modules reuse for it rather than each growing its own. **The Module, its composer
  and its conversation exist**; the inbox and the candidates picker do not. It also declares the User
  Space, because a composer offering a file on a Site with no User Spaces would be offering something
  the control plane is about to refuse.

  The composer is not a widget: it is the `threads/message` Form, placed through the one generic Form
  Widget, with a hidden conversation field, a message and the shared upload field. What it is told and what
  it says are unchanged, only the shape is -- a Form cannot listen on the `thread` channel, so the Module's
  Controller sends the open conversation into that hidden field and the route names which field it is.

  The conversation widget and the composer know nothing of each other and are joined on the `thread`
  channel by that Controller. The conversation **announces** the one it has open -- after it is open, never
  before, so nothing is pointed at a thread that turned out to be absent or out of reach. A conversation it
  was *told* about it does not re-announce: whoever broadcast a selection told every listener at once, and
  an echo on a channel you also listen to is a loop. A written message produces `reload` rather than a
  second `change`, because the conversation has not changed, only its contents: `change` would put every
  listener through switching threads, which means clearing a reply somebody is halfway through. Until an inbox exists, `?thread=` on the address is what selects one -- which is also what a
  link in a notification needs, so it is not scaffolding that gets thrown away.
- **`@phis/support`** -- declares `Support` and the User Space its requesters submit into
  ([SUPPORT.md](./SUPPORT.md)); seeds its group; ticket and queue surfaces; a customer widget listing
  only the viewer's own Support threads. Reuses the thread widgets by Layout composition: its ticket
  panel -- status, queue, assignee, tasks, the two clocks, what is left of the requester's allowance --
  sits beside the conversation and learns which ticket from the same runtime signal that fills the
  composer's conversation field. One mechanism for all three Modules, and no extension point inside anybody's widget.
- **groups Module** -- group spaces; declares `Group` and, by setting, `CrossGroup`; administers the
  group flags for Core groups.
- ~~**`@phis/github` Module half** -- a link panel widget beside a ticket's conversation.~~ Built
  provider-neutral in `@phis/support` instead (§12): the linked work under the conversation, for every
  forwarding implementation at once.

## 14. The language a message is written in

**The column is built and only an integration writes it. Translating one is built too.**

### The stored fact

`thread_messages` carries the language its body is written in: `source_lang VARCHAR(8) NULL`, a locale
from `PHI_LOCALE_CAPABILITIES` in the form every other locale in this schema uses. It sits on the
message and not on the thread, because two people writing in different languages is the case it exists
for -- one language per conversation would be wrong in exactly the situation that makes it useful.

`NULL` means not declared. It is not a claim that the message is in the Site's default language, and
nothing may read it as one.

**No person is asked, and no Site route accepts it.** The obvious design -- the writer declares it in a
picker -- was built and taken out again. A translator determines the source language itself, so asking
would have put a field in front of everyone who writes for an answer that is available for nothing; and
the only thing a declared language would have bought is deciding *whether there is anything to
translate*, which pays where translating happens automatically and it never does here. It happens when
one person presses one button, and that person is the better filter.

**An integration writes it, because an integration already knows.** A mail header, the locale of the
page a form was submitted from, the browser language a chat widget saw -- these are facts that arrive
with the message and are lost if there is nowhere to put them. The write path is therefore exactly one:
`messageSourceLang` on the threads capability's `create` and `reply`. Nothing else sets it.

**A translation fills it too, and says that it did.** The language a provider recognised comes back as a
field on a translation that was paid for anyway, so throwing it away would have left the column empty for
every message a person ever wrote -- which is to say for almost all of them, since no surface declares one.
It is stored only where the column is `NULL`, and it carries `LangDetected` (32).

That flag is the difference between an assertion and a guess. An integration states the language from
something it has; a translator states what a model made of the text, which is right for a paragraph and a
coin toss for a message that says "bongo". Anything routing or counting on this column has to be able to
see which of the two it is looking at, and a flag is where that lives rather than a comment. A declared
language is never replaced by a recognised one, `updated_at` is left alone, and `Edited` is not set --
nobody changed the message.

Storing it is best effort. The reader asked to read a message; a column that did not get filled in is not a
reason to answer them with an error.

**It is also the only kind of value a filter can use.** Routing Portuguese enquiries to the people who
speak Portuguese, or counting which languages enquiries arrive in, needs a stored column: nothing that
comes into being while somebody reads can appear in a `WHERE` clause. That, rather than translation, is
the case that earns the column its place.

**It is not a translation provider's catalogue.** A provider is swapped and a language leaves its list;
the message from two years ago is still written in Portuguese. What a provider can reach decides what is
offered at translation time and never what may be stored, which is why the vocabulary is the platform
capability table and not a vendor's.

**The server stores what it is given, or refuses it.** A key the platform capability table does not
know is a 400 and not a stored `NULL`: the two say different things, and an integration sending a key
nobody recognises has a bug its author would never learn about if Core absorbed it. Aliases resolve on
the way in, so `zh-CN` is stored as `zh-Hans` and one language is one key however it arrived.

**An integration asserts, and nothing contradicts it.** Core checks that the key is well-formed, not
that it is true: an integrator writing `de` over Portuguese text misleads every reader, including a
filter that routes on it. No guard is built for this, because no Add-on delivers messages yet and a rule
nobody can break is a rule nobody can read the purpose of. It is named here so that the first one to
deliver messages is the occasion to decide, rather than the occasion to discover.

**Withheld with the body.** A `Redacted` message, and a `Confidential` one projected for an Add-on,
report `NULL` -- for the reason their assets are withheld (section 4): what a withdrawn message was
written in is still something about a message this reader may not have.

### Translating one, on request

`POST /api/site/threads/<threadId>/messages/<messageId>/translate`, with the target locale in the body,
answering the translated text, the target, and the language it came out of where anybody said so.
`GET /api/site/translation` says beforehand whether this installation translates for this Site and into
which of its locales, so a surface can decide whether the control may exist at all.

A translation of a message is a view of it. **The original always remains and nothing is persisted:**
not the translated text, not a record that it was shown.

- **Only when asked.** Never automatic, never a consequence of two languages differing, and never
  ahead of time. A Site that shows a thread shows originals.
- **One message at a time**, into one target locale the caller names. A Site surface names the reader's
  own configured language and offers no choice at the message: a translation is billed by the text sent
  whether or not anybody reads it, and a language picker on every row invites trying two more of them on
  the same paragraph. Core does not enforce that -- it accepts the locale it is given -- but it is why the
  first-party surface asks for one.
- **`Confidential` refuses.** A translation is the body leaving Core, which is the one thing that flag
  forbids (section 4). The refusal is here, not in the surface that asked: a Site fetching a body and
  posting it to a provider itself would have moved it out already, which is why the call is Core's.
- **`Internal` does not refuse**, because it answers a different question. Whoever may read the message
  may read it translated.
- **`Edited` is never set.** That flag means a person changed the message.
- **No store, no cache, no marker.** The translation machinery in
  [TRANSLATIONS.md](../TRANSLATIONS.md) exists for messages that are stored, keyed and versioned; a
  conversation body is none of those and must not enter `tr_msg`, `tr_site_msg`, or the change-marker
  path. What is shared with that contract is the provider mode and nothing above it.
- **The body sent is `body_markdown` when there is one, otherwise `body_text`.** Providers pass the
  control characters through, so the richer body costs nothing and loses nothing.
- **Nothing around the message is sent with it.** Handing the neighbouring messages to the provider as
  translator context was built here and taken out again. The measurement that argued for it -- context is
  request-wide and is not billed -- is about the bill. What nobody has measured is what a provider does
  with a context that is long and in a third language, which in a mixed thread is what the message before
  this one usually is. The field stays in the provider contract, unused from here until somebody measures
  it.
- **The CDN step never sees it.** `cdn+deepl` asks the CDN first by POSTing the text to it, which is
  right for the platform's own message catalogue and wrong for something somebody wrote an hour ago.
  Every request to the translation unit therefore states an audience, `platform` or `private`, and a
  conversation body is `private` -- required rather than defaulted, because the safe value is the one a
  caller would forget.
- **The target must be one the Site publishes in**, refused with 400 otherwise, for the reason it is not
  offered: a translation into a language the Site has no locale for is text nobody here can read
  afterwards.

Whether an installation can translate at all is the mode of [TRANSLATIONS.md](../TRANSLATIONS.md) --
for `add-on`, whether the selected provider of the `@phis/server/service/translation` kind is installed
and ready. A Site is told the answer and nothing about how it was reached, so it can decide whether to
offer the control before drawing one that cannot work.

It is deliberately not part of the capability snapshot, although an earlier note planned it there. That
snapshot carries one verdict per capability *provider* and Core's is unconditionally available, because
Core is the server answering; translation is configuration rather than interface, so folding it in would
have meant a Core entry that turns `misconfigured` and takes every unrelated first-party Module with it.

**What is given up by not persisting:** there is afterwards no record that a translation was shown, so
nothing can say what a support agent actually read. That is accepted, not overlooked.

## 15. Order

1. ~~Contracts: `threads.ts`, `PhiBaseRole.Staff`, group flags, ticket type flags and close policies,
   `resource-links:v1`, hook `verification`, `eventHandlers`.~~ Built.
2. ~~Schema sweep: threads, participants on groups, queues, ticket types, ticket messages into threads,
   `resource_links`; the predicate of section 7.~~ Built.
3. ~~Core surfaces: `/api/site/threads`, `threads:v1` recut, `resource-links:v1`, verified hooks, the
   event outbox, the snapshot fix.~~ Built.
4. ~~Modules: `@phis/ui/threads`, `@phis/support` on the new model, group flags in the groups Module.~~
   Built, and not as drawn. The conversation is the Module's one Widget; the inbox is a generic Table
   over a data provider on `/api/site/threads`, and the candidates picker an options provider on
   `/api/site/threads/candidates`, so neither is a surface of this Module's own. The composer is two
   Forms, "New conversation" and "Reply". What a Site can take apart and rearrange is the reason: a
   bespoke inbox Widget would have been a listing only this Module could place. `@phis/support` reads
   Core's threads, and `threads` and `crossGroupThreads` are editable group flags.
5. ~~Attachments: `thread_message_assets`, the delivery route, the Asset delete path, and
   `@phis/support` declaring the User Space ([SUPPORT.md](./SUPPORT.md)).~~ Built, `threads:v1`
   included, and the composer offers one: the reply Form carries the upload field.
6. `@phis/github`.
7. ~~The message language of section 14: the column, the capability that says whether this installation
   can translate, and the route that translates one message and stores nothing.~~ Built, out of order:
   it was cheap once the routes existed, and step 6 is the larger piece.

Step 7 is last because it is the only one that is worth nothing on its own. A stored language is read
by a surface offering a choice, and there is no reason to translate a message until people are writing
them in more than one language -- which is a state a Site arrives at, not one it is configured into.

Attachments come before the GitHub Add-on because that Add-on has to say what it does with a file
arriving from outside and with one leaving, and neither question can be answered while a message cannot
carry a file at all. They come after the Modules because the composer that offers one lives in
`@phis/ui/threads`.
