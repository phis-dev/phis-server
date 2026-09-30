# Notifications: Planned Design

**Status: design.** What exists is the plumbing for Core's own four mails: `sendEmail` over SMTP with a
target list as failover ([src/lib/email.ts](../src/lib/email.ts)), a closed template set with translated
lines ([src/lib/email-templates.ts](../src/lib/email-templates.ts)), per-Site sender columns
(`sites.mail_from`, `mail_from_name`, `support_email`), and an internal send route
([src/app/api/v1/email/send/route.ts](../src/app/api/v1/email/send/route.ts)) that two of the templates
reach. What does not exist: anything an Add-on may call, an outbox, retry, bulk send, a rate limit, an
unsubscribe link, the `List-Unsubscribe` headers, and bounce handling. `USER_SITE_FLAG_NEWSLETTER_OPT_IN`
is a consent bit that no line of code reads in order to send anything.

The Add-on contract that holds today is [SERVER_ADDONS.md](../SERVER_ADDONS.md), and the rule this whole
design is shaped by is in [ADDON_HOWTO.md](../ADDON_HOWTO.md) §4.

## 1. The name is not "email", and the reason is already written down

> "No PII beyond what your actor could already see. The request context carries a user *id*. A display
> name comes from `@phis/server/groups:v1`, and only for someone the acting user shares a group with; an
> email address is not on offer at all. If you need a person to receive a message, that is Core's to
> send, not yours to address."

That paragraph decides the interface before anyone designs it. A capability shaped `send(to, subject,
html)` cannot be built, because it takes an address its only possible caller is forbidden to hold. The
shape that survives the rule is:

```text
notify({ userId, occasion, params })
```

The caller names **who** and **what happened**. Core resolves the address from the id, picks the language
from the profile, renders the words, decides the route, and decides whether the person wants it at all --
the last of which only Core can answer, because only Core holds the consent bit.

So the capability is `@phis/server/notifications:v1`, not `email:v1`. Two reasons, and the second is the
one that cannot be repaired later. The caller does not know the transport and has no business knowing it:
`threads:v1` already delivers a message to a person, and a notification that arrives as a thread message
rather than as a mail is the same act performed differently. And [SERVER_ADDONS.md](../SERVER_ADDONS.md)
§13 freezes a capability name once it is public -- a redesign is only ever a new version beside the old
one. `email:v1` is the name that is wrong in two years and stays wrong.

There is a precedent for introducing it without opening it: `authentication:v1` is declared in
`PHIS_CORE_CAPABILITIES` and deliberately absent from `DELIVERABLE_CAPABILITY_ID_SET`
([src/lib/addons/core-capabilities.ts](../src/lib/addons/core-capabilities.ts)), so Core-bound Modules see
it while no Add-on receives a bound object. The same withholding is available here.

### What the capability is not

It is not a mail client. There is no `from`, no `replyTo`, no header, no attachment and no HTML on the
call, for the same reason there is no address: every one of those is a decision about how a Site speaks,
and a Site speaks with one voice whether the occasion came from Core or from an Add-on.

It is not a broadcast either. `notify` names one person. An occasion that concerns many people is many
calls, or -- for Core's own bulk case, §6 -- a run that enumerates recipients inside Core, where the
consent bit and the address already are.

## 2. The occasion, and who owns its words

Two ways to answer that, and they differ in whether Core has to know its Add-ons.

**Core declares every occasion.** Maximum control over tone and layout, and `TEMPLATE_DEFAULTS` would
grow an entry per occasion of every installed Add-on. It contradicts the premise that Core does not know
what is installed, and for a third-party Add-on it simply does not work: the text would have to be
merged into Core's source before the Add-on could be installed.

**The Add-on declares the words, Core owns the frame.** This is the chosen one. An occasion is declared
in the manifest -- subject and body lines, with the parameter list each line takes -- and Core renders it
through its own layout, its own salutation, its own footer and its own translation.

Three things make it fit rather than merely work:

- **Translation already handles foreign text.** `translateTemplateText`
  ([src/lib/email-templates.ts](../src/lib/email-templates.ts)) sends the *unparameterised* sentence
  through `translateWithCache` and substitutes the parameters into the result. Nothing in that path knows
  or cares that the sentence came from Core, so a manifest-declared line translates exactly like a Core
  one.
- **The manifest digest seals it.** Occasion text is part of the manifest and therefore part of the
  digest the dispatcher checks. The words cannot change under a running Site without a `phis addon
  reconcile`, which is the same guarantee that holds for the Add-on's routes and queries.
- **An Add-on cannot produce a mail without a footer**, because it does not write the footer. That is the
  property worth having, and it falls out of the split rather than being enforced by a review.

Core's own four templates stay where they are. `TEMPLATE_DEFAULTS` is closed for Core's mail and stays
closed; a declared occasion is a second source of words, not a way into that record.

### What an occasion may not carry

- **No address and no name.** The parameters are values about the event, not about the person. The
  salutation is Core's, resolved from the profile.
- **No absolute link outside the Site.** A link parameter is a path, and Core builds the URL on
  `site.publicBaseUrl`. An occasion that can put any URL into a Site's outgoing mail is a phishing
  primitive with the Site's own domain in the `From`.
- **No HTML.** Lines are text. Core escapes and wraps them, as `resolveEmailTemplate` already does for
  its own.

## 3. Consent is Core's answer, and the occasion has to state its class

Two classes of message, and conflating them is the mistake that both annoys people and breaks the law in
the same move:

- **Asked for.** The person's own action is the reason: a password reset, an address confirmation, an
  answer on their support ticket. No opt-in applies, and offering an unsubscribe link would be a lie --
  the same lie [design/CONSENT.md](../../phis-ui/design/CONSENT.md) documents for a consent banner over
  strictly necessary cookies, which "suggeriert, dass die Verarbeitung freiwillig ist".
- **Sent.** Somebody decided to write to people who did not ask today: a news digest. It requires the
  opt-in bit and must carry the unsubscribe link.

The class belongs on the declaration, not on the call, so that it is read from the manifest and not
argued at every call site. An occasion declared as the second class is refused by Core unless the
recipient carries `USER_SITE_FLAG_NEWSLETTER_OPT_IN`, and its rendered footer carries the link of §6. An
occasion declared as the first class gets no such footer, and Core does not consult the bit.

A declaration is a claim, and the obvious abuse is a marketing occasion declared as asked-for. Nothing
technical prevents it; what limits it is that the operator installs the Add-on and the digest of what it
declared is recorded. That is the same trust boundary [SERVER_ADDONS.md](../SERVER_ADDONS.md) §11 already
states for in-process Add-ons -- they are not a sandbox -- so this design does not pretend to a guarantee
it cannot give.

## 4. The outbox, because sending inside a request is already wrong

Today `sendEmail` runs inside the handler that decided to send. For one confirmation mail that is
acceptable. For anything else it is not: five hundred recipients in a publish request is a timeout, a
failed SMTP target is a lost message with no record, and the process is shared by every Site on the
instance.

The shape to copy is already built and is not a mail mechanism at all: `phis.addon_event_outbox`
([src/db/addon-events.ts](../src/db/addon-events.ts)) with its delivery in
[src/lib/addons/event-delivery.ts](../src/lib/addons/event-delivery.ts). A row is written in the same
transaction as the event that caused it, delivery happens afterwards, strictly in order, stopping at the
first failure for that Add-on and Site, and there are two chances to drain: the triggering request, best
effort, and the next job run.

A Core notification outbox is that, once, for every sender:

- **The row holds a recipient id, not an address.** The address is resolved when the row is drained.
  A person who corrected their address between enqueue and send is written to correctly, and a
  membership that is gone sends nothing instead of sending to a stale copy.
- **Ordering, retry and the rate limit live here**, not in `sendEmail`. What `parseSmtpTargets` does
  today is failover between targets within one attempt; it is not a retry and should not grow into one.
- **Never twice** is a property of the row, not of a mark somebody remembers to write. An attempt count
  and a next-attempt time are enough; a run that dies mid-drain repeats at most the message it was on.
- **Drained by `phis maintain`**, beside `upload-sessions` and `hook-deliveries`
  ([src/cli/maintain.mts](../src/cli/maintain.mts)), triggered by whatever already runs the operator's
  maintenance. No in-process timer: [AGENTS.md](../AGENTS.md) refuses one, and the reason is the same one
  `jobs.ts` gives -- a timer fires once per serving instance for one intended run.

## 5. What has to change in the send path

- **`EmailMessage` has no headers.** It permits `to, subject, text, html?, from?, replyTo?` and
  `sendEmailOnce` passes exactly those to nodemailer, which supports a generic `headers` field that is
  simply not plumbed. Until it is, `List-Unsubscribe` is impossible, and without it a bulk mail is filed
  as spam by the large providers regardless of what it says. `EmailMessage` appears in no contract
  document and is internal to `src/lib`, so this one is ordinary work; the outbox table beside it is not,
  because a table is documented in [DB.md](../DB.md).
- **`replyTo` beyond the contact form.** It is set in one place today. A digest should answer to
  `support_email` while sending from `mail_from`: a dead end is defensible for a system mail and unkind
  for a circular.
- **Logging stays where it is.** `logRuntimeEvent` writes JSON lines to the journal and
  [src/lib/admin-logs.ts](../src/lib/admin-logs.ts) reads them back through `journalctl`; `mail.sent` and
  `mail.failed` already exist. There is no audit table and this design does not want one -- an outbox row
  is the record while it matters, and the journal is the record afterwards.

## 6. The unsubscribe link

The house token pattern is uniform across password reset, registration and address change: 32 random
bytes as hex in the mail, only `sha256` in the database as `CHAR(64)`, bound to a Site, a TTL, and
redemption by a conditional `UPDATE ... WHERE consumed_at IS NULL` so that two simultaneous clicks settle
once. Reuse the pattern, not the table: `registration_intents` carries a state machine and a
data-minimisation step for a different purpose.

Three places where an unsubscribe token is not a reset token:

- **It must not expire quickly.** It sits in a mail in somebody's archive, and a two-hour TTL turns a
  legal obligation into a dead link. Long-lived, or unbounded -- and narrow in exchange: it clears the
  bit and does nothing else. It opens no session, shows no profile, and names no other Site.
- **`GET` must not act.** Mail clients and security scanners fetch links before a human sees them, and an
  unsubscribing `GET` unsubscribes people who never clicked. `GET` shows a page with one button; `POST`
  acts. This is the failure mode to design against, not an edge case.
- **One-click is not available, and the header says so by omission.** RFC 8058 is `List-Unsubscribe` plus
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, and it requires **the very URL in the header** to
  accept a bare `POST`. A phis Site has no such address: a Module reaches the browser through rendered
  pages and through the form gateway at `/api/site/forms`, which wants `{formId, phase, values}` as JSON,
  and the Skeleton does not gain a route per feature. So the mail carries `List-Unsubscribe` with the page
  address and nothing more -- claiming one-click without honouring it is worse than not claiming it. The
  obligation is met either way: the footer link works and the header points at it.

  What this costs is worth writing down. The large providers' bulk-sender rules ask for one-click above a
  few thousand messages a day, so a Site that grows into that will need an address that takes a bare
  `POST`. That is a door in `@phis/ui`, decided against the Skeleton contract rather than around it, and it
  is not this design's to open.

The bit lives on `user_site_memberships`, so a token that outlives the membership finds nothing to clear
and should say so plainly rather than reporting success. None of this is a consent question:
[design/CONSENT.md](../../phis-ui/design/CONSENT.md) governs access to a device, and an unsubscribe link
is Art. 21 GDPR and § 7 UWG -- an obligation, not a choice to be offered.

## 7. What this is not

- **Not an inbox.** A message a person reads inside the Site is a thread
  ([THREADS.md](./THREADS.md)), and a notification about it is not a copy of it.
- **Not bounce handling.** Nothing here reads anything back from SMTP beyond the result of the attempt.
  A bounce needs an inbound path, and there is none; a hard-bouncing address will keep being tried until
  the attempt ceiling stops it and someone looks at the journal.
- **Not one-click unsubscribe.** See section 6: the header is honest about what the Site can answer.
- **Not a marketing tool.** No segments, no click tracking, no open tracking. Named here because the
  first request after the first digest will be open rates, and a tracking pixel is access to a device
  that [design/CONSENT.md](../../phis-ui/design/CONSENT.md) would have to gate -- which would turn a
  Site that needs no banner into one that does.

## 8. Order, and what needs approval first

1. The send path: `headers` on `EmailMessage`, the outbox, a `phis maintain` drain, `replyTo`
   generalised.
2. The unsubscribe link: the token table, the `GET` page and the `POST` action, both list headers. The
   consent bit already exists.
3. `notifications:v1`: a new id in `PHIS_CORE_CAPABILITIES`, an entry in
   `DELIVERABLE_CAPABILITY_ID_SET`, a field on `PhisAddonCapabilities`, and a
   `buildPhisAddonNotificationsCapability` beside `storage-capability.ts` and `secrets-capability.ts`.

Step 3 has no consumer today -- neither `@phis/marketplace` nor `@phis/support` nor `@phis/storage-s3`
needs it. That is an argument for building it now rather than against: the same one
[design/CONSENT.md](../../phis-ui/design/CONSENT.md) makes for its own gate, that a seam is best built
while it can be tested against nothing rather than under the pressure of its first caller. But the shape
should not be designed against nothing. "A support ticket got an answer" is the nearest real occasion,
`support:v1` and `threads:v1` are both built, and designing `notify` against that one occasion is what
keeps it from being a guess.

What needs approval is narrower than the list looks. The send path itself is internal, and a maintenance
operation is a category [AGENTS.md](../AGENTS.md) keeps open. What moves a contract is the outbox table and
the token table of step 2 -- both documented in [DB.md](../DB.md) under the migration contract -- and the
capability of step 3, which is a typed surface in `@phis/contracts`. Of all of it, the capability name is
the only part that cannot be corrected afterwards.
