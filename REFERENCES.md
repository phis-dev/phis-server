# Page Path and Internal Reference Contract

This document defines the normative target-v1 `@phis/server` persistence, authorization, sanitization, and
resolution contract for mutable Site Page paths and structured Page/Asset references. The corresponding
UI and Authoring contract lives in `@phis/ui/REFERENCES.md`; both sides must use one wire format
and must not introduce compatibility aliases.

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
column for Site Pages and the route descriptor for Module Pages. Restoring, undoing, publishing, or
discarding a Page revision never changes a Page Scope path.

## Explicit path change command

A Site Page path change is a dedicated authenticated Builder command addressed by positive Page Scope
id. It is not an ordinary Page Form/revision write. In one database transaction the command:

1. locks the Site-owned Scope and verifies the active Site and requested Area;
2. rejects every Scope with `owner_module_id` or `preset_key` and every cross-Site target;
3. normalizes and validates the new path, including reserved roots and Area policy;
4. rejects a canonical-path collision;
5. reads the maintained reference index for affected-reference counts;
6. updates only the canonical Scope path and audit metadata; and
7. emits a structured audit event containing old path, new path, Scope id, Area, actor, and affected
   reference counts.

The command preserves published/working revision pointers and creates no CMS revision or Undo/Redo
entry. Its response returns the resolved new path and affected-reference summary so Builder can refresh
its Page catalog and route deliberately.

## Reference identities and resolution

Structured internal Page targets contain one stable target variant:

- a Site Page Scope id, resolved only inside the current Site and declared Area; or
- a Module Page `(ownerModuleId, presetKey)`, resolved only through an active eligible Module descriptor.

The serialized Page-reference payload is opaque outside the central reference codec. The server issues,
parses, and validates it; browser values do not authorize Site, Area, Module, or Page access. Asset
references use the positive id of an Asset owned by the current Site's Site Media Space and repeat the
normal delivery-policy authorization on every resolution. User- and Group-Space Assets are invalid CMS
targets until an explicit authorized promotion copies or transfers them into the Site Space. Media Space,
ownership, and delivery semantics are normative in [GROUPS_AND_STORAGE.md](./GROUPS_AND_STORAGE.md).

Navigation and other structured internal links persist the reference, not an href. Their read models
resolve the current locale-/Area-correct path. Explicit external targets persist a validated literal URL
in a separate target variant. Root-relative strings are not an internal-reference fallback.

Navigation receives an internal Page reference only from the active Area's Page source Tree during
insert or drag/drop. The Navigation Table receives the resolved current path as read-only display data;
there is no second Page SelectBox and no alternate internal-target editor. A path change therefore needs
no Navigation mutation and becomes visible through normal reference resolution.

Deleting a referenced Site Page is a logical tombstone operation. The server retains its Page Scope,
immutable id, and canonical `(site_id, area_id, path)` ownership; deletion does not convert an existing
reference back into a raw path or silently discard it from a Navigation Draft. Authoring resolves the
missing target to a typed deleted diagnostic so the row remains repairable; Live navigation omits the
unresolved link entirely.

The transactional Page-create/restore workflow must include tombstoned Scopes in canonical-path lookup.
When the requested path belongs to a tombstoned Site Page in the same Site and Area, it reactivates that
Scope and retains its id instead of allocating another identity. Existing structured references thereby
resolve again automatically. This is create/restore-time identity reuse, not a runtime path fallback;
normal reference resolution remains strictly Scope-id based.

The server maintains an indexed projection of current structured Page and Asset references with their
owning scope and source location. Page, Area, navigation, and trusted-content saves and imports update it
transactionally, each replacing its own scope's complete set. The Area source carries what no content
binding reaches: a reference sitting in Region or widget config. Path change
uses it for audit/feedback but does not rewrite reference owners because their stable identity already
resolves to the new path. Page and Asset deletion flows query the same index for affected-reference
diagnostics; a Page deletion may retain unresolved references for the defined Draft diagnostic and Live
omission behavior. Legacy raw internal paths must be migrated to one unambiguous target or reported for
operator repair; live fallback lookup is forbidden.

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

It preserves an optional Page fragment without treating it as identity. No unresolved `phi:` value may reach a DOM `href`/`src`, redirect, CSS URL, translation request,
or Client-side resolver. Reference destinations are never translated; visible link text and image alt
text remain translation units.

An unresolved Page reference becomes non-interactive text. An unresolved Asset reference produces no
media. Authoring receives a typed diagnostic with owner Scope and source location. Resolution never
bypasses Page access, Site Space ownership, lifecycle status, delivery policy, delivery revision, or
signed-URL policy. A stored public URL or Storage key is not an Asset-reference fallback.

## External document sanitization

External Markdown/HTML (`sourceMode: "url"`) and provider-produced documents are untrusted regardless of
hostname. Their trusted source classification comes from persisted Widget/provider config, never from
document markup.

Before translation and rendering, the server sanitizer rejects any URL form that normalizes to the
reserved `phi:` scheme, including case, whitespace, character-reference, percent-encoding, redirect, and
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
