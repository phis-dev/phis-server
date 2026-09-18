# Support: Planned Design

**Status: the workflow exists, the way in does not.** `support_tickets`, `support_ticket_types`,
`support_queues`, `support_ticket_tasks` and their events are in the schema; the routes under
`/api/site/support` open, read, assign and work tickets; `@phis/support` reads the Core threads of
[THREADS.md](./THREADS.md). What is described here and is **not** built is everything a person who is
not Staff needs in order to ask for help at all, the administration of the queues and types that
answering requires, and attachments on a submission.

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

## 2. There is no way in

Every route under `/api/site/support` is behind `requireSiteSupportApiContext`, which is
`Developer | Supporter`, widened to Admin. `POST /api/site/support/tickets` -- the one call that opens a
ticket -- is among them, and it requires a `typeId` that no route hands out: there is no types listing
anywhere.

So today a customer cannot open a ticket, and if they could they would have nothing to name. Three
things are missing, and they are not independent.

### A route for the person asking

A requester route is not the Supporter route with a softer guard. It takes a subject, a first message,
a type, and nothing else -- no queue, no priority, no assignee, no severity. Those are answers about how
the work will be run, and letting the person asking write them would let them jump their own ticket.

Who may call it is the Site's ordinary authenticated session. `support_tickets.requester_user_id` is
nullable beside `requester_email` because a ticket also arrives from an address or from an integration,
and `channel` records which of the three it was; those two paths do not come through this route.

### Which types a requester may see

`PhisSupportTicketTypeFlag` carries `External` and `CodeChange` today, and both describe what happens to
the work rather than who may ask for it. A listing filtered by neither would offer a requester a type
whose conversation is mirrored into a repository, chosen by someone with no way to know that.

A third flag says it: a type is offered to requesters, or it is not. Default off, so a Site that adds a
type gets a Staff-only one until it says otherwise -- the same default-deny shape
`site_media_config.flags` uses, for the same reason.

`External` then becomes a thing the route has to say out loud. Where a requestable type mirrors
outward, the person must be told before they write rather than after, and what still never leaves is
already fixed in [THREADS.md](./THREADS.md) section 4: internal notes, confidential messages, system
messages, and whatever arrived from the integration to begin with.

### Which queue it lands in

Nothing, because `PhisSupportQueueFlag.Entry` has already decided it. A requester never names a queue;
work with no queue named lands in the Entry queue, and a Site with no Entry queue refuses the ticket
rather than dropping it wherever the first row happens to be. The requester route therefore takes no
`queueId` at all, and the one failure it can have for that reason is a Site that has not finished
setting itself up.

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

## 4. Queues and types have no administration and no seed

Nothing writes `support_queues` or `support_ticket_types`. There is no route, no CLI command, and no
seeding when the Module is activated, so a Site that installs Support has no type to open a ticket with
and no Entry queue to route it to. The Supporter path fails on that today as surely as the requester
path would.

What a Site needs on activation is small and has to be exact: one queue, marked `Entry`, and the group
it routes to; one ticket type, not requestable. Everything past that is administration -- and it is
Site administration rather than a group operation, because a queue names a group and creating groups is
`Developer | Admin` ([GROUPS_AND_STORAGE.md](../GROUPS_AND_STORAGE.md) section 6).

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

## 5. Order

1. The declared seed and its materialization, the administration of queues and ticket types, and the
   requestable flag in the contract.
2. The types listing and the requester route, with the `External` notice.
3. Attachments on a submission, once [THREADS.md](./THREADS.md) section 5 is built.
4. Custody transfer on acceptance into a queue.

Step 1 is first because both of the others fail without it, and it is the step that turns a Site with
the Module switched on into a Site that can answer anybody.
