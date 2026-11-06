# News: Planned Design

**Status: Core reads and writes, the Module renders, and the entries translate themselves. No mail.** `phis.site_content` carries News as
content type `0` ([DB.md](../DB.md)), versioned through `site_content_versions` and translated through
`site_content_version_text` and `tr_site_msg`. Since 16.10. it is the first kind on the generic content
type path of [CONTENT.md](../CONTENT.md): `listPublishedSiteContentEntries`
([src/db/site-content-entries.ts](../src/db/site-content-entries.ts)) filters `status`, `published_at <= NOW()` and
`expires_at > NOW()` in the query; `GET /api/v1/entries/news`
([src/app/api/v1/entries/[kind]/route.ts](../src/app/api/v1/entries/[kind]/route.ts)) serves it per Site and locale behind the
internal token, and two Sites in the workspace already read it. Since 30.09. the write path of §3, the
Module of §4 and the translation path of §6 exist as well, and the editor Area has a News page
(`/editor/news`). Saves name the version they build on, Authors submit, Publishers publish a named
version (CONTENT.md). What does not exist: any mail. `scripts/seed-site-news.mjs` is gone -- it hard-coded two Site keys and had stopped working
when the content enums became `SMALLINT`, which nothing noticed because nothing ran it.

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

`meta` carries `linkTarget` and `tags`, and `sort_order` breaks ties within a day. The link is a stored
target (REFERENCES.md) -- a Page by its reference or an explicit external address, never a typed path --
answered to readers as `link`. A Page target that names no Area is a Public Page, and every save replaces
the entry's row in `site_cms_references`, so a linked Page is guarded like one a Widget links to.

One interaction is worth knowing before it is discovered. A Public page is rendered once for everybody and
kept under an address that joins the Site's `readMarker` with the translation markers
([phis-ui gateway/CACHES.md](https://github.com/phis-dev/phis-ui/blob/main/gateway/CACHES.md)). A publish moves that marker and is seen
within the config refresh. **An expiry moves no marker**, because nothing was written. The expired entry
therefore leaves a cached Public page with the next render, which `revalidate = 60` guarantees within a
minute. A minute is acceptable; discovering it later, while debugging, is not.

## 3. The write path

**Built.** `GET`, `PUT` and `DELETE` on
[/api/site/editor/entries/news](../src/app/api/site/editor/entries/[kind]/route.ts) are the words; `POST` and `DELETE` on
[/api/site/editor/entries/news/publish](../src/app/api/site/editor/entries/[kind]/publish/route.ts) are the publication.
Underneath, `saveSiteContentNewsDraft`, `publishSiteContentNews`, `withdrawSiteContentNews`,
`deleteSiteContentNews` and `listSiteContentNewsForEditor` in
[src/db/site-content.ts](../src/db/site-content.ts). Three things the writing settled, which the plan
below had left open:

- **A delete needs a withdrawal first.** Taking something off a Site is the publishing authority's act,
  and a delete that did it too would be that act reachable by whoever may only draft.
- **An authored address is not a generated one.** The widget-owned types resolve a slug collision with
  `DO UPDATE`, because their slug is generated and a collision means the same row. A News slug is the
  entry's public address, so a collision is reported (`409`) rather than silently editing somebody's entry.
- **The editor reads the Site's source locale, never a requested one.** The form writes source text; a
  translated title in it would be written back over the original on the next save. Translating a News
  entry stays the translations editor's work on the same messages.
- **One `PUT` is the save**, whether the entry exists yet or not: with a `contentId` it is that entry,
  without one it is a new entry at the slug it names. There is no second method for creating, because a Form
  binds one handler and one path -- two would mean two Forms and two dialogs for one act.
- **A save states the whole entry**, which is why it is a `PUT` and not a `PATCH`. A version is a complete set of
  words rather than a patch on the last one, and `link`, `tags` and `sortOrder` follow the same rule -- one
  call with two meanings is how a save that corrected a title dropped the entry's link, which is what the
  measurement against the dev stand showed. The address is the exception: an entry must have a slug, so a
  save that names none keeps the one it has.

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

**Built** on 30.09., in `phis-ui/plugins/runtime-modules/news`: the descriptor of §4, the page preset
`phi-default-pub-news-page-tree.ts`, one Widget (`news-list`) and the gateway read `gateway/news.ts`. Three
things the building settled:

- **A new Module is not on.** `/news` answered `404` until the Site activated `@phis/ui/modules/news` for
  its Public Area and published that selection. That is the intended behaviour and worth stating here,
  because the first reading of that `404` was that something was broken.
- **The list is a Client half, like every other visual Widget.** The Controls are where antd lives and a
  server component cannot use them, so the Widget reads in its server half and hands the entries to a
  Client one. Nothing there depends on the viewer, so the first paint carries every entry.
- **The date is formatted on the server.** In the browser `Intl` would use the visitor's locale, and in a
  static render the server's; neither is the page's language.

**First-party, in `phis-ui/plugins/runtime-modules/news`,** not a separate package. Only `@phis/ui` is in
the Site's `transpilePackages`, so a first-party Module is picked up through the workspace symlink with no
build step, while a package would need `pnpm build` after every edit. Moving it out later is a packaging
decision and does not change the code.

**The address and the navigation entry are one descriptor.** `presets.ts` states the route and, beside it,
a navigation entry with `navKey: "public:header"` -- exactly what the auth Module does for `/register`
([phis-ui plugins/runtime-modules/auth/presets.ts](https://github.com/phis-dev/phis-ui/blob/main/plugins/runtime-modules/auth/presets.ts)).
Nothing is seeded: the entry is computed per request from the compiled catalog once the Module is active
for the Area and published. A Site may rename, reorder or tombstone it through the `site_nav_scopes`
overlay, and may not hide a computed entry -- which is the rule that keeps a Module's address reachable.

**`/news` only.** No detail address in this version. [phis-ui MODULES.md](https://github.com/phis-dev/phis-ui/blob/main/MODULES.md) permits
one whole-segment parameter and names `/news/:id` as its example, and the slug is already on the row, so
adding `/news/<slug>` later costs a descriptor and no data change.

**No dismissal and no banner.** A page is a place one goes to, and it needs no per-visitor state at all --
which is the whole reason this version is a page. If a dismissible strip is ever wanted it is two things
that are not this document's: stage 2 of [design/CONSENT.md](https://github.com/phis-dev/phis-ui/blob/main/design/CONSENT.md), the notice
that asks nothing and blocks nothing, and the `marker` shape of
[design/USER_STATE.md](https://github.com/phis-dev/phis-ui/blob/main/design/USER_STATE.md), which already names a read news list as its
case. On a Public page, with anonymous visitors and one render for everybody, neither is free; a signed-in
Area is where that becomes cheap.

**The read is a gateway read.** `/api/v1/entries/news` requires the internal token, so the page is rendered from a
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

## 6. Languages: written in one, read in any

A **Markdown body is the standard**, and the reason is not that DeepL treats its control characters
gently -- it is that they never reach a provider. The Markdown Widget parses first and hands over only the
inline content of headings, paragraphs and table cells, as HTML with tag handling; structure, code fences
and raw HTML are skipped by construction (`collectMarkdownTranslationUnits`). A body translated as plain
text would have its code fences translated as prose.

**An author writes in their own language and says so.** A save states two things about its words, which
live in the version's `meta` because a later version may be written in another language: `sourceLocale`
and `translate`. A save that states no language stores the Site's source language, so every version says
what it was written in. A save translates nothing.

**Translation is pulled, never pushed.** The first read in a language that has nothing yet asks for one and
caches it; every reader after that reads the cache. A draft is never read publicly and so costs nothing,
which is also what makes checking possible: **checking is reading.** An entry previewed in a language is an
entry translated into it.

**An entry in another language than the Site's own takes the external route**, the one external Markdown has
always taken: translated into the Site's language once and kept as its own message, the original kept as
the answer for its own language, every further language derived from the canonical one. Title and subtitle
go field by field through `GET /api/v1/entries/news`; the body goes paragraph by paragraph where it is rendered, so
correcting one paragraph costs one paragraph.

**Nothing is ever invalidated.** A corrected text is a different message row, because a message's identity
is its hash, so the old translations are simply never consulted again. The price is orphaned rows, which
`phis maintain` is the place to sweep.

**Tags translate like everything else, and need nothing of their own.** A tag is a plain string in the
content row's `meta`, not a field of a version -- and it does not have to be: the translator ensures a
message for whatever it is handed, so a tag becomes one the first time somebody reads it in another
language. It travels with the fields under its own context, `news tag`, which is also the only hint a
provider gets for a single word. Two entries carrying the same tag share that one message, which is why
that context must stay a phrase and never name an entry.

Because the string is the tag's identity -- there is no row and no id behind it -- it is **trimmed and
lower-cased on the way in** (`normalizePhiNewsTag`). Otherwise "Release" and "release" would be two tags
with two translations to pay for. What follows from the same choice: renaming a tag means rewriting the
entries that carry it, and the offer an author picks from is the set of tags the Site already uses, which a
single `DISTINCT` over `meta` answers. A curated vocabulary with its own rows would buy identity under
renaming and nothing else; it is not needed for translating.

One thing is worth stating before it surprises somebody: a **stand-in** -- source text handed back because a
provider failed -- is marked `provisional` and must not be kept, which is why that answer carries
`no-store`.

## 7. What this is not

- **Not a blog.** One list, one entry shape, no categories, no authors as a public fact, no comments.
- **Not a Page per article.** Entries are content rows, not `site_page_scopes` rows, and nothing seeds
  Pages -- Site Pages are authored in Builder and no install path creates them.
- **Not platform-wide news.** `site_content.site_id` is `NOT NULL`. The asymmetry where the operator
  writes and a Site only reads exists for the Add-on catalogue (`server_addons` against
  `site_server_addons`) and has no counterpart for content. A vendor channel into every Site is a
  different store and a different document, and folding it in here would make both wrong.

## 8. Order

1. ~~The Core write path of §3, draft and publish.~~ Built on 30.09., with the editor surface still to
   come in the shared UI.
2. ~~The Module of §4: descriptor, page, widgets.~~ Built on 30.09.
3. ~~The languages of §6.~~ Built on 30.09.
4. The editor surface: a page in the editor Area, the list of entries, and a preview per language -- which
   is where the canonical wording of a foreign-language entry is read and, if it is wrong, adopted as the
   source text by saving it again.
5. The digest of §5, after [NOTIFICATIONS.md](./NOTIFICATIONS.md) steps 1 and 2.

Only step 1 touches a contract surface in this repository; §4 is ordinary Module work in `@phis/ui`, and
§5 is a consumer of something that does not exist yet.
