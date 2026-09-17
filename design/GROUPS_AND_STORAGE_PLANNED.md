# Groups and Storage: Planned Parts

**Status: design.** Nothing in this document is implemented. The contract that holds today is
[GROUPS_AND_STORAGE.md](../GROUPS_AND_STORAGE.md).

## 1. What a Space answers, and what it must not

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

## 2. Moving an Asset between Spaces

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

## 3. Audience validation at publish

Builder, Editor, and Public CMS resolution admit only Site Space Assets, so a User or Group Asset cannot be
embedded by id. Publish validation additionally rejects an Asset whose delivery audience is narrower than
the published Page audience. Promotion into the Site Space is not part of this: the Site Space is not a
transfer target (section 2 above).

## 4. Support teams on general groups

Support teams remain a Support-domain profile because routing, queues, and ticket assignment are not
generic membership properties. Their membership moves from `support_team_members` to
`site_group_members`; the Support profile references exactly one group and retains only Support-specific
state. Every effective group membership change increments the affected Site membership's
`authorization_revision`.

## 5. Signed delivery URLs

User, Group, authenticated, and internal Assets may be delivered through short-lived signed URLs as an
alternative to private proxy responses. A signed link carries the Asset's `delivery_revision`, so
incrementing the revision revokes every link issued before it. Protected responses never use shared
public immutable caching, whichever path serves them.

## 6. Storage migration job

Changing an existing Asset's Storage Profile is an explicit resumable job:

1. copy to the target Provider;
2. verify size, checksum, content type, and required metadata;
3. atomically switch the Asset or variant profile/key while preserving its id;
4. retain the old object for a bounded recovery window;
5. remove it only after successful reconciliation.

A failed migration leaves the original binding authoritative and is never reinterpreted through a Local
fallback. Folder moves, title edits, and delivery policy changes do not start Storage migration. Progress
is operator-visible.
