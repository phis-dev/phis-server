# News: Planned Design

**Status: the read path is built and nothing writes it.** `phis.site_content` carries News as content
type `0` ([DB.md](../DB.md)), versioned through `site_content_versions` and translated through
`site_content_version_text` and `tr_site_msg`; `listPublishedNews`
([src/db/site-content.ts](../src/db/site-content.ts)) filters `status`, `published_at <= NOW()` and
`expires_at > NOW()` in the query; `GET /api/v1/news`
([src/app/api/v1/news/route.ts](../src/app/api/v1/news/route.ts)) serves it per Site and locale behind the
internal token, and two Sites in the workspace already read it. What does not exist: any write path other
than `scripts/seed-site-news.mjs`, which hard-codes two Site keys; an editor surface; a Module; a Page; a
navigation entry; and any mail.

The mail half is [NOTIFICATIONS.md](./NOTIFICATIONS.md) and this document does not repeat it.

## 1. News is Core, and the Module is only its face

The decision is that the rows stay where they are and a Module contributes the address, the page and the
widgets. The alternative -- an Add-on with its own `phis_addon_*` schema and its own article table -- was
weighed and refused, for three reasons in ascending order of weight.

It cannot write the Core table anyway. Every capability is bound to `{addonId, siteId}` and an Add-on
schema is its own; that single rule is what makes purge and uninstall answerable
([ADDONS_PLANNED.md](./ADDONS_PLANNED.md) states it for the shared-schema case), so an Add-on wanting
Core's rows is not a permission problem but a different design.

It would rebuild what already works: versioning, the translatable-message path, the publish state, the
schedule and the expiry. And it would leave two live consumers reading a table the new truth is not in --
a second news store beside a working one, which is precisely the parallel path this repository refuses
before v1.

What follows from that split: **the Module owns no data.** It renders what Core answers, and every
question about who may write, what a version is and when an entry disappears is Core's.

## 2. What the schema already answers

Two of the questions that usually need machinery need none here:

- **Scheduling.** `published_at <= NOW()` is in the read. An entry with a future date is written, saved
  and simply not answered yet. Nothing has to run at the appointed minute.
- **Expiry.** `expires_at IS NULL OR expires_at > NOW()` likewise. An expired entry leaves the answer
  without anything changing a status. This is the maintenance contract of [AGENTS.md](../AGENTS.md) --
  the reader corrects lazily, there is no background timer -- applied to content rather than to leases.

`meta` carries `link` and `tags`, and `sort_order` breaks ties within a day.

One interaction is worth knowing before it is discovered. A Public page is rendered once for everybody and
kept under an address that joins the Site's `readMarker` with the translation markers
([phis-ui gateway/CACHES.md](../../phis-ui/gateway/CACHES.md)). A publish moves that marker and is seen
within the config refresh. **An expiry moves no marker**, because nothing was written. The expired entry
therefore leaves a cached Public page with the next render, which `revalidate = 60` guarantees within a
minute. A minute is acceptable; discovering it later, while debugging, is not.

## 3. The missing write path

Mirror the Page pattern rather than inventing one. [src/lib/site-cms-write-route.ts](../src/lib/site-cms-write-route.ts)
already draws the line that fits:

- **Draft** behind `requireSiteAuthorApiContext` -- `PHI_ACCESS_CONTENT_EDITING`, which is
  `Developer | Author | Publisher` ([src/lib/authorization.ts](../src/lib/authorization.ts)).
- **Publish** behind `requireSitePublisherApiContext` -- `PHI_ACCESS_PUBLISHING`, which is
  `Developer | Publisher`.

Core Admin passes both by the override in `canPhiAccessSubjectReach`. No new Core role is invented:
[AUTHORIZATION.md](../AUTHORIZATION.md) reserves Core role flags to Admin and `phis site admin`, and a
subject domain is not a reason to add one.

The surface belongs in the **editor** Area, beside `editor/page-meta` and `editor/translations`, because
that is where the Area policy already matches content editing. Text enters through the same translatable
message path the other content types use, so a News entry is translated by the machinery that translates
everything else rather than by a second one.

## 4. The Module: one address, one page

**First-party, in `phis-ui/plugins/runtime-modules/news`,** not a separate package. Only `@phis/ui` is in
the Site's `transpilePackages`, so a first-party Module is picked up through the workspace symlink with no
build step, while a package would need `pnpm build` after every edit. Moving it out later is a packaging
decision and does not change the code.

**The address and the navigation entry are one descriptor.** `presets.ts` states the route and, beside it,
a navigation entry with `navKey: "public:header"` -- exactly what the auth Module does for `/register`
([phis-ui plugins/runtime-modules/auth/presets.ts](../../phis-ui/plugins/runtime-modules/auth/presets.ts)).
Nothing is seeded: the entry is computed per request from the compiled catalog once the Module is active
for the Area and published. A Site may rename, reorder or tombstone it through the `site_nav_scopes`
overlay, and may not hide a computed entry -- which is the rule that keeps a Module's address reachable.

**`/news` only.** No detail address in this version. [phis-ui MODULES.md](../../phis-ui/MODULES.md) permits
one whole-segment parameter and names `/news/:id` as its example, and the slug is already on the row, so
adding `/news/<slug>` later costs a descriptor and no data change.

**No dismissal and no banner.** A page is a place one goes to, and it needs no per-visitor state at all --
which is the whole reason this version is a page. If a dismissible strip is ever wanted it is two things
that are not this document's: stage 2 of [design/CONSENT.md](../../phis-ui/design/CONSENT.md), the notice
that asks nothing and blocks nothing, and the `marker` shape of
[design/USER_STATE.md](../../phis-ui/design/USER_STATE.md), which already names a read news list as its
case. On a Public page, with anonymous visitors and one render for everybody, neither is free; a signed-in
Area is where that becomes cheap.

**The read is a gateway read.** `/api/v1/news` requires the internal token, so the page is rendered from a
server-side read and not from a browser fetch. That is also what lets an entry be absent from the HTML
rather than appear and vanish.

## 5. The digest, and why it is not in this document

A circular about new entries is a notification, and everything that makes it possible is in
[NOTIFICATIONS.md](./NOTIFICATIONS.md): the outbox, the unsubscribe link, the `List-Unsubscribe` headers.
Four things are this document's, though:

- It is a **sent** message, not an asked-for one. It requires `USER_SITE_FLAG_NEWSLETTER_OPT_IN` and its
  footer carries the unsubscribe link.
- Recipients are the memberships carrying that bit. Addresses are resolved when the outbox row is drained,
  never enumerated into it.
- **Never twice** is the outbox row, not a mark in `site_content.meta`. A mark on the content row would
  make the entry's data remember a sending run, and two runs against one entry would race over it.
- Who may send is `PHI_ACCESS_PUBLISHING`, the same policy as publishing. Sending to an audience is
  publishing to a second one, and it should not be reachable by someone who may only draft.

The **page** depends on none of this and can be built first.

## 6. What this is not

- **Not a blog.** One list, one entry shape, no categories, no authors as a public fact, no comments.
- **Not a Page per article.** Entries are content rows, not `site_page_scopes` rows, and nothing seeds
  Pages -- Site Pages are authored in Builder and no install path creates them.
- **Not platform-wide news.** `site_content.site_id` is `NOT NULL`. The asymmetry where the operator
  writes and a Site only reads exists for the Add-on catalogue (`server_addons` against
  `site_server_addons`) and has no counterpart for content. A vendor channel into every Site is a
  different store and a different document, and folding it in here would make both wrong.

## 7. Order

1. The Core write path of §3, draft and publish, with the editor surface.
2. The Module of §4: descriptor, page, widgets.
3. The digest of §5, after [NOTIFICATIONS.md](./NOTIFICATIONS.md) steps 1 and 2.

Only step 1 touches a contract surface in this repository; §4 is ordinary Module work in `@phis/ui`, and
§5 is a consumer of something that does not exist yet.
