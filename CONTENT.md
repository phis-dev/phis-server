# Content Contract

This document defines how a Site's content -- the words and pictures on its Pages and Areas, and the
entries of its content types -- is written, held back and published, apart from the structure that
places it.

## Two authorities

A Page or an Area is two things that are published apart:

- **Structure** is the revision tree: layouts, widgets, their placement and their configuration. A
  Builder writes it as a Working Draft; a Publisher publishes it (`site_page_scopes`,
  `site_area_scopes`, their revisions).
- **Content** is what a Widget shows: a text, a Markdown or HTML body, an image. It lives in
  `site_content` and its versions. An Author, a Publisher or a Builder writes a draft of it; a
  Publisher publishes it.

Neither publish carries the other. Publishing a Page puts its structure live and leaves every text on
it as the last content publish left it; publishing a text puts that text live on whatever structure is
live. A Publisher may do both in one act, but as two named steps, never as a side effect.

Content types that are not placed by a Widget -- `news`, `blog` -- are content only. They follow the
same draft, submission and publish rules below and have no structure of their own; a Page that shows
them (a list, a detail route) is ordinary structure. Every kind is declared once in
`SITE_CONTENT_ENTRY_KINDS` (`src/db/site-content-entries.ts`) -- its type number and the translation
contexts of its fields -- and is served under its kind: `/api/site/editor/entries/<kind>` (save, list,
delete), `/submit`, `/publish`, and the public read `/api/v1/entries/<kind>`. An entry's link is a stored
target under `meta.linkTarget` (REFERENCES.md), indexed as Content references with every save and
released with the entry.

## Binding a Widget to its content

- A Widget declares the config field that is its content through `contentBinding`
  (`storage: text | html | markdown | asset`, `sourceField`). Nothing else in its config is content.
- The content row that answers for a Widget is found by the Widget's instance id:
  `site_content.instance_id` holds the `PhiCmsInstanceId` of the one Widget the row belongs to, unique
  per Site. Revision trees carry neither the content id nor a version pin.
- Instance ids are stable where the structure is replaced: a preset node's id derives from its Module,
  preset key and node key, and a draft node's id from the revision that created it. Deleting a Site
  override, restoring an older revision or publishing a new one therefore leaves the binding intact.
- The bound field is not stored in the revision tree once the Widget has content. A structure save
  that carries it compares it with the version it was read from (below): a changed value is a content
  write, an unchanged one writes nothing, and either way the Widget is stored with the field removed.
  Reads put the stage's value back, as `resolvedContent` and, in the current stage, into the field
  itself so that an editor shows and diffs it.
- A Widget the Site created (a draft-origin instance) gets its content row with the first structure
  save that places it. That first version is the Builder's placeholder and is not published.
- A preset node is the Module's until somebody writes content for it. Without a row its field stays in
  the tree -- the preset's shipped value, or a Site override's copy of it -- and follows structure. A
  row for a preset node is created by a content write only, never by a structure save; from then on the
  node is bound like any other. Where a preset node's row has no published version yet, the live Site
  shows the preset's shipped value.

## Drafts, versions and the published stage

- Every save appends a `site_content_versions` row and moves `current_version_id` to it. A save whose
  value equals the current version's appends nothing.
- `published_version_id` is the version the Site shows. It moves only by a publish.
- Readers state their stage. The live Site reads the **published** stage: a Widget the Site created
  whose row has no published version shows nothing, so a Builder's placeholder text is never live until
  somebody publishes it. Builder, Editor, draft previews and revision reviews read the **current**
  stage.
- Restoring a structure revision restores structure only. Content keeps its own history: going back to
  an earlier version is a save of that version's value as a new version.

## Concurrent writers

Every content write states the version it builds on (`null` for a row that does not exist yet): a
Widget content write as `baseVersionId`, a content type's save as `versionId` -- the key the editor's
rows answer the draft's version under, so a Form bound to a row sends it back unasked. A write whose base is not the row's `current_version_id` is refused with `409` and writes
nothing; the writer reloads and decides. Structure reads hand the current version id out with each
bound Widget (`contentVersionId`) so that a structure save carries its base too.

## Submission

- `site_content.submitted_version_id` is the version an Author put forward for publication. Submitting
  names the current version; a later save leaves the submission on the version that was submitted, so
  an Author can keep writing without changing what the Publisher was asked to look at.
- A Publisher publishes a named version -- normally the submitted one. Publishing clears the
  submission; withdrawing a submission clears it without publishing.
- The Publisher's queue is every row with a submission, grouped by the Page, Area or entry it belongs
  to. Rows whose current version differs from the published one without a submission are drafts in
  progress, visible but not queued.

## Terms

An entry of a content type is filed under **terms**: tags and, for now, one category. Both are rows of
`site_content_terms` -- one per term of one kind on one Site, with an address (`slug`) and a label -- and
`site_content_term_links` says which entry carries which. `vocabulary` tells them apart: `1` a tag, `2` a
category. The links repeat the Site, the kind and the vocabulary, so two foreign keys hold a link to its own
Site and kind, and a partial unique index allows one category per entry. Several categories later is
dropping that index; nothing else changes.

- **Tags** are the Author's. A save states the entry's tags whole; the terms behind them are found or made
  by their address, and a tag nobody carries leaves the offer by itself.
- **Categories** are kept as their own list per kind (`/api/site/editor/entries/<kind>/categories`), the
  Publisher's to change. Shaped like the entries route: `PUT` states one whole -- with an `id` that
  category, without one a new one -- and `DELETE ?id=` removes one, filing its entries under none. Filing
  an entry under one is curation (below), never a save.
- A label is source text; the public read translates it under the kind's context for its vocabulary
  (`news tag`, `blog category`). The address is the term's identity and is answered as written.

## Curation

Who an entry is attributed to and what it is filed under are the Publisher's
(`PATCH /api/site/editor/entries/<kind>/curation`): a byline is a public statement about a person, and a
category is the Site's order. Both live on the entry rather than a version, so they are seen at once.

- `site_content.author_user_id` names a member of the Site whose core roles let them write entries. A new
  entry starts with its writer; a Publisher names somebody else or nobody. A member who leaves the Site
  leaves the byline empty and the entry in place.
- A reader is shown the name the person chose (`user_profiles.display_name`) or their first and last name,
  and their avatar only while it is a Public, ready image. Never an address: a person without a name to
  show is no byline. The same name rule serves threads, groups and revisions (`userDisplayNameSql`).

`GET /api/v1/entries/<kind>/<slug>` answers one published entry with its author and terms, and with
`include=related` the entries closest to it -- the same category counts two, every shared tag one, the
newest wins among equals. A detail Page asks this once for all of its parts.

## Rights

| Act | Widget content (`text`, `html`, `markdown`, `asset`) | Content types (`news`, `blog`) |
|---|---|---|
| Read drafts | Developer, Builder, Author, Publisher | Developer, Author, Publisher |
| Save a draft, submit | Developer, Builder, Author, Publisher | Developer, Author, Publisher |
| Publish, withdraw | Developer, Publisher | Developer, Publisher |

Core Admin passes every check through the central override. Authors may write any draft, not only their
own; the version check above keeps two writers from overwriting each other unseen. Every version
records who wrote it.

Site translations (`tr_site_lang`) are live the moment they are written, so writing them is a publish:
`Developer | Publisher`. Global translations are the operator's.

## Lifecycle

- A row bound to a draft-origin instance is deleted once no page or area revision of the Site contains
  a Widget with that instance id; until then a revision could be restored to it.
- A row bound to a preset-origin instance survives the deletion of every revision -- resetting a Site
  override removes structure, not the texts written for the preset's nodes. It goes with the Site.
- Deleting content deletes its versions, their text rows and its reference-index rows.

## Caching

Moving `published_version_id` moves the Site read marker, as moving a published revision does. Saves
and submissions do not: the live Site holds nothing of a draft.

## Reset

Resetting a Page or an Area to its Module's preset deletes the Site's override -- the scope's revisions
and pointers (`DELETE /api/site/cms/page/override`, `/api/site/cms/area/override`). Nothing is
published, and nothing has to be: with no override left, the preset answers at once. Because that changes
what is live, it is the Publisher's act, and it is offered in Revisions only, beside the history it
discards. Content bound to the preset's own nodes stays and is shown by the preset; Widgets the Site
added go with the override.

A Builder's toolbar never resets. Its command discards the open Working Draft and shows what is
published again. A Module selection has no reset at all: its draft is changed or published.
