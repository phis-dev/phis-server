# Support: Planned Design

**Status: the way in exists; what a requester may bring with it does not.** `support_tickets`,
`support_ticket_types`, `support_queues`, `support_ticket_tasks` and their events are in the schema; the
routes under `/api/site/support` open, read, assign and work tickets; `@phis/support` reads the Core
threads of [THREADS.md](./THREADS.md). The declared seed of section 4 is built: a Site that publishes an
Area running `@phis/support` now gets its group, its entry queue and one ticket type; section 4's routes
administer both from there; and section 2's requester route and type listing are the way in. Section 5's
allowance is built too: a Site can say how many requests one person gets per period, and `support:v1`
lets another Add-on hand somebody more. What is described here and is **not** built is attachments on a
submission and the custody transfer that follows one.

This document is Support's half. The conversation is not in it: a ticket's messages are a Core thread,
and who reads them, what an attachment is, and how it is delivered are settled in
[THREADS.md](./THREADS.md).

## 1. What Support owns

A ticket is the work around a conversation, never the conversation. Support owns the type, the queue,
the assignee, the tasks, the status ladder and the two clocks; the thread beneath it belongs to Core and
is reached the same way every other thread is.

That split is why `@phis/support` binds `threads:v1` and `resource-links:v1` and holds no message table
of its own. It is also why this document can be short: what Support adds to a conversation is who is
responsible for it and when it is done.

## 2. The way in

Every route under `/api/site/support` used to be behind `requireSiteSupportApiContext`, which is
`Developer | Supporter`, widened to Admin. `POST /api/site/support/tickets` -- the one call that opened a
ticket -- was among them, and it required a `typeId` that no route handed out: there was no types listing
anywhere. A customer could not open a ticket, and if they could they would have had nothing to name.

`GET /api/site/support/request/types` and `POST /api/site/support/request` are that way in, behind the
Site's ordinary session. Three things had to be settled together, and they were not independent.

### A route for the person asking

A requester route is not the Supporter route with a softer guard. `POST /api/site/support/request` takes
a subject, a first message, a type, and nothing else -- no queue, no priority, no assignee, no severity.
Those are answers about how the work will be run, and letting the person asking write them would let
them jump their own ticket.

Who may call it is the Site's ordinary authenticated session. `support_tickets.requester_user_id` is
nullable beside `requester_email` because a ticket also arrives from an address or from an integration,
and `channel` records which of the three it was; those two paths do not come through this route.

### Which types a requester may see

`External` and `CodeChange` describe what happens to the work rather than who may ask for it. A listing
filtered by neither would offer a requester a type whose conversation is mirrored into a repository,
chosen by someone with no way to know that.

`PhisSupportTicketTypeFlag.Requestable` says it, and is built: a type is offered to requesters, or it is
not. Default off, so a Site that adds a type gets a Staff-only one until it says otherwise -- the same
default-deny shape `site_media_config.flags` uses, for the same reason. `PATCH
/api/site/support/ticket-types/{typeId}` is where a Site turns it on, and that route is the looking-at
which the default assumes has not happened. What is still missing is the listing a requester reads: the
one under `/api/site/support/ticket-types` is the Staff catalogue, behind the Supporter role, and shows
every type.

`External` then becomes a thing the route has to say out loud. Where a requestable type mirrors
outward, the person must be told before they write rather than after, and what still never leaves is
already fixed in [THREADS.md](./THREADS.md) section 4: internal notes, confidential messages, system
messages, and whatever arrived from the integration to begin with.

So the listing carries `external` per type, and the request route refuses an `External` type that
arrives without an acknowledgement, recording it as `PhisThreadParticipantFlag.ExternalConsent` on the
requester's participant row. The consent belongs to the moment they wrote: a ticket opened without it
would leave the integration of [THREADS.md](./THREADS.md) section 12 chasing somebody afterwards for
permission they were never asked for. The exact wording the notice uses follows the linked repository's
visibility and is that section's, not this one's.

### Which queue it lands in

Nothing, because `PhisSupportQueueFlag.Entry` has already decided it. A requester never names a queue;
work with no queue named lands in the Entry queue, and a Site with no Entry queue refuses the ticket
rather than dropping it wherever the first row happens to be. The requester route therefore takes no
`queueId` at all, and the one failure it can have for that reason -- a Site that has not finished
setting itself up -- answers 503 and says so, because the person asking can do nothing about it.

A type the Site does not offer a requester is treated as absent rather than forbidden. Answering "not
this one" would tell whoever asked that a Staff-only type exists and what it is called.

## 3. What a requester attaches, and who pays for it

[THREADS.md](./THREADS.md) section 5 settles what an attachment is and who may read one. What is
Support's here is that its requesters are the case that forces a Space to exist.

A requester is not a member of the queue's group, let alone an Author in it, and the Site Space belongs
to the people who publish the Site. Their own User Space is the only place on the Site they may write.
So `@phis/support` declares it:

```text
mediaSpaces: { user: { kinds: ["image", "video", "pdf", "markdown", "document", "archive"] } }
```

A screenshot, a recording of the fault, a log -- `text/plain` resolves to `document` -- and a zip of
several. `audio` is left out because a recording with no picture is not a support artifact, and `binary`
for the reason the groups Module leaves it out.

A declaration is a need and not a switch: what it makes available is User Spaces on that Site, for
everything, bounded by `default_user_quota_bytes` and not by the purpose that asked for them. That is
the mechanism working as designed -- availability is per Space kind and the union across Modules -- and
it is worth stating plainly rather than discovering: **a Site that runs Support gives every one of its
users a personal Media Space.**

### The occasion that takes custody

A submission is the submitter's until something accepts it. For Support the occasion is the ticket
being taken into a queue, and the target is that queue's group -- `support_queues.group_id` is `NOT
NULL`, so there is always exactly one and no rule has to choose. It moves rather than copies: a record
taken into custody does not need to stay behind in two places.

`support_tickets.queue_id` is nullable, and a ticket in triage therefore has no target yet. That is not
a gap to close. Until the ticket is somewhere, nobody but the submitter has taken responsibility for it,
and the bytes sitting on the submitter's own quota is exactly what that state means.

None of this is built: it is
[GROUPS_AND_STORAGE_PLANNED.md](./GROUPS_AND_STORAGE_PLANNED.md) section 2, and Support is its first
caller. Attachments do not wait for it -- [THREADS.md](./THREADS.md) section 5 explains why the audience
is unaffected either way.

## 4. Queues and types, and how a Site administers them

A Site used to install Support and have no type to open a ticket with and no Entry queue to route it
to: nothing wrote `support_queues` or `support_ticket_types` at all, and the Supporter path failed on
that as surely as the requester path would have.

What a Site needs is small and has to be exact -- one queue marked `Entry` and the group it routes to,
one ticket type, not requestable -- and it is a declared seed, materialized on publish
(`src/db/module-seeds.ts`, and the rules below). Everything past that is administration, and it is
built: `POST`/`PATCH` under `/api/site/support/queues` and `/api/site/support/ticket-types`, behind
`Developer | Admin` rather than the Supporter role the listings use, because a queue names a group and
creating groups is Site administration
([GROUPS_AND_STORAGE.md](../GROUPS_AND_STORAGE.md) section 6). There is no CLI command, and no
administration surface in `@phis/support` yet.

Three rules hold that administration together, and each is the seed's consequence. **A key is never
edited**: it is what the seed finds its own rows by, so changing one would not rename a row, it would
make the next publish create a second one beside it. **Nothing is deleted**, only retired, because
tickets standing in a queue or opened under a type keep naming it. And **a Site cannot administer away
its own way in**: the `Entry` mark moves between queues in one statement and cannot simply be cleared,
since a Site without one refuses every ticket that names no queue -- which is every ticket a requester
opens.

A queue owns routing and never membership. Who is in the group a queue routes to is answered by the
group surfaces, which already exist.

### A seed is not a third `mediaSpaces`

Two declarations of that shape exist -- `mediaSpaces` and `threadKinds` -- and the temptation is to read
a seed as the next one. It is not. Both of those are **availability**: the Site's is the union across its
active Modules, two Modules declaring the same thing do not collide, and a declaration withdrawn hides
what it offered without deleting anything. Publish recomputes them from the union every time, and that is
safe precisely because there is nothing there to lose.

A queue and a ticket type are rows with identity, and tickets point at them. None of the three holds:
two Modules asking for "an Entry queue" cannot be merged into one, a second publish must not produce a
second queue, and deactivating Support must not take a queue that open tickets are routed through. So a
seed is its own kind of declaration, and it has its own rules.

**Keyed, not unioned.** Each seeded row is named by a stable key the Module writes, and the schema is
already built for it: `support_queues` and `support_ticket_types` both carry `UNIQUE (site_id, key)`,
and `site_groups` carries `UNIQUE (site_id, provider_id, key)` -- where `provider_id` is the Module that
asked for the group, in the `@scope/name` form its CHECK constraint requires.

**Created when absent, and never rewritten.** This is what makes it safe to run on every publish. The
alternative takes an administrator's rename or re-flag away again at the next one, which is the opposite
of administration. A Site that has been set up keeps what it decided.

**Never deleted.** A Module that stops being active stops offering its surfaces, exactly as a withdrawn
`threadKind` does. The rows stay, because tickets are pointed at them and because `support_queues` has
deliberately no cascade from its group. `site_groups` already answers this with `retired_at` -- "the row
and its key stay, and a retired group grants nothing" -- and queues and types need the same rather than a
delete path. That is the one schema consequence of all this.

**Declared as data, not as a callback.** A Module states its seed as a literal beside `mediaSpaces`, and
the control plane reads it. A function the control plane calls would put Module code in the publish path
and make a seed unreadable before it has run. The group comes with it: `support_queues.group_id` is
`NOT NULL`, so what Support declares is a small graph -- a group named by its key, and a queue naming
that key -- and the order is the materializer's to resolve, not the Module's to script.

**Materialized where availability is.** The same publish pass that writes `site_media_config`, in Core.
Not in the Site: a Site's route files and scripts are written when it is installed and belong to the
installation from then on. And seed-once-then-authoritative is not a new idea here --
[GROUPS_AND_STORAGE.md](../GROUPS_AND_STORAGE.md) section 7 already says it of the Media configuration
row, which installation configuration seeds exactly once and is never consulted for again.

## 5. How much one person may ask for

A Site that answers everybody answers some people more than it can afford to. The limit is the Site's to
set, and the exception to it is by design not the Site's to know: whether a customer paid for ten more
lives in whatever sold them, which is another package entirely. So what Support holds is the arithmetic,
and `support:v1` is where somebody else moves the number.

### Two numbers that are not the same kind of thing

**The periodic allowance** sits on the ticket type -- `requester_allowance` and
`requester_allowance_period` -- and is what everybody gets. It renews at the calendar boundary and what
goes unused is gone. It is `NULL` until a Site says otherwise, which is the opposite default from
`Requestable` and for a reason that does not contradict it: a flag that is off offers nothing, where a
limit that arrived by default would refuse people on a Site that never asked for one.

**A grant** is a stock handed to one person: `support_allowance_grants`, with an amount, a `consumed`
counter, an optional expiry and the provider that made it. It does not renew, and it is not lost at the
boundary.

A ticket spends the periodic allowance first and reaches the stock only when that is empty. The other
order is the one that looks equivalent and is not: it would spend somebody's ten in a month the free five
would have covered, and they would find them gone without having asked for anything unusual.

The period is a calendar month or a calendar year, not a rolling window of days -- unlike
`requester_window_days`, the other clock on the same table. That one measures a single ticket's silence
and rightly starts when the ticket does. This is a budget, and a budget somebody can plan around is one
whose start they can name: "five this year" is a sentence, "five in any three hundred and sixty-five
days" is an audit.

### The limit is per type, and that is the statement

There is no Site-wide total. A Site with three requestable types, each allowing five, has given each
person fifteen -- five of each, which is what it said. This is worth stating rather than discovering,
because the alternative reading ("five requests, of whatever kind") is the one people assume. A Site that
means one budget across everything offers one requestable type; a Site that offers three is making three
separate promises.

The grant names a type for the same reason. A grant that named none would be a number with nothing to add
it to, and which types it counted against would be a question first asked by whoever was refused.

### What counts, and what cannot be stopped by it

Only what the person opened for themselves: `channel = PORTAL` and `requester_user_id` theirs. A
Supporter opening a ticket on somebody's behalf is a decision taken by somebody entitled to take it, so
it neither spends that person's budget nor can be refused for want of it. Without that line the budget
would be spendable by Staff and unspendable by the person it belongs to.

Consumption happens inside the transaction that opens the ticket, before the thread exists: refusing
afterwards would leave a conversation nobody can reach behind every refusal. It is serialized per person
and type with a transaction-scoped advisory lock, because the count and the spend are two statements and
two requests arriving together would otherwise both read four-of-five and both pass.

`support_tickets.allowance_grant_id` records which stock a ticket came out of, or `NULL` for the periodic
allowance. Not a flag: the id is what lets whoever sold the stock say which requests their customer spent
it on, and "was this a paid one" falls out of the same column.

### What the interface is, and the one thing it breaks

`support:v1` gains `allowance`, `grant` and `revokeGrant`. Granting is idempotent on the granter's own
`reference` -- a payment provider retries its webhook, and a shop with no reference to give would hand
over the ten twice and never notice. Revoking stops the unspent remainder and leaves the tickets already
opened against it standing, because a payment reversed later does not un-have a conversation.

These three name a person, which nothing else on that capability does: its whole doctrine is that an
Add-on reaches what it was given and never walks a Site's records. The doctrine is not bent here, it
simply has nothing to answer with -- the allowance is about somebody before there is any ticket to be
linked to. The bound is the one `groups:v1` already uses for the same unavoidable reason: the person must
be a member of this Site, and an unverified hook reaches none of it. What that leaves an Add-on able to
do is give a member of its own Site something, which is what the Site installed it to do.

What a requester may still ask for is carried on `GET /api/site/support/request/types`, per type,
computed by the same function the refusal uses. Two copies of that arithmetic is how somebody is told
they have one left and then turned away.

## 6. Order

1. ~~The declared seed and its materialization, the administration of queues and ticket types, and the
   requestable flag in the contract.~~ Built, apart from a surface in `@phis/support` to drive it.
2. ~~The types listing and the requester route, with the `External` notice.~~ Built.
3. ~~The allowance, and the three calls on `support:v1` that let somebody else hand over more.~~ Built.
4. Attachments on a submission, once [THREADS.md](./THREADS.md) section 5 is built.
5. Custody transfer on acceptance into a queue.

Step 1 was first because both of the others fail without it, and its seeded half is what turns a Site
with the Module switched on into a Site that can answer anybody at all. Step 3 could come before the
attachments because it is about who may ask rather than about what they may bring. What remains is steps
4 and 5, and both wait on [THREADS.md](./THREADS.md) section 5.

Nothing in any of this has a surface. Setting a limit, handing somebody a stock and seeing what one has
left are all HTTP, as the queue and type administration is: `@phis/support` still has no administration
screen, and no Module shows a requester their remaining count. The listing carries it so that a surface
can, when one exists.
