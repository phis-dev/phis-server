# Page Path and Internal Reference Contract

This document defines the `@phis/server` persistence, authorization, sanitization, and resolution
contract for mutable Site Page paths and structured Page/Asset references. It is also the single
statement of the shared wire rules: the `phis:page/` and `phis:asset/` URI forms, the `assetId` field
convention, and the external-document sanitization rule. The Builder, Navigation, and Control side lives
in [phis-ui REFERENCES.md](../phis-ui/REFERENCES.md). Both sides use one wire format and no aliases.

## Page identity and path ownership

`phis.site_page_scopes.id` is the immutable identity of a Site-authored Page Scope. Its normalized
`path` column is the canonical mutable route locator for that Scope. Page revision ids, revision JSON,
titles, Builder keys, navigation ids, and paths are not Page identity.

A Module-owned Page Scope is identified by `(site_id, area_id, owner_module_id, preset_key)` and has no
stored Site path. Its concrete route path is resolved from the active Module route descriptor and cannot
be changed by a Site operation. Deriving a Site Draft from a Module preset does not transfer path
ownership to the Site.

The Page revision payload may receive a resolved path in a read/render view model, but it must not persist
an independently authoritative `tree_json.page.path`. Write and read code must converge on the Page Scope
column for Site Pages and the route descriptor for Module Pages. Restoring and undoing a Page revision
never change a Page Scope path. Publishing changes it exactly when a pending path stands, and discarding
a Page draft discards that pending path; both are described under the path change command below.

## Explicit path change command

A Site Page path change is a dedicated authenticated Builder command,
`POST /api/site/cms/pages/:scopeId/path`, addressed by positive Page Scope id. It is not an ordinary Page Form/revision write, and it does not move the Page. In one database
transaction the command:

1. locks the Site-owned Scope and verifies the active Site and requested Area;
2. rejects every Scope with `owner_module_id` or `preset_key` and every cross-Site target;
3. normalizes and validates the new path, including reserved roots and Area policy;
4. rejects a canonical-path collision against the live and pending paths of that Area;
5. reads the maintained reference index for affected-reference counts;
6. writes `site_page_scopes.draft_path` and audit metadata; and
7. emits a structured audit event containing the live path, the pending path, Scope id, Area, actor,
   and affected reference counts.

Requesting the path the Page already answers on clears a pending change rather than storing a move to
where it already is. The command preserves the canonical Scope path and the published/working revision
pointers, and its response returns the live path, the pending path and the affected-reference summary.

The address moves when the Page is published. `publishSitePageRevision` promotes `draft_path` into
`path` in the transaction that swaps the revision pointers, and a rename with no other change publishes
on its own without creating a revision. Discarding a Page draft discards a pending path with it.

Two guards, and only the second decides. The collision query in step 4 exists so Builder can object
while the operator still has the field open; two writers that neither read after the other commits both
pass it. The partial unique indexes on `(site_id, area_id, path)` and `(site_id, area_id, draft_path)`
are the guarantee, and a publish whose pending path lost its address in the meantime fails there rather
than overwriting the Page that took it.

Publishing is therefore the one place a live Site Page address changes, and the audit event naming the
move is emitted there rather than where it was requested.

## A Page is never a folder

A Site Page whose path lies beneath another Site Page's path in the same Area is refused when it is
written, and so is the reverse -- a Page at `/docs` while `/docs/a` exists. Live, pending, and tombstoned
addresses all count, because deletion reserves a path; `/` is the Area root slot and not a folder. The
check runs on create, on the path change command, and on the publish that promotes a pending path.

Equality is guarded by the partial unique indexes, but "beneath" is a prefix relation no index can
express. Every writer that creates, moves, or promotes an address therefore takes a per-Area transaction
lock (`pg_advisory_xact_lock` in `src/db/site-pages.ts`) before the check, which makes the check the
guarantee rather than advice. The answers are `409 path_collision` for an address another Page holds and
`409 path_nested` for one that would put a Page beneath another, with `{ error, message }`.

## Creating a Page

`POST /api/site/cms/page/create` creates a Site Page and only creates. When a Scope already holds the
path, it writes nothing and answers `409 page_exists` with the Page -- `{ id, reference, path, tombstoned }`
-- so the Builder opens that Page instead of laying a blank draft over it. A plain save cannot make that
distinction: it addresses Pages by path too, and finding one is its normal case. A tombstoned Scope on
the path counts as holding it and is answered the same way, with `tombstoned: true` -- which says the
deletion was published, because that is when the tombstone is written. A Page whose deletion is only
drafted is a live Page and is answered with `tombstoned: false`. The address rules above apply to the
path of a new Page.

## Folder addresses

A folder is a path segment with Pages beneath it -- `/docs` while `/docs/guides/a` exists. Because a Page
is never a folder, a folder address never meets a Page path, and a request for one is answered from the
published Navigation rather than from a store of its own.

- *The target is authored on the Navigation container.* A container, custom or a Module container's
  override, carries `folder: { address, target }` in the Navigation overlay. `target` names what the
  chosen direct child stands for -- a Page by reference, Site or Module, or a sub-folder by address --
  never the child's id, which exists in one Navigation only, and never a path composed from the menu
  hierarchy. A Page target is indexed like a link's target. No target means 404.
- *The address* is the folder the container's direct children share, each child contributing the folder
  it lies in; children from different folders, or only from the Area root, give it none. It is resolved
  again when the Draft is saved or published, package namespace included, so outside Public it is the path
  a request carries.
- *Write strict, read allow.* A target outside the container's direct children cannot be saved, and one
  Navigation holding the same folder twice with two targets is refused. Whatever goes stale afterwards --
  the target left the folder, was tombstoned or unpublished, the chain ends in a container without a
  target, the folder lost its last Page -- reads as no target. No check runs after saving, and nothing
  repairs stored data.
- *One address, one target.* A folder can appear in several Navigations of an Area. Saving a Draft carries
  a changed target into every other Navigation holding the same folder, in the save transaction. Undo stays
  per Navigation; the next save carries the value again.
- *Live on publish, in one hop.* `GET /api/v1/site/nav/folder?area=&path=` (internal token) reads the
  published Navigations of the Area, newest published revision first, follows sub-folder targets, and
  answers `{ reference }` for a Page, or 404. It refuses a Site Page that is unpublished, tombstoned, or in
  another Area; a Module Page reference is handed to the Site, which alone knows Module routes. A
  Navigation revision carries no publish time, so its creation time stands in. The chain is resolved at
  lookup rather than written at publish, so a publish stays a pointer move and a renamed target needs no
  republish.
- *At the Site* the lookup sits on the miss path only: the Site asks it where no Page answers and turns a
  reference into a 307, as it does for a forwarding Area root. The locale prefix stays outside, since paths
  are locale-neutral.
- *Sitemap:* a folder address is a redirect and is not listed; the Pages behind it already are.

## Reference identities and resolution

Structured internal Page targets contain one stable target variant:

- a Site Page Scope id, carried as the number itself, resolved only inside the current Site and declared
  Area; or
- a Module Page, carried as the CMS Page id derived from `(ownerModuleId, presetKey)`, resolved only
  through an active eligible Module descriptor.

The two are shaped differently because the server does different things with them. A Site Page Scope id
is written into a foreign key with `ON DELETE RESTRICT`, so it must stay a number the server can read. A
Module Page id is derived and one-way: the server never unpacks it, indexes nothing by it, and hands it
to the Site, which alone knows Module routes and holds the other side of the derivation. Deriving rather
than allocating is what lets a Module Page be addressed before any row for it exists.

The serialized Page-reference payload is issued and parsed by the central reference codec and is opaque
to everything else. It is short by construction: the identity of a Module Page is a name both sides
recompute, not a payload one side unpacks, and an envelope carrying that payload is not protection --
encoding is not signing, and Site and Area are revalidated on every resolution regardless. The server issues,
parses, and validates it; browser values do not authorize Site, Area, Module, or Page access. Asset
references use the positive id of an Asset owned by the current Site's Site Media Space and repeat the
normal delivery-policy authorization on every resolution. User- and Group-Space Assets are invalid CMS
targets. No operation moves or copies an Asset into the Site Space; the Site Space is not a transfer
target, as recorded in [GROUPS_AND_STORAGE_PLANNED.md](./design/GROUPS_AND_STORAGE_PLANNED.md). Media
Space, ownership, and delivery semantics are normative in [GROUPS_AND_STORAGE.md](./GROUPS_AND_STORAGE.md).

Persisted config names an Asset by that id in a field called `assetId` or in one whose name ends in
`AssetId`, and by no other means. The URI form belongs to Markdown and HTML bodies; a Widget image, a
Region or Root background, a Module's ground, and the Theme's brand logo all carry the id itself
alongside the variant, geometry, and focal facts that belong to it. This is what the reference
collector reads, so an Asset stored under any other shape is a reference nothing protects: no index
row, no delete diagnostic, and deletion of an Asset the Site is still rendering.

Navigation and other structured internal links persist the reference, not an href. Their read models
resolve the current locale-/Area-correct path. Explicit external targets persist a validated literal URL
in a separate target variant. Root-relative strings are not an internal-reference fallback.

Persisted config names a link target in a field called `linkTarget` or in one whose name ends in
`LinkTarget`, and by no other means. The field carries the target object itself: a Page by its bare
reference, or an explicitly external address by its literal URL. The URI form stays with Markdown and
HTML bodies, as it does for Assets, so config carries identity rather than a scheme. This is what the
reference collector reads, and it reads the field whole: a target declares its kind, and nothing beneath
it is walked for a second opinion, so a reserved-scheme string typed into an external address indexes
nothing. Only a Site Page target produces a row. An external target names nothing the Site owns, so there is no
identity to guard and no path that can move beneath it. A Module Page target is not indexed either, and
for the same kind of reason: the Site owns neither the Page nor its path, and switching the Module off
is reversible -- it takes its routes with it and gives them back -- so there is no irreversible act for
a guard to stand in front of, and no row for a foreign key to point at. The absence of an index row
therefore does not mean nothing points at a Module Page.

A configuration that sends somewhere is a link target like any other. An Area's forwarding root keeps its
Page as `preset.config.shell.rootRoute.targetLinkTarget`, the Page alone -- a forward carries no fragment,
no parameters, no new tab and never leaves its Area, so the write refuses anything else in it. A landing's
`target` beside it is not one: it chooses which Module's applicant stands at the root, it is only ever a
Module Page reference, and it is never followed, so it stays a bare reference and contributes no row. A
Region's Page scope names its Pages as `pageLinkTarget` entries for the same reason a forward does.

A target may name the Area to resolve its reference in, and is then indexed under that Area rather than
the one whose tree carries it: that is where the Page it guards lives, and filing it against the Area
that merely points at it would put the row beside Pages it has nothing to do with. Absent, the Area
remains the one the tree was written in, which is what a link that names none means.

Navigation receives an internal Page reference only from the active Area's Page source Tree during
insert or drag/drop. The Navigation Table receives the resolved current path as read-only display data;
there is no second Page SelectBox and no alternate internal-target editor. A path change therefore needs
no Navigation mutation and becomes visible through normal reference resolution.

Deleting a referenced Site Page is a logical tombstone operation. The server retains its Page Scope,
immutable id, and canonical `(site_id, area_id, path)` ownership; deletion does not convert an existing
reference back into a raw path or silently discard it from a Navigation Draft. Authoring resolves the
missing target to a typed deleted diagnostic so the row remains repairable; Live navigation omits the
unresolved link entirely.

Deletion is a draft like every other change to a Page, and publishing is what performs it. The draft
marks the Page deleted; `site_page_scopes.tombstoned_at` is written by the publish, so until then the Page
resolves, stays in the sitemap and stays a valid Navigation target, and discarding the draft leaves no
trace of it. Publishing a later revision that is not marked deleted clears the tombstone again, which is
how a deleted Page comes back. What outlives the draft is the address: the path is reserved from the
moment the Scope exists, tombstoned or not (*A Page is never a folder*, above).

The transactional Page-create/restore workflow must include tombstoned Scopes in canonical-path lookup.
When the requested path belongs to a tombstoned Site Page in the same Site and Area, it reactivates that
Scope and retains its id instead of allocating another identity. Existing structured references thereby
resolve again automatically. This is create/restore-time identity reuse, not a runtime path fallback;
normal reference resolution remains strictly Scope-id based.

The server maintains an indexed projection of current Site Page and Asset references with their owning
scope and source location. Page, Area, navigation, Theme, and trusted-content saves and imports
update it transactionally, each replacing its own scope's complete set. The Area source carries what no
content binding reaches: a reference sitting in Region or widget config. The Theme source carries what
no CMS tree reaches at all: it is Site wide, one Scope per Site with a key that has no Area prefix, and
it holds the Root background a Module's ground was taken over into and the brand logo. A Theme
reference therefore names no Area, and a Page reference in a Theme is invalid because a Site-wide Scope
has no Area to resolve one in. Path change uses the index for audit/feedback but does not rewrite
reference owners because their stable identity already resolves to the new path.

A Scope's set is replaced per Scope, and its rows stay readable across every revision that Scope points
at: published, Working Draft, and — for an Area — the Module Working Draft. A publish that merges a
tree, rather than only promoting a pointer, rewrites the set for the tree it published; a publish that
may promote a revision other than the current draft does the same. Page and Asset deletion flows query the
same index for affected-reference diagnostics; a Page deletion may retain unresolved references for the
defined Draft diagnostic and Live omission behavior. A raw internal path is not a reference, and no live
lookup falls back to one.

## Trusted Markdown and HTML

Only internally persisted trusted Markdown/HTML may contain the reserved forms:

```text
phis:page/<opaque-page-reference>
phis:asset/<positive-asset-id>
```

The CMS write path accepts those schemes only in the declared internal content channel, validates their
grammar, and indexes the references. Normal same-Site Page and Asset authoring must use these structured
forms rather than a root-relative path or copied media URL. Absolute external URLs and fragment-only
document anchors remain separate explicit values.

The server parser converts Phi URIs into structured nodes and resolves all referenced targets in bulk
before producing a browser render model. Both reference kinds resolve through the one internal-token
endpoint `POST /api/v1/site/references`, which accepts Page references and Asset ids together and
answers in a single round trip. `area` is required only for Page references, because Assets are Site
scoped and carry no Area.

That endpoint has no mode that returns a management record. An Asset is answered through the public
rendering projection — delivery, variant, geometry, blur, title, alt text, and the typed focal
rectangle — and never through ownership, Folder placement, audit attribution, checksum, byte size, or
the raw `meta` blob. Site Space membership, Ready lifecycle, and public delivery policy are part of the
query, so an id that fails any of them is simply absent from the result and indistinguishable from a
deleted one. Clients must not re-filter what the resolver returns; the guarantee is server-side.

It preserves an optional Page fragment without treating it as identity. No unresolved `phis:` value may
reach a DOM `href`/`src`, redirect, CSS URL, translation request, or Client-side resolver. Reference destinations are never translated; visible link text and image alt
text remain translation units.

An unresolved Page reference becomes non-interactive text. An unresolved Asset reference produces no
media. Authoring receives a typed diagnostic with owner Scope and source location. Resolution never
bypasses Page access, Site Space ownership, lifecycle status, delivery policy, or delivery revision. A stored public URL or Storage key is not an Asset-reference fallback.

## External document sanitization

External Markdown/HTML (`sourceMode: "url"`) and provider-produced documents are untrusted regardless of
hostname. Their trusted source classification comes from persisted Widget/provider config, never from
document markup.

Before translation and rendering, the server sanitizer rejects any URL form that normalizes to the
reserved `phis:` scheme, including case, whitespace, character-reference, percent-encoding, redirect, and
nested-URL bypasses. A forbidden Page link is unwrapped while retaining visible text; a forbidden
Asset/image node is removed. Authoring may receive a non-interactive diagnostic, but live output receives
no placeholder URI.

Relative and root-relative URLs in an external document resolve against that document's source URL and
never against the current Phi Site. External content cannot opt into internal resolution by using a Site
hostname, an HTML comment, a custom attribute, or a URI resembling a local path.

## Contract governance

Changing, extending, replacing, reinterpreting, or widening this contract requires explicit prior
operator approval after the exact gap and affected ABI have been presented. SQL, route handlers, CMS
revision helpers, sanitizers, Add-ons, and CLI commands must not introduce raw-path aliases, a second
reference codec, Client-only resolution, or a trusted-external exception.
