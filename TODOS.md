# Phi Server TODOs

This backlog records approved target directions that are not implemented yet. It is not a compatibility
contract and must not be used to infer that an item is already available in `phis-cli` or at runtime.

## P0: Implement canonical mutable Page paths and structured references

Implemented in the current baseline:

- [REFERENCES.md](./REFERENCES.md) is the Server persistence/resolution contract. `src/lib/internal-references.ts`
  holds the codec and mirrors `@phis/ui`'s `types/references.ts`.
- `site_page_scopes` carries exactly one Site-path or Module-preset identity, enforced by a CHECK
  constraint plus the two partial unique indexes, with `tombstoned_at` for path-reserving deletion and
  same-Scope reactivation on create/restore.
- `POST /api/site/cms/pages/[scopeId]/path` is the Builder path-change command: typed `src/db/`
  transaction, Site/Area revalidation, collision and ownership diagnostics, preserved revision pointers,
  a `PagePathChanged` audit event carrying old/new path and affected-reference counts, and no revision or
  Undo/Redo participation.
- The Page source Tree/catalog emits stable opaque Page references; Navigation persists those references
  and renders the resolved path read-only, with the literal URL editor reserved for explicit external targets.
- `phis.site_cms_references` is the maintained index, replaced transactionally per source scope by the
  Page, Navigation, Area, Theme, and trusted-content writes, and read by path-change reporting and the
  delete guards.
- An Asset in persisted config is indexed from the field that carries its id -- `assetId`, or a name
  ending in `AssetId` -- because that is how every picker stores one; the `phis:asset/<id>` URI form
  belongs to trusted Markdown and HTML bodies. Before that, a picture in Widget, Region, or Theme config
  was in no index at all and its Asset was deletable while the Site rendered it.
- The Theme is the fifth source: Site wide, one Scope per Site, written by its draft save and rewritten
  by its publish. It holds the Root background a Module's ground is taken over into and the brand logo.
- Liveness reconciliation spans every pointer a Scope has, including an Area's Module Working Draft, and
  both Area publishes rewrite their set because they merge a tree rather than only promoting a pointer.
- The authoritative HTML write sanitizer accepts `phis:page/` and `phis:asset/` in the declared internal
  content channel, drops obfuscated and grammatically invalid variants, and permits `img` there. Bulk
  resolution, fragment preservation, Asset access enforcement, and the guarantee that no unresolved Phi
  URI reaches Client output live in the shared server render path.
- The external-document branch rejects normalized Phi schemes, unwraps forbidden links, removes forbidden
  media, and resolves ordinary relative URLs against the external source, for both HTML and Markdown.
- The regression matrix named for this section is complete as of 2026-08-25: reference codec, attribute
  grammar and bypass encodings, write-sanitizer channel behavior, the content reference projection, path
  ownership, collision and reserved-path handling, revision-pointer preservation, Module-path rejection,
  affected-reference reporting through the command and its audit event, index consistency across repeated
  writes, Site/Scope/source-kind isolation, the delivery decision behind every Asset policy, and missing
  or tombstoned reference targets.

Remaining work:

- The PostgreSQL integration harness landed on 2026-08-26 and closed the decisions the fakes could not
  reach: `ON DELETE RESTRICT` on both target columns, the target check constraint, transactional
  rollback on a collision, a second writer waiting on a held row, and the partial unique index --
  which the concurrency test shows is the real guard against two Pages on one canonical path, because
  the collision query alone lets both writers through when neither reads after the other commits.
  `npm run test:pg` runs it against the development database: it verifies the schema and refuses to
  run when it is behind, never creating or migrating one, and every fixture hangs off a `pgtest-` Site
  it removes again.
- The Media half followed the same day: quota reservation as one atomic statement (two concurrent
  requests that each fit alone let exactly one through), inheritance from the Site default and the
  Space override, the read-time discount that stops an expired session from holding capacity, expiry
  release and its idempotence, commit moving reserved bytes to used with nothing left for a second
  subtraction, abort idempotence, Site and Space isolation on Asset and Space reads, Space-scoped
  duplicate detection, the composite foreign keys that refuse an Asset bound to another Site's Space
  or Storage Profile, and the public Site Space projection. Verified by mutation on all five paths.
- Folder ownership and the claim projection followed: a Folder confined to its Space, a parent from
  another Space refused, path resolution that reuses a branch instead of forking it, and the
  `ON DELETE SET NULL (folder_id)` contract that lets an Asset outlive the Folder it was filed under.
  Plus the delivery default an Asset inherits from its Space kind, and the one claim projection every
  authorization decision reads -- membership granted, retirement and expiry granting nothing, and no
  role or group claim carried across Sites.
- Two items on the old matrix list turned out to be missing features rather than missing tests:
  - **Delivery-revision rotation** landed on 2026-08-27: `updateMediaAsset` rotates on every change
    rather than on a chosen subset of fields, because deciding per field which ones are cache-relevant
    has to be right every time and the cost of being wrong is asymmetric -- an unnecessary rotation
    costs one re-download, a missed one serves stale or over-shared bytes until the cache expires on
    its own. A request naming no field changes nothing and does not rotate. The variant path needs no
    separate rotation: a focal-rect change already goes through `updateMediaAsset`, which bumps
    `variant_version` too and then drops the variant rows, so the URL changes before regeneration.
    Measured against the running server: the current revision answers `immutable`, a stale one drops
    to `must-revalidate` and still serves, so rotating never breaks an already-rendered page.
  - **Provider disable/restore has no representation.** `media_storage_profiles.flags` is carried
    through the reads and never interpreted; the only fail-closed path is an unregistered provider id
    in `src/lib/media-storage.ts`. Disabling a profile that Assets already bind to is a decision about
    what happens to those Assets, so it needs the operator surface designed before it can be tested.

## P0: Implement general groups, Media Spaces, and the Storage Provider core

Implemented in the current baseline:

- The v1 DDL rewrite landed directly in `scripts/sql/001_create_phis.pgsql` and the typed `src/db/` layer,
  with no migration scripts and no compatibility columns. `site_groups`, provenance-aware
  `site_group_members`, `media_spaces`, `media_folders`, `media_storage_profiles`, and `site_media_config`
  exist; Assets, variants, and upload sessions bind to Space, Folder, and concrete Storage Profile and
  carry creator attribution, lifecycle, delivery policy, delivery revision, and quota accounting.
  Membership rows already carry source Provider, connection, and assertion identity.
- The pre-P0 `media_groups` table, the `groupId`/`groupPath` vocabulary, the global `local | s3` switch,
  and persisted public URLs are gone from both repositories, with no aliases retained.
- `@phis/server/groups:v1` is a permanent Core capability served by `/api/v1/groups` and its member
  routes.
- Provider-qualified group claims and the closed `groups` access policy are part of the one shared
  authorization snapshot, parser, and evaluator, orthogonal to roles and preserving the Core Admin
  override.
- The manifest-declared service-provider registry replaced the global Storage switch. The Local adapter
  is registered through it, every Asset and variant binds to a concrete profile, and an unavailable
  provider or profile fails closed.
- Delivery resolves by Asset id and variant key. Lifecycle and delivery policy are enforced before any
  physical lookup, public Assets get immutable caching only for the current `delivery_revision`, and every
  other policy is `private, no-store`.
- Upload initialization binds Site, actor, Space, Folder, and Storage Profile and reserves quota through a
  single conditional statement; duplicate detection is Space-scoped.
- The Page/Asset delete guards read `site_cms_references` instead of scanning revision JSON.
- The Site Media management authority from section 6 is one declared policy, `PHI_ACCESS_SITE_MEDIA`,
  evaluated by the shared access evaluator with the Core Admin override. Asset listing and detail,
  Folder trees, uploads, Asset mutations, and the Media Form endpoints all guard on it. Five routes
  previously declared their own token-only context that resolved a Site from the key header and stopped
  there, so Media reads carried no user authorization at all and any authenticated Site user could
  upload into the Site Space. Delivery is deliberately not guarded by the policy: it continues to run on
  the Asset's own lifecycle and delivery policy so public pages render without a session, and the
  internal reference resolver keeps its token-only path because it can only answer public projections.

Remaining work:

- Finish making User and Group Spaces reachable. The server half is implemented: `site_media_config`
  carries availability flags with default-deny, `resolveAuthorizedMediaSpace` validates a requested
  `spaceId` against the actor's authorized Spaces and the Site's enabled kinds, quota inheritance
  resolves live inside the reservation statement, and the media listing returns the active Space plus
  the selectable Space list, and the Folder routes resolve the same `spaceId` query parameter through
  the shared reader. `GET`/`PATCH /api/site/admin/media` is the Admin-only surface for the Site quota
  defaults and reports availability read-only, because availability follows the active Modules.
  `spaceId=user` addresses the actor's own User Space
  semantically and materializes it lazily on first authorized use, gated on the availability flag.
  The group half is implemented as of 2026-08-23, to the split decided in section 6 of
  [GROUPS_AND_STORAGE.md](./GROUPS_AND_STORAGE.md). Creating a group and granting the Manager level are
  `Developer | Admin`; a group's Manager administers Contributor and Member in that group and may not
  touch a row carrying the Manager bit. A Group Space is materialized by the first Contributor write,
  while Member discovery lists it beforehand with `id: null` and a `group:<id>` address. The Site
  configuration carries `max_user_quota_bytes` and `max_group_quota_bytes`, and
  `PATCH /api/site/media/spaces/<address>` writes one Space's override -- any Space for Developer and
  Admin, a Manager's own group up to the ceiling.

  The concept for how Modules, Spaces, visibility, and transfer fit together is settled in
  [GROUPS_AND_STORAGE.md](./GROUPS_AND_STORAGE.md) as of 2026-08-23 and is not yet implemented:

  - **A Module that declares a need.** The mechanism is implemented as of 2026-08-24: a Module states
    its Space kinds in `mediaSpaceKinds`, the Builder derives the Area's union into
    `preset.config.mediaSpaceKinds`, and publishing an Area materializes the Site-wide union into
    `site_media_config.flags` -- which no longer accepts an administrative write. `@phis/ui/groups`
    is the first Module to declare one: activating it in the `admin` Area and publishing turns Group
    Spaces on, measured end to end. User Spaces still wait for a Module that needs them -- a profile or
    avatar surface -- and are unavailable until one exists.
  - **The Avatar Module landed on 2026-08-27** and User Spaces are reachable: activating it in the
    `app` Area and publishing moves `site_media_config.flags` to `3`, measured end to end through the
    Builder. `phis.user_site_avatars` binds one Asset per person per Site, with both halves carried by
    composite foreign keys -- the membership pair and the Asset pair each carry their `site_id` -- so a
    cross-Site avatar is structurally impossible. `user_profiles` stays global and untouched:
    an avatar is Site-scoped because the Asset lives in that Site's User Space.
    `GET`/`PUT`/`DELETE /api/site/account/avatar` is the actor's own binding, deliberately not guarded
    by `PHI_ACCESS_SITE_MEDIA` and never reading a user id from the request. Two Widgets and one
    Area-owned Overlay make the surface; the Overlay is opened by the generic `dialog` signal, so the
    Module needs no Controller.
  - **What a Site accepts is enforced as of 2026-08-27**, which it never was. `max_object_bytes` and
    `allowed_content_types` had been columns since the v1 schema with nothing reading them: the object
    cap was reported by two settings routes and applied by nobody, and the type list was not read
    anywhere in the server at all. A Site could therefore restrict capacity and nothing else, while an
    `accept` attribute in a browser was all that stood between it and a file it never wanted.
    `uploads/init` now refuses with `media_asset_too_large` (413) and `content_type_not_allowed` (415),
    ahead of the Space so the answer is the same wherever the file was headed and ahead of the
    reservation so a rejected upload never holds capacity. An empty type list means every type, because
    the column defaults to empty and reading that as a closed list would lock every existing Site out
    of its own Media; entries are exact types or `type/*` families, compared without parameters or
    case. There is no unlimited object size: `site_media_config_quota_check` requires a positive cap,
    so the code reads it that way rather than inventing a disabled value the column cannot hold.
    `SiteMediaConfigUpdate` and the Admin surface gained both fields -- a limit nobody can set is a
    limit that does not exist.
  - **Superseded and replaced the same day: the Site type list is now a Module derivation.** The
    enforcement above validated a claim. `uploads/init` reads `contentType` out of the request body,
    `finalize` persisted `session.contentType` without ever looking at the bytes, and delivery echoed
    that value back, so the one party the check existed for was the party who writes the value being
    checked. Splitting the check across per-family upload routes was considered and dropped: it would
    have split claims. What landed instead, on 2026-08-27:

    - **A Module declares its content kinds per Space kind.** `mediaSpaceKinds` became `mediaSpaces`,
      a map from Space kind to the content it is expected to hold, because two parallel fields that have
      to agree is a rule someone eventually breaks. Activating and publishing derives the union on the
      same path Space availability already took -- and per kind, so a general Asset library declaring
      everything for the Site Space does not widen what a User Space accepts. Installing a Module is the
      operator's consent to what that Module declares; there is no second list to keep in agreement with
      the first. Avatar declares `{ user: { kinds: ["image"] } }` and Groups the seven working kinds
      without `binary`, and the avatar picker reads its own Module's declaration rather than restating
      it, so the file dialog and the answer cannot drift apart.
      The declaration names kinds rather than media types, because `PhiMediaKind` already existed in
      Core as a curated vocabulary -- `pdf` and `markdown` are broken out of `application/*` and
      `text/*` on purpose, which is the curation a derived MIME family cannot do. `binary` was added on
      2026-08-27 to complete it: executables and disk images resolved to `other`, so a Module that
      legitimately distributes an installer would have had to declare the catch-all to get one.
      `preset.config.mediaSpaces` replaces `preset.config.mediaSpaceKinds` with no compatibility reader,
      per the v1 ABI-break doctrine. A published Area shell is materialized `tree_json`, so an existing
      Site keeps its old key and reads as declaring nothing until its Areas are published again.
    - **The Site Space carries no derived ceiling at all.** Its authority is `PHI_ACCESS_SITE_MEDIA`, a
      role rather than a list: what a Site publishes includes binaries offered for download, and a
      Builder, Editor, or Admin deciding that is the purpose of the Space. It has no column and no map
      entry, rather than an empty one. The object cap still applies there, because capacity is not trust.
    - **An empty list means nothing, which is the opposite of the list it replaces.** An administered
      list defaults to empty and had to be read as "every type" or it would have locked a Site out of
      its own Media. A derived one is only ever empty when no Module has spoken, and a Space nothing
      asked for holds nothing -- which is also what makes stating a purpose the only way to be usable.
    - **`site_media_config.allowed_content_types` and its Admin write are removed**, replaced by
      `user_space_content_kinds` and `group_space_content_kinds`, one column per delegated Space kind on
      the precedent `max_user_quota_bytes` and `max_group_quota_bytes` already set. Both are reported
      read-only beside availability. One authority that knows the purpose beats two that can disagree,
      and `flags` had already set that precedent by no longer accepting an administrative write.
    - **The size check moved ahead of the Space and the type check behind it.** How much fits is a Site
      question and is answered before the Space is resolved, so the answer is the same wherever the file
      was headed. What a Space is for cannot be answered before the Space is known, which reverses the
      ordering argument recorded this morning -- deliberately, because the rule being enforced changed
      owner. Both still run ahead of the reservation, so a refused upload never holds capacity.
    - **A kind this release has never heard of travels as the string it is.** Both the preset reader and
      the column carry it unvalidated, on the same reasoning that lets an unknown Space kind through: an
      older control plane must not reject a newer Module that knows what its own declaration means.
    - **`finalize` measures the object instead of believing the claim**, as of 2026-08-27, which is what
      makes the rule above enforceable against someone who does not use a browser. `uploads/init` can
      only weigh the declared type, since the object does not exist yet; `finalize` reads the first
      4 KB, identifies the format, stores that, and applies the Space rule again to what actually
      arrived.
      **A mismatch is not itself a refusal.** Browsers label inconsistently -- a CSV arrives as
      `text/plain`, `application/vnd.ms-excel`, or nothing at all depending on the machine -- so
      refusing on disagreement would mostly refuse honest people for something they cannot fix, and the
      detector's own answer is a heuristic that can be the one at fault. The stored type simply becomes
      the true one, and what is refused is the Space rule applied to it: not "you said something else"
      but "this does not belong here", which is the only half a person can act on.
      `sniffPhiMediaContentType` is hand-written and small on purpose. Every answer it gives is one a
      security decision rests on, and a dependency that quietly learns a new format is a dependency that
      quietly changes that decision. Where the bytes are genuinely ambiguous the declaration may refine
      but never override: an ODF container states its own type and is read from the entry, an OOXML one
      does not, so a declaration may pick among ZIP-shaped answers only -- nothing dangerous is a ZIP.
      Text carries no magic at all, so `text/html` and `image/svg+xml` are pinned by shape and every
      other textual body keeps its label only if that label is itself textual. An object nothing
      recognizes is stored as `application/octet-stream` rather than as what it was called, so no claim
      survives into delivery.
      Sniffing stays a floor and not a roof -- polyglot files exist and text is recognized by shape --
      so the delivery hardening below remains necessary rather than superseded.
    - **Reading the head is a Provider operation, not a buffer read.** `readObjectHead(storageKey,
      byteLength)` sits beside `headObject` in the storage ABI: identifying a four gigabyte video costs
      the same as identifying a thumbnail, and a Provider that stores remotely answers with a ranged
      read rather than the body. The Local adapter opens the file and reads the prefix.
    - **`finalize` stopped buffering the whole staged object**, on 2026-08-27. It had held all of it
      three times over, and the third was the one that mattered: after the SVG scan and the image
      decode it re-uploaded the entire body onto the final key with `putObject`. For a Provider that
      stores remotely that is a download plus an upload of every byte -- impossible for a multipart
      object, and the reason the other two limits alone would have achieved nothing measurable.
      `copyObject` joins the storage ABI beside `readObjectHead`: the settle is a copy in place, which
      the Local adapter does on disk and S3 will do server-side. It also closed a latent hole -- the
      staging object was deleted unconditionally afterwards, so a plan that staged straight onto its
      final key would have deleted its own Asset. The delete now runs only when the two keys differ.
      What remains is bounded and stated. **The SVG scan is a refusal, not a truncation:** a script
      element may sit anywhere in the document, so reading a prefix would let one past by putting it
      late; past 2 MB the upload is refused rather than half-checked. **The image decode is a skip:**
      dimensions and the blur placeholder are conveniences, so past 64 MB they are simply absent. An
      SVG is decoded from the buffer the scan already holds rather than read twice.
    - **Still open: orphaned objects in storage.** Measured on 2026-08-27: 27 objects on the
      development Site belong to no Asset row, dated from April onwards -- deleted Assets and aborted
      uploads leaving their bytes behind. One per day of ordinary use is not a leak that matters yet,
      and none of them came from the settle path above, but nothing reclaims them and nothing counts
      them against a Space. An operator needs a way to see and sweep them; it belongs with the S3
      Add-on, where the same sweep has to reach a remote bucket.
    - **Purpose is checked at the bind, not at the upload.** A Module has no upload route and must not
      gain one, but where it has server code it already decides from purpose: the avatar bind widens an
      Asset to `Public` because an avatar is meant to be seen beside its owner's name. Refusing a
      document there is the same decision on the same evidence. A Module with no server-side binding has
      no server-side purpose question either; its worst outcome is a broken preview, not a hazard.

  - **Delivery makes active content harmless as of 2026-08-27**, which it did not. Both delivery routes
    returned the stored content type verbatim from the Site's own origin with no `Content-Disposition`
    and no `nosniff`, so a stored `text/html` or `image/svg+xml` was same-origin script running with the
    visitor's session. `mediaDeliverySafetyHeaders` is the one code-owned rule and deliberately not a
    setting, because the question is not what a Site wants to permit but what a browser does with the
    bytes, and that answer does not vary per Site: a closed inline-safe list of raster, audio, and video
    types, everything else handed over as an attachment, `nosniff` so the type cannot be improved on,
    and `Content-Security-Policy: sandbox` as the backstop for the day the list is wrong. A type nobody
    considered is therefore safe by absence rather than by someone remembering to exclude it.
    `image/svg+xml` is excluded on purpose and loses nothing: an attachment still renders through
    `<img>`, which loads SVG in image mode with scripting disabled. `application/pdf` is excluded
    because it carries its own scripting engine, and nothing in `@phis/ui` embeds one -- there
    is no `iframe`, `embed`, or `object` in the component tree.
    The rule reads the type actually being served rather than the Asset row: the served value is
    `head.contentType`, which the Provider reports, and deciding on anything else would harden a
    different file than the one leaving. Measured in the browser: the Builder's Asset library still
    draws 12 of 12 thumbnails, and the avatar round trip is unaffected.
    It was required rather than complementary, for two reasons that still hold. Content sniffing at
    upload is a floor and not a roof, because SVG and HTML are text without magic bytes and polyglot
    files exist; and the Site Space is deliberately unrestricted, so hardening the response is what
    makes that decision safe.
    Noted while measuring, not a defect: the Builder's thumbnails reach the browser through the Next
    image optimizer, which fetches the delivery route server to server and re-serves the bytes under
    its own headers. The hardening therefore governs what a person following a link receives, which is
    the case that matters, and the optimizer's own response is Next's to shape.

  - **Still unenforced: `allowed_storage_profile_ids`.** Deliberately, until there is more than one
    profile to choose between; it belongs with the S3 Add-on below.
  - **A Media write is authorized by the Space it writes into**, as of 2026-08-27, which is what makes
    a User Space usable by the person it exists for. `PHI_ACCESS_SITE_MEDIA` is Site Media
    administration and still governs the Site Space, which is not delegated capacity and holds what the
    Site publishes. Anyone else writes into a Space that is theirs to write into -- their own User
    Space, or a group's where they hold Contributor, which is what section 6 means by a Group Space
    being materialized by the first Contributor write. Availability and quota stay separate gates the
    write still has to pass.
    `requireMediaSpaceWriteContext` takes a resolver rather than returning a context to check later,
    because a check that has to be remembered is one that eventually is not: an upload names its Space
    in the query, a staged session already knows it, and the token routes read it from the session so
    the authority follows where the bytes actually land. A Module never gets an upload route of its
    own; only an Add-on may put server code beside a Module, which keeps the transport in Core.
  - **The Widget is not in any default preset.** A preset owned by the Auth Module referencing a Widget
    owned by Avatar would break wherever Avatar is not activated, because a Widget reaches the catalog
    only through its Module. An operator activates the Module and places the Widget, which is also what
    keeps the Profile page Auth's.
  - **An avatar is public, and binding one is what says so.** A file arriving in a User Space defaults
    to the `User` policy, which is right for a Space whose purpose nobody has named; an avatar's
    purpose is to be seen beside its owner's name, by whoever sees that name. The bind widens the
    Asset to `Public`, which is the Module setting visibility from the purpose an Asset was accepted
    for rather than an uploader choosing it. Widening rotates `delivery_revision`, so a copy cached
    while the picture was private stops being served under the old address.
  - **The first User Space Module is an Avatar Module**, settled on 2026-08-27. The Profile page stays
    with the Auth Module: email, name, locale and password are identity surfaces, and the preset that
    holds them belongs beside `account-security` rather than moving to whatever Module wants to add a
    picture. The Avatar Module contributes the Widget, declares `mediaSpaceKinds: ["user"]`, and
    activating it in the `app` Area is what turns User Spaces on -- the same path `@phis/ui/groups`
    already takes for Group Spaces. It does not move the Profile preset and does not own the page.
  - **A small task belongs in an Overlay, not a Page.** Choosing an avatar is a modal, and
    [OVERLAYS.md](../phis-ui/OVERLAYS.md) already carries everything for it: Core `modal` and
    `drawer` containers, Module contributions through `areaOverlays`, and `open`/`close`/`toggle`
    against `cms:<instanceId>`. What is missing is a link target that opens one. The resolved and
    persisted navigation target unions are both two-valued today -- Module route or custom path,
    page reference or external href -- and gain one member addressing an Overlay by
    `{ ownerModuleId, presetKey }` rather than by instance id, because an instance id is revision-bound
    and a navigation item naming one breaks at the next Area revision. This is the same indirection
    `routePresetKey` already provides for routes.
  - **Only Area-owned Overlays are linkable.** A Page-owned Overlay exists only while its Page is the
    current tree, so a link to one from a navigation surface would have to navigate first and open
    second -- two operations with state between them, not a link. An Avatar picker contributed through
    `areaOverlays` is Area-owned and therefore reachable from anywhere in the App.
  - **The link opens and carries nothing.** `OVERLAYS.md` forbids a generic Overlay from parsing a row
    identity, Form payload, or User id; an opener that needs a selection stores it first and sends a
    separate generic open command. The Avatar case needs nothing else: the Overlay opens and its Widget
    reads the actor through its own Provider. "Edit image X" is therefore not expressible as a link
    target, deliberately.
  - **A modal has no URL.** Overlay open state is transient Client state. A navigation item that opens
    one is in scope; a URL that opens one is not, and reflecting open state into the address bar,
    history, and the back button is a separate and much larger change that nothing has asked for.
  - **The Account menu becomes a navigation surface.** `PhiAccountMenuState` is a closed union with
    fixed slots -- `profileHref`, `settingsHref`, `logoutHref`, `onProfile`, `onLogout` -- so nothing can
    contribute an entry to it at all. As a surface it gains the existing
    `PhiCmsNavigationInjectionDescriptor` path a Module already uses to place an item in `app:sidebar`,
    with `exportedItemKeys` naming where a foreign Module may attach.
  - **The Account surface stays operator-editable**, which is what makes it cost no new contract. An
    operator who removes their own logout entry owns that outcome, and the damage is bounded: logout is
    `POST /api/v1/auth/logout` and the Account Widget already falls back to calling it directly when no
    href is configured, so the entry is a convenience rather than the only way out of a session.
    Recovery is the operation the Auth section below already specifies -- `phis-cli auth restore-preset`
    restores code-owned route and navigation presets while preserving unrelated customization -- and the
    same section's fail-closed publish diagnostic for a missing `/login` owner is the rule to apply to a
    missing required Account anchor. Editable, diagnosed, restorable: three parts, none of them new.
    The consequence for Modules is that an injected entry may be removed without the Module knowing, so
    a Module must not assume its entry is reachable. The Avatar Widget on the Profile page opens its own
    Overlay by signal and needs no navigation entry at all.
  - **Menus and dropdowns choose a `navKey`.** Nothing to build: the Sidebar, Header and Footer Widgets
    already take one from their presets, and `navKey` is a Builder Inspector config field. A future menu
    or quick-links control renders a surface the same way. Note that this governs where a tree is
    rendered, not who may edit it -- pointing a menu at the Account surface from elsewhere is allowed
    and useful.
  - **A command target is recorded and not built.** Logout is a command rather than a destination, and a
    third target kind for Modules contributing commands has exactly one candidate caller today. It waits
    for a second one, on the same reasoning as the transfer service below.
  - **A Module may seed a group** and set that group's quota override once, as a starting value. It
    never becomes a third layer in quota resolution.
  - **Group administration** landed on 2026-08-24 at `/admin/groups`, served by `/api/site/groups`: the groups with member count and
    Space usage, the members of the selected group, creating a group, changing a member's level in the
    cell it is read in, and removing a member. A membership contributed by a provider stays read-only,
    which the field states through `mutableWhen`. Adding a member landed the same day: a Form names the
    group, the person, and the level, fed by two fetching options providers over the administration
    routes. Those providers used to load once per page view, so a group created a moment earlier was
    only offered after a reload; as of 2026-08-25 a write announces itself through a shared options
    revision the providers subscribe to and carry in their load key, so the form offers what the page
    already shows. It reaches one browser tab: another viewer's write still appears on the next load.
  - **The App's own group page** landed on 2026-08-24 at `/app/groups`, served by `GET /api/site/groups`:
    which groups the actor is in, the level held in each, what that level allows, and the group's Space
    usage; selecting one lists its members. A member sees name, level, and -- when the group's
    `ShowMemberCompany` flag is set -- the company, never an address. A Manager administers their own
    group from the same page: the level is editable in its cell and a row action removes a member, both
    gated on `manageable`, which the control plane states per row rather than the interface inferring it.
    Adding a member landed too, fed by `GET /api/site/groups/candidates`: open to anyone who manages
    some group, capped, and answering with name and company rather than the address it may have been
    searched by. Typing narrows at the route: the options-provider contract now carries the control's
    search text, so a provider that answers a route is asked again as someone types and says
    `loadMode: "server"` so the control does not filter the answer a second time -- `loadMode` and
    `search` had been declared on the options config all along and were never read. Whether a group
    shows its members' companies is switched from the group row, and the column is left out entirely
    for someone who manages nothing. Retiring a group landed on 2026-08-25: a Manager ends the group
    they run, from either page; a retired group grants nothing, takes no new members, and leaves
    selection, with every affected member's `authorization_revision` moving inside the writing
    transaction. Its key stays reserved and administration lists it, which is also the only place
    it can be put back -- retirement removes the level that would otherwise authorize the return.
  - **Area decides who may name a Space.** Implemented as of 2026-08-24: the Media Picker offers a Space
    selector only in a live `app` Area partition, so a Builder canvas previewing the App stays on the
    Site Space, and a surface that may not select sends no `spaceId` at all. Administration still gets
    its own surface rather than a selector in the shared picker.
  - **Transfer between Spaces** is a change of custody and nothing else, revised on 2026-08-25 after the
    first real case was worked through. It has no generic endpoint: Core checks source access, state and
    target quota, the Module checks the occasion, the client names the occasion and never the target,
    and every transfer is recorded durably and queryably per Space. Submissions are created in the
    submitter's own Space first, which is what keeps a group from being flooded on someone else's quota.
    The Site Space is not a target: nothing produces publishable material outside it, so a promotion
    command would be a crossing without a case.

    It is not implemented, and deliberately not yet: nothing can call it. The occasion half needs a
    Module handler context, which `SERVER_ADDONS.md` section 10 describes and no code implements, and
    the two cases that motivate it -- a receipt into an accounting group, a file into a group that acts
    on it -- belong to Modules that do not exist. Building the service now would mean a contract nobody
    exercises. It waits for its first caller.
  - **Custody and audience are separate axes**, and today the delivery decision derives the second from
    the first. Section 6 of [GROUPS_AND_STORAGE.md](./GROUPS_AND_STORAGE.md) now states the two rules
    that keep them apart: `User` means the Asset's `created_by_user_id` -- and the Space owner where the
    Space is a User Space -- rather than demanding a User Space, and Module-mediated material is
    `Internal` so the Module decides on its own surface who sees it. `canDeliverMediaAsset` still
    implements the old reading, which makes "in group custody, private to its submitter" inexpressible.
    It changes together with the first transfer, because until one exists nothing can reach that state.
  - **Visibility is the delivery policy**, set by the Module from the purpose an Asset was accepted for,
    never chosen by an uploader. The default now follows the Space an Asset is created in -- `User`,
    `Group`, `Public` -- as of 2026-08-24; a Module naming a purpose still overrides it.

  Upload into the selected Space landed on 2026-08-24: the Collection view shows which Space it reads,
  and an upload started there inherits it -- `initPhiMediaUploadSession` names it as the `spaceId` query
  parameter, the way every Media route names one, while the Folder and the flags stay in the body.
  Measured end to end on the App fixture: the Asset arrives in the group's Space with the `Group`
  delivery policy. No surface deletes a group; retiring one is what ends its service, to the shape in
  section 2 of [GROUPS_AND_STORAGE.md](./GROUPS_AND_STORAGE.md). A retired group's Space is not retired
  with it: it stays where it is and comes back when the group does, readable throughout so its contents
  can be moved out, and closed to writes. The `media-folder` Form endpoint stays pinned to the Site
  Space deliberately, because it is the Builder path. CMS, Builder, Editor, and `phis:asset` resolution
  stay pinned to the Site Space.
- The Provider-neutral upload-plan ABI landed on 2026-08-25. `init` answers with a typed plan the
  Storage Provider issued -- `proxy-stream` today, `presigned-put` defined beside it -- and a generic
  Client executor carries it out, refusing a kind it does not know rather than falling back to a
  transport that would send the body elsewhere. The session records which plan it was issued, Core
  accepts a body only for the plan that says so, and finalize settles the staged object with the
  Provider before judging size and duplicates, so every plan is judged in one place. Multipart is
  deliberately not specified yet: it is added as a kind when the S3 Add-on implements it, rather than as
  a schema nobody fills.
- Expired quota reservations are released as of 2026-08-25, by the request that needs the capacity
  rather than by a sweep: an upload init releases its own Space's expired sessions in one statement
  before it reserves, every Space read discounts what those sessions still hold over the same
  predicate, and finalize moves the bytes and closes the session in one transaction so the same bytes
  can never be subtracted twice. What remains is the staging object an abandoned upload left in
  storage, which no request can reach -- a bucket lifecycle rule for S3, a deliberate operator command
  for Local.
- Replace Support's independent effective membership path with general Site group membership while
  retaining a Support-owned team profile for routing, queues, and ticket assignment. Increment the
  affected Site membership's `authorization_revision` for every effective group membership change. Not
  started.
- Implement [DIRECTORY_PROVIDERS.md](./DIRECTORY_PROVIDERS.md)'s provider-ready authority metadata,
  per-operation capabilities, and Directory-binding repository boundary on top of the existing `groups:v1`
  route. The `directory_connections`, `directory_user_bindings`, and `directory_group_bindings` tables
  exist but are unused. Do not implement an external Directory Provider in v1 and do not make the local
  UI/API assume every resource is writable.
- Validate Asset audience during publish. Promotion into the Site Space is deliberately not part of
  this: section 6 of [GROUPS_AND_STORAGE.md](./GROUPS_AND_STORAGE.md) settled on 2026-08-25 that the
  Site Space is not a transfer target, because nothing produces publishable material outside it.
- Add DB/service/API regressions for cross-Site, cross-Space, self/group membership, Core role matrix,
  provider disable/restore, quota races and expiry, duplicate isolation, Folder ownership, protected
  caching, delivery-revision rotation, reference deletion, and absence of Storage-key/public-URL
  fallbacks. Present today: Asset update, delivery policy, media Folder and metadata form endpoints.

## P1: Finish transactional Site bootstrap and rolling releases

- Close the remaining first-install orchestration gap: a new Site currently requires `phis site add`
  before `phis init`. Provide one documented, transactional CLI flow that creates and validates the Site
  registry state and then materializes its scaffold, without leaving a partially registered Site or a
  partially generated source tree on failure.
- Replace the remaining hard-coded scaffold dependency versions with the exact compatible package set
  resolved from the installed `phis` release and selected package manager. Verify availability and record
  that immutable set in the generated manifest and sole matching lockfile. Include active optional Site
  Module packages and generated external build state in this release resolution, but never add
  `@phis/groups` or another optional Module to the base scaffold implicitly.
- Make the lifecycle semantics explicit and complete: `init` currently installs only when `--install` is
  supplied and does not build, while `update` installs, checks, builds, and creates an artifact. The
  documented first-install path must be able to produce a verified runnable Site in one operation, with
  consistent install, typecheck, build, artifact, and failure-cleanup behavior.
- Add an end-to-end scaffold test that creates a Site in an empty temporary directory, installs its
  dependencies, typechecks it, performs a production build, and verifies the generated route families.
  This test must run without a `phis-site-skeleton` checkout so independence from the development
  Skeleton is continuously proven.
- Extend the implemented manifest-based `phis reconcile` path so dependency refreshes preserve installed
  optional Modules, their generated external build state, Site runtime secrets, Site data, and every
  explicitly Site-owned file. The permanent Core `@phis/server/groups:v1` capability exists
  independently of the optional `@phis/groups` UI Module; reconcile must neither install nor remove that
  Module unless an explicit Module operation requests it.
- Complete the existing update/artifact path by resolving the compatible package and Module set through
  the configured package manager before the build and recording its lockfile, scaffold manifest, external
  Module build state, and bound Add-on capability requirements in one immutable versioned artifact.
  Production Instances must deploy that exact artifact and must not perform independent builds that could
  diverge.
- Deploy the artifact as a rolling release across the Site's configured Instances. Build and health-check
  a candidate before promotion, keep at least one previously healthy Instance serving traffic throughout
  the rollout, remove an Instance from routing before replacing it, and stop on failure with the previous
  release still active. A Site with only one permanent Instance requires a temporary candidate slot on a
  distinct port, socket, or isolated network namespace before traffic may switch.
- Verify the reconstructed routes, dependency graph, production build, health endpoint, active release,
  and proxy target after init, reconcile, update, or rollback. A failed verification must never promote a
  partial scaffold or leave every Instance unavailable.

## P1: Add an S3 Storage Add-on

- Add an operator-installed S3-compatible Add-on package using the one internal
  service-provider ABI. Keep provider SDKs server-only, declare no browser Runtime Module dependency,
  and support endpoint, region, bucket, prefix, path-style, encryption, and secret references through a
  schema-validated Storage Profile.
- Make `phis-cli` install, validate, configure, rotate secrets for, enable, disable, and diagnose Storage
  Provider Add-ons and Site profiles. Site administration may select only operator-allowed ready
  profiles and must never receive credentials or install code.
- Implement the S3 Provider's presigned PUT and multipart plans against the Provider-neutral upload-plan
  ABI and init/finalize flow completed in P0. Do not add an S3-specific browser endpoint or second upload
  lifecycle. Abort and expiry must clean staging objects and quota reservations.
- Measured against Garage v2.3.0 on 2026-08-28, before any of this was written: every operation the
  `PhisMediaStorageAdapter` needs is available -- PutObject, HeadObject, ranged GetObject for
  `readObjectHead`, CopyObject with `MetadataDirective: REPLACE` for the finalize settle, ListObjectsV2,
  presigned PUT, presigned UploadPart, CompleteMultipartUpload, AbortMultipartUpload, and a 404 on a
  missing key. Two things the implementation must carry: the AWS SDK signs an empty CRC32 into a
  presigned URL unless the client sets `requestChecksumCalculation: "WHEN_REQUIRED"`, which no browser
  can satisfy and a strict server rejects as `InvalidDigest`; and a content type the plan signed is not
  enforced on upload there, which costs nothing only because finalize measures the bytes rather than
  believing the claim.
- The server secret store landed on 2026-08-28, which is what the Provider needed before it could hold
  credentials at all: `phis.server_secrets` keeps every secret encrypted under a root key that stays in
  each instance's runtime configuration, so a second instance reads what the first one wrote instead of
  needing the file copied to it. `phis-cli secret init-key|set|check|list|del` manages them and never
  prints a value; `set` reads from standard input and says so out loud when `--value` puts a secret in
  the process list. What remains for the Provider is the resolution path from a Storage Profile: the
  service context section 10 promises does not exist, so a Provider factory has no way to ask for the
  reference its profile row names.
- The Add-on landed on 2026-08-28. `@phis/storage-s3` implements all ten adapter methods against
  the `@phis/contracts` types, is installed, enabled and reconciled in the development deployment,
  and moves bytes from a Storage Profile row into a bucket -- verified end to end against Garage 2.3.0,
  including the settle path finalize uses. It owns no tables, so `migrationVersion` is 0 and the missing
  migration runner does not block it. What remains before it is usable by an operator rather than by a
  test: multipart is not implemented, so an object above the 5 GiB CopyObject limit is refused loudly
  rather than copied in parts; and `phis addon install` cannot install a workspace package without
  `--package-version workspace:*`, which is a development detour rather than a supported path.
- Resolved on 2026-09-02: the MD5-in-a-SHA-256-column problem is gone, along with the reason it existed.
  `checksum_sha256` became `checksum_algorithm` + `checksum_value` in all three tables, an Adapter now
  attests what it can rather than having its `ETag` read as a content hash, and duplicate detection is
  restricted to identity-grade digests. A multipart object whose endpoint can only attest a CRC is
  accepted and verified, and simply not compared -- see `GROUPS_AND_STORAGE.md`.
- The browser path was verified on 2026-08-28 and closed the last unknown: with the Site Space pointed
  at the S3 profile, a real browser carries a presigned PUT to the Provider's origin, finalize measures
  the bytes, and delivery reads them back out of the Provider unchanged. It needed a bucket CORS rule,
  which nothing sets or checks today -- `phis-cli` should configure one when a profile is provisioned
  and refuse a profile whose bucket rejects a preflight from the Site's own origin, because the failure
  is otherwise invisible to the Site: the body never leaves the browser.
- Decide who owns the object key prefix. Core writes `sites/<key>/…` and an S3 profile can add its own
  bucket prefix, so a profile configured with `sites/<key>` produces `sites/<key>/sites/<key>/…`.
  Neither is wrong and the two compose silently; a profile form should say what Core already prepends.
- The service-provider path landed on 2026-08-28: a Storage Provider now comes out of the static build
  manifest through the manifest's `serviceProviders` descriptors, with the dispatcher's registry checks
  applied before a factory is reached. The process-local `registerPhisMediaStorageProvider` is gone, so
  a restarted process and a second instance resolve the same Provider the same way. What is left for
  S3 is the package itself.
- Move Auth onto the same store. `readAuthSecret` returns cleartext from `config/phis-runtime.json`,
  which is both the last unencrypted secret and the last one that cannot be read by a second instance.
  It touches a running authentication path, so it is its own step.
- Add Storage-profile selection and quota defaults to the Asset Module's Admin settings, plus per-user
  User-Space quota overrides to User administration. These settings call Core services and do not create
  S3-specific UI or endpoints.
- Add release/instance readiness checks proving that all serving instances contain the same provider
  manifest and can resolve the required secrets before a Site profile becomes available.

## P2: Add the Groups package, Directory Providers, and Storage migration operations

- Publish `@phis/groups` as a separate `phis-cli`-installable Module package tree rather than adding its
  Admin/App pages, presets, Providers, Controllers, Forms, labels, or management code to
  `@phis/ui`. Bind it only to the permanent Core `@phis/server/groups:v1` capability; Module
  removal must leave Core persistence, policies, and group-aware resources intact.
- Implement the first reference Directory Add-on against
  [DIRECTORY_PROVIDERS.md](./DIRECTORY_PROVIDERS.md). Prefer scoped push/delta synchronization, support
  paginated direct queries only for authorized search/import/binding operations, and never query the
  remote Directory synchronously for ordinary authorization. Add-ons reconcile through Core services
  and never write authorization tables directly.
- Support multiple Directory connections, stable opaque external subjects, user/group bindings,
  provider-owned field authority, optional writeback capabilities, source-aware membership assertions,
  bounded staleness, staged reconciliation, and precise `authorization_revision` updates. Preserve local
  and other healthy source assertions when one Provider becomes unavailable.
- Add reference LDAP/Active Directory, SCIM, or Entra packages only as separate Add-on
  implementations. Their SDKs, protocol configuration, and secrets remain server-only and do not enter
  `@phis/groups`, `@phis/ui`, Site packages, or browser bundles.
- Add resumable profile migration jobs that copy and verify Assets and variants, atomically retain Asset
  ids while switching profile/key bindings, preserve the old object for a bounded recovery window, and
  never reinterpret failed work through Local fallback.
- Add usage reconciliation, orphan/staging cleanup, provider health and capacity diagnostics, optional
  scanning/quarantine integration, CDN projection, and operator-visible migration progress. Storage
  prefix listing remains a maintenance tool and never replaces the database Asset catalog.

## P2: Give every Area route a package namespace, and settle Public path collisions

Designed 2026-09-06, and largely built the same day. The item asked for a Site-owned base path and an
activation-time collision decision instead of a compile-time failure. The answer turned out far smaller
than the machinery first drafted for it, because only one namespace is worth contesting.

**Built:** the package namespace and the mount without `basePath` (`b0983148`), the two visibility rules
(`e0b90533`), Form Areas (`75592ce8`), and the Page identity that replaced `pageKey` (`9e2db6f5`) --
which took the catalog-wide ownership check and the active-table Page collision with it, and dropped
`home`. Then the enable-time question itself: the assignment a Site writes and the route table reading
it (`799ab02f`), the dialog the Modules workspace asks it with (`7474dbd2`, `03e9c38d`), the server's
shape check on the way in (phis-server `73665eb`), and `@phis/dev` as the Site package it can be seen
with -- `/contracts`, which nobody wants, beside `/login`, which Auth has. **Not built:** a standing list
of the Site's Public addresses, the update command's report, and the public SEO surface. Taking an address
over from its holder was considered and dropped.

**The Area root, designed and built 2026-09-07** (phis-ui `2a29db09`, phis-server `b92bcb6`,
phis-dev `12ba99f`). `/` is drawn without the Area's five own Regions --
`chrome: "none"` never resolves them -- and the six Page-owned ones draw as on any page, each from its
own slot route. That cheapness is the point: a landing page buys the seconds in which the first real
page's chunks, CSS and fonts arrive, and Next's link prefetch does the fetching, so it needs no
mechanism of its own. Behind a sign-in nobody lingers, which is why those Areas forward instead.

The Select in the /shells header mixes a *what* with a *how*, and its "Landing page" entry names no
page at all -- it only strips the forward. Proposed: two Selects side by side in the workspace header,
where the third column stands empty on /shells today. The first says what `/` does -- the first
navigation entry, a Page it forwards to, or a landing. The second names the landing, and is enabled
only while the first says so and there is something to name. Beneath them one line states the result,
carrying the Page's own title and where its tree comes from, the preset or a revision of the Site's
own -- the same distinction as on any Module Page, and the answer to what a Module update will still
reach. No warning and no per-Area restriction: forwarding is what naming a working Page means, and
nothing needs policing.

The applicants for that slot are the second half of the same question, and they are unlike the
addresses in every way that matters. An address is a necessity: a Module whose route is taken cannot
do its work, so it is renamed or it stays off, and that is why the dialog refuses to enable without
an answer. A landing is an **offer**. A Module says "I have a landing for Public and one for Admin",
the Site picks one of everything offered, and a Module whose offer is declined loses nothing: it
keeps every address it has and goes on working. Nothing is renamed and nothing is refused, because
nothing was needed.

One applicant takes the slot without a question, which is the ordinary case and would be silly to
ask about. But it lands in the **draft** like every other change and reaches visitors on publish --
otherwise a Site whose operator decided it has no landing would get one the moment a Module was
installed, live and unasked.

Both Selects store a Page reference, never a path, in `preset.config.shell.rootRoute` as today.
Disabling the second needs no new capability -- `enabled/change:boolean` is inherited by every
renderable block and already lands as `commandDisabled` in the control -- but it needs a sender: a
Select emits its value as a string, and nothing turns "the value is landing" into a boolean, so the
Builder controller dispatches it, as it does for the two Modules-workspace dialogs. The applicants are
in the snapshot already: `buildPhiBuilderModulePresetPagesByArea` walks the declared catalog rather
than the compiled route table, so an offer that lost is still there with its owner and preset key.
Where there are none the provider stays and answers with an empty list; two ways to say "nothing to
choose" would be two states that look alike and arise differently.

A Site that wants its own landing needs no case of its own. An accepted offer is a Module Page like
any other: it draws from the preset until somebody opens it in /pages, and the first draft snapshots
what the preset produced, after which the stored revision answers instead. Accepting nothing is the
other half of the same sentence -- the tree at `/` is then empty and gets authored there, with the six
Regions that belong to the Page rather than to the Area.

That leaves one trap, and it is closed in /pages rather than at render time. The forward is not a
property of the mode; it is the whole content of the root preset's tree, and a stored revision
replaces a preset's tree. Authoring the root Page while the Area forwards would therefore switch the
forward off without anyone touching the Select. So: while `/` forwards, it is not offered in the page
selector of /pages -- no entry, no revision, no contradiction. The filter belongs in that Select's own
options provider and not in `resolvePhiBuilderActivePageCatalog`, which also feeds /revisions, where
the root Page's history should stay visible, and the applicants list, which needs exactly those nodes.
Two things follow: the Area's root route has to travel with the controller preload the way
`publicRoutePaths` does, because today only /shells is handed it; and the Page comes back with
whatever it had when the Area is switched to landing again, since nothing is cleaned here either. The
rule prevents rather than repairs -- a revision written at `/` before it exists still beats the preset.

**Built as described, with one part left out:** there is no line stating the result beneath the two
Selects. Between them they already say what `/` does and which landing stands there, and the only
surplus was where a landing's tree comes from -- which went into the applicant's own option line, as
the Module's name and, where the Site has taken the Page over, a word saying so. A line of prose
would need a Widget type that renders provider-driven text, which does not exist.

**What the flag settled:** a Route preset can now say that it is a landing offer. The Area root's
forward page and a real landing look identical from outside -- a preset with `path: "/"` -- so the
applicants could not be listed without a word for it. It is a flag on `PhiCmsRoutePresetDescriptor`,
beside the `path: "/"` it keeps: the path is the application, as the
type's own comment already says, and `findPhiPublicRoutePathCollisions` already steps over `/` so the
address question never touches it. `public-welcome-page` carries the flag; the `<area>-root-page`
forwarders do not, and that is exactly the distinction nothing could express. Three readers follow
it: the applicants provider filters on it, the route table admits exactly one `/` -- the chosen
one, or the single applicant -- and the /shells Select offers the rest. It is not a second address: a
declined offer is simply not routed, and the Module keeps every other route it has.

**A Module that is not there is a state, not a fault** (2026-09-07). A stored selection may name a
Module this build cannot serve -- a deploy ahead of its rollout, a rollback, a removed package -- so the
read drops it and the write refuses it, and the Modules workspace shows what was dropped before the next
save writes the selection without it. Nothing is cleaned when a package is removed: the Site keeps the
record until somebody saves, the Area revisions keep it after, and a removal made by accident is
reversible. A block whose Module is gone draws its diagnostic in a workspace and nothing at all on a
live page, and a Layout that cannot be drawn keeps its children rather than swallowing them. Switching a
Module off now states what it stops drawing, counted from the published trees over
`/api/site/cms/module-usage`; `phis module del` counts the same thing over its own pool and refuses to
take a package out of the build while its blocks stand on published pages, unless `--force` says to carry
it out anyway. The row for a Module that is not in the build needs no action of its own: save is strict,
so the next one writes the selection without it.

The dialog offers another address and refuses to enable without one, and that is the whole answer:
taking the address over from the Module that holds it -- the other half the design once described --
was dropped on 2026-09-07. An address is settled by whoever asks for it second, and an operator who
wants the other order moves the first Module instead -- which the switches already allow, because checks
run against the draft's active set: switching the holder off frees the address, switching the other one
on takes it, and switching the first one back on makes it the one that asks. **Still open:** a standing
list of the Site's Public addresses, editable while everything stays enabled, so that order need not be
reached by switching.

**A Site Page can hold an address too, designed 2026-09-08 and not built.** The collision check in the
path-change command looks only in `site_page_scopes`, and a Site path is validated against `/api`,
`/_next`, `/operator` and `/setup` alone. Site against Module is therefore unchecked in both directions,
in Public and outside it.

The rule is the one already in force, with a second kind of holder: whoever asks second bears the cost.
In Public a Module that finds its declared path held by a published Site Page is offered another address
by the same dialog, which needs only a second reason to give for why an address is taken. Outside Public
the newcomer has nothing to yield with, because its path is its package identity: a Site Page authored on
`/acme/shop` before that package was installed makes the activation refuse, naming the occupied path, and
it stays refused until the Site moves the Page. That is rare and acceptable as long as it is written down
for Module builders, which it now is in `phis-ui/THIRD_PARTY_MODULES.md`. One complement keeps it to that
single order: a Site Page may not be moved onto the path of a package active in its Area. Moving the Page
is cheap once durable redirects exist, because a published address survives the move as a redirect.

**The collision dialog does not say that an address is already public.** It knows -- the published Area
revision routes it -- and an operator answering the question deserves to see the difference between
renaming something nobody has visited and moving an address that stands in an index.

**Two namespaces, and only one question.**

- **Every Area but Public**: a Module's routes live under its own package, `/<scope>/<package>/…` --
  `/phis/ui/theme`, `/acme/shop/orders`. How a package organises its routes underneath is its own
  business; it can only collide with itself. Package names are unique, so collisions between Modules are
  impossible by construction rather than resolved by a mechanism. These Areas are authenticated and never
  indexed, so the extra segments cost nothing.
- **Public**: no namespace at all. It is the Site's own address space, it is the only indexed one, and a
  vendor's package name has no business in it. `/login`, `/contact`, `/terms-and-conditions` stay what
  they read like.

**There is no first-class precedence, because there is no first-class route.** `phis/ui/auth` holds
`/login`, `/logout`, `/register`, `/reset-password` and `/confirm` as an ordinary Module, and can be
switched off and replaced by another Auth Module. The future `phis/dev` package holds `/`, `/contact`,
`/terms-and-conditions` and `/examples` as examples, replaceable the same way. Every other package we
ship is external and follows the same rules. The whole tie-break, the reserved prefix and the frozen v1
surface fall away with it.

**The one remaining question is asked when a Module is enabled for an Area.** If a Public path it
proposes is taken, the dialog asks for another one or offers to take it over; declining means the Module
is not enabled. No half-state exists: a Module is active with every route addressed, or it is not active.

- Taking it over is the same rule seen from the other side: the previous holder's route stops resolving,
  so that Module is deactivated until it names a path of its own. No separate mechanism, and no Module
  half-addressed.
- Outside Public an update may add as many routes as it likes -- they are under the package and cannot
  collide -- so what follows is a Public matter only.
- A Module update that introduces a colliding Public path deactivates the Module until the route resolves
  again -- it is what moved. Deactivation is a state with an exit, not a verdict: naming a free path
  brings the Module back. This belongs in the output of the update command, before the rollout, not only
  in a log an operator finds afterwards.
- Deactivating does nothing else. Nothing is rebuilt, the routes simply stop answering, and an assignment
  already made stays made.
- Checks run against the draft's active set, so freeing a path by switching one Module off and claiming it
  with another works in a single editing session.
- The dangerous case -- somebody replaces Auth and locks themselves out -- already has its recovery in
  `phis-cli auth restore-preset`.

**Where an assigned path is kept, and what it must not touch.** The answer from the dialog goes into the
Area preset's `modules` namespace, beside `runtimeModules` -- a map from `moduleId/presetKey` to a path,
written by the same route, with the same draft and publish behaviour, which is also what makes "check
against the draft's active set" free. It is a value the descriptor compiler reads while composing the
path; the preset tree stays untouched.

That distinction is the point. Assigning a path must not pull the structure preset into the draft: a Page
still renders straight from its preset, with no roundtrip to the database. Only a structural edit made in
`/pages` or `/shells` copies the preset into the stored config, and that is unchanged --
`builder/persistence.ts` already rejects a modules payload carrying `config.shell`.

The root slot is no exception to that. `config.shell.rootRoute` names which applicant stands at `/`; it is
a selection, and naming it copies no preset either. What copies a preset is an edit to the tree itself --
a Widget added, a background changed -- made in `/shells`. Which is why a second applicant costs nothing:
the assignment that already holds is written as a value, the Builder gets a select box to change it, and
the first one configured keeps the door until somebody picks another.

**The Area root is a slot, not a path.** `/` belongs to the Area's base Module and is drawn without the
Shell. A Module route declaring `path: "/"` is an application, granted immediately when nobody else
applies; several applicants are a list to choose from in the Shell draft, never a conflict. By convention
this is the Site package's business rather than a functional Module's, but it is not enforced -- a vendor
may well ship a better landing page than we do.

- The Shell draft designates one of three: the Area's own page, a forward, or another Module's page
  rendered in place. The third is why the slot exists: the forward is cheap -- a 307, no intermediate
  document -- but its destination is an ordinary page and arrives inside the Shell, which is exactly what
  a landing page must not do. `phi-area-root-redirect-tree` already names the home for this as
  `preset.config.shell.rootRoute`.
- Order: a written assignment, then a sole applicant, then the Area's own page. "Already decided" includes
  an edited or published page standing in the slot, so the pass-through applies on a fresh Site and not
  afterwards. When a second applicant appears the currently valid assignment is written first, so the
  front door cannot silently revert.
- A designated page stops answering its own route and its navigation entry points at `/`. One page, one
  address. A Module with two applications is refused where the package is composed.

**A route mount stops being a path mechanism, but stays.** Every Area but Public still needs its settings
container, and a Module still needs a published name to hang itself under -- otherwise each package would
have to hardcode the navigation item key of a container another package owns. So
`PhiCmsAreaRouteMountDescriptor` keeps `mountKey`, `navKey` and `parentItemKey` and loses `basePath`, and a
route's `mount: { mountKey: "settings" }` stops meaning "prefix my path" and means only "put my entry in
that container". The path comes from the package namespace either way, so it is unique without the mount,
and `buildPhiRuntimeModuleRouteSegment` with its `+` segment leaves the codebase.

- The container therefore has no address of its own. `/settings` is not a page in any Area; it is a
  navigation node whose children are ordinary pages under their packages. That removes the question of
  what an empty container's base does -- there is no base to answer.
- A container hides when no child of it is visible, the way an item hides when its target is unrouted.
  These are two rules, not one: an item is judged by its target, a container by its children.

**A navigation label is not an identity.** A position is `navKey/itemKey` and its target is a route; the
label is free text the Builder may rewrite at any time. Two Modules both calling their entry "Settings" is
therefore not a collision -- two targets that happen to read alike -- and nothing may dedupe, order or
refuse by label. Where it confuses a menu, the Builder renames one; the system cannot know which of the
two is the wrong one.

**A Module may not gate an Area's slot behind its own role.** Core roles may narrow -- the Area gates
anyway, and the Admin root narrows further with a Core role today. A Module-provider role may not, for the
root or for a navigation container. `isPhiViewerAccessPolicyProviderOwned` already draws the distinction;
applications for a slot use it with the narrower allowance and are refused where the package is composed.

**Two things built regardless of any of the above.** A navigation item whose target route does not answer
hides, and so does a container left with no visible child -- resolved against the active route table, so
the rule holds by itself once a Module can lose a path. And the read no longer refuses: where two active
routes want one address the first claim answers and the second is absent, rather than the whole table
failing to compile.

**Add the rest of the public SEO surface:** `robots.txt`, a sitemap over published Public pages, canonical
URLs, and durable redirects when a Page path changes. Renaming an indexed path without a redirect is only
acceptable while nothing is indexed. The sitemap needs a decision first: the Site has locale prefixes, so
either one entry per locale with `hreflang` alternates, or the default locale alone.

**Canonical** means `alternates.canonical`, which nothing emits today. The duplicate that makes it worth
having is our own: `config.shell.rootRoute` renders a Page in place at the Area root, so `/en/` and
`/en/terms-and-conditions` both answer 200 with the same document. That was the point -- a landing Page
must not arrive through a forward, inside the Shell -- and the canonical is what pays for it. Not to be
confused with `canonicalHref` in `server-helpers/cms-route.ts`, which is a computed 307 for a wrong
locale prefix and shares only the word. `hreflang` alternates live in the same metadata field, so they
wait on the same locale decision as the sitemap.

**Durable redirects, designed 2026-09-08, not built.** Renaming a Page path drops the old address to a
404 with no trace. Internal links do not notice -- references persist identity, never an href -- so what
breaks is everything outside: bookmarks, foreign links, and the index entry with its history.

- *One source.* A Site-authored Page whose path was published and which the Builder then moves, in every
  Area and not only Public. Module addresses are not a source, and the reason is structural: in a Public
  collision the newcomer yields and never the holder -- taking an address over from its holder was
  considered and dropped on 2026-09-07 -- so a published Module address cannot be pulled away, and
  outside Public a route lives under its package path where two packages never meet. The off/on gesture
  that lets an operator reverse the order does move a published address, but it lands in a case already
  decided: the address has a new holder, or it has none, and neither takes a redirect. A package update
  that changes a declared path is the only move without a Site gesture, and belongs to the standing
  address list rather than here.
- *What a row holds:* the old path and the target, where the target is a structured internal reference --
  `site_page_scopes.id`, the variant the reference codec already issues -- and never the target path.
  That is what makes `/a -> /b -> /c` two rows that both resolve in one hop to wherever the Page is
  today: no chains, no cycles, no hop limit.
- *The trigger:* the publish that promotes a pending path, described in the item below. It is the one
  place a live Site path changes, and it is the same place a Module address changes, so one comparison
  writes both kinds of redirect instead of two mechanisms doing it separately. The condition is that the
  Scope had a published revision before this publish: never published means the address was never
  public, and withdrawn means it has been a 404 since, which a redirect would undo.
- *The invariant:* the history holds only paths that no live Page occupies. A new Page claiming a
  remembered path deletes that row rather than being shadowed by it, and a Page renamed back onto its old
  path drops the row it made. Resolution order then does not matter, because the two sets never
  intersect -- which is why this needs no precedence rule and no fallback.
- *At runtime* the lookup sits on the miss path only, so ordinary traffic never pays for it. A hit
  answers 301 to the Scope's current path. The locale prefix stays outside it, since paths are
  locale-neutral, so `/de/old` reaches `/de/new` by itself. The target must be live -- not tombstoned,
  and published -- because a 301 into a 404 is worse than the 404.
- *Open:* whether the Builder shows the remembered addresses anywhere. Proposed no, for now: the
  invariant frees a path the moment somebody needs it, so there is nothing to administer.

**A Page path changes through draft and publish, built 2026-09-09.** Renaming a Page was the one
content-shaped change that bypassed the draft entirely: the command wrote the Scope column, kept the
revision pointers and recorded nothing, so the live Site changed the moment an operator typed while
every edit to the page itself waited for a publish -- and the rename could not be taken back. Now the
command writes a pending path and the publish promotes it.

- *Where the pending path lives:* `site_page_scopes.draft_path`, and **not** the working draft
  revision's `meta_json`, which is what this item first proposed. Two things decided it. A page
  revision's `meta_json` is rebuilt from scratch on every save and a new revision is written each time,
  so a pending path stored there survives only as long as somebody remembers to carry it forward -- and
  the pending paths need a partial unique index of their own, which is the guard this design leans on
  and which a JSON field cannot carry as plainly. What that costs is the Undo/Redo entry this item
  claimed would come for free: a rename is still not in the undo stack, only in the draft.
- *The guard runs twice, and only the second one is the truth.* When a pending path is written it is
  checked against the live and pending paths of that Area so the Builder can object early; that check is
  a query, and the concurrency test already shows a query alone lets two writers through. At publish the
  partial unique index decides, and a publish that loses has to fail with something an operator can act
  on. Advisory then authoritative is the shape the Module address question already has, where checks run
  against the draft's active set and the activation settles it.
- *Publish becomes a path operation.* In the same transaction that swaps the revision pointers, a draft
  carrying a pending path updates the Scope column and writes the redirect row. The audit event naming
  old path, new path, Scope, Area and actor moves there too, because that is where the path changes.
- *Nothing else has to move.* Internal references persist Scope ids, so they resolve to the old path
  before the publish and to the new one after, with no rewrite anywhere. `rootRoute` names a Page rather
  than a path. Module route assignments already live in an Area revision and already publish.
- *The Builder has to show a pending path* wherever it shows a path -- the Page catalog, Page settings,
  navigation target pickers -- or the operator reads an address that visitors do not have. Routing stays
  on the published path: a pending path is text, not a working address, and making it route would mean a
  second route table for drafts.
- *What this rewrote:* the "Explicit path change command" section of both REFERENCES.md files, and the
  sentence claiming that publishing never changes a Scope path. `site-page-path-change.pg.test.ts`
  gained the pending-path index and the cancel case; the Builder now says a rename takes effect on
  publish. **Still open:** Builder shows a pending path only in that message, not in the Page catalog,
  the Page settings or the navigation target pickers, where REFERENCES.md now says it must.

**The Area states the head of its Pages, and the head is written** (2026-09-08, phis-ui, phis-server). The
Shells workspace header lost its two root-route Selects to an Area settings dialog -- a header is about the
canvas, and everything the Area says about itself belongs together -- and the dialog now asks four more
questions in two groups. *Page titles*: a title template with `%s` standing for the Page's own title, and a
default title for Pages that name none. *Search engines*: whether the Area may be indexed, and whether its
published Pages are listed in the sitemap.

All four are stored under `config.shell.meta` beside `rootRoute` and travel with the structure draft. The
key was `seo` and holds four answers now, which is why it was renamed: a tab title is not a search result.
The two groups are answerable by different Areas -- the titles everywhere, because the Admin wants its own
tab title, and the two switches only in Public, which is the only Area anything indexes. Elsewhere the
switches state the fact and are shown as unanswerable.

The titles and `robots` are read: `next/area-route.tsx` builds its metadata through
`buildPhiAreaPageMetadata` rather than assembling it inline. The title it returns is *absolute*, because
the Root Layout states a template for the whole Site and an Area that stated its own has to replace it
rather than be wrapped by it; an Area that stated none still gets `%s | <site name>`, which is what the
Root Layout always did. Every Area but Public is `noindex` whatever is stored, so a Site that never opened
the dialog still keeps its Admin out of the index.

The write path is strict, as the switches' was: an unknown key, a non-boolean switch, a non-string title,
a title over 200 characters, and a non-empty template without `%s` are each refused. That last one is not
a formatting slip -- a template without the placeholder gives every Page in the Area the same title, which
nothing downstream can detect. **Still unread:** the sitemap switch, which is the surface above.

## P2: Auth Module replacement and preset recovery

`phis-cli auth restore-preset --site <site-key>` is implemented, idempotent, and verified before it
commits. It does two things and no more: it reinstates the first-party activation across Public, App, and
Admin, and it sets every Auth-owned Page back to unedited -- pointers and deletion mark cleared, so the
installed code preset is what loads. Both are found generically, the Pages by `owner_module_id`, so the
control plane needs no list of what the Module contributes. Selection order is preserved, so an already
correct Area writes no revision. Before committing it reads the Site back: an unowned Public `/login`
rolls the whole operation back with the diagnostic, and a provider left active outside the three Areas,
or a Public Area with no Site revision at all, is reported as a warning rather than a failure -- neither
is inside this command's remit to change. Navigation is out of scope for the reason recorded in
`AUTHENTICATION.md`: restoring an injected item would require Module metadata the control plane cannot
hold without copying it.

What remains:

- Add one atomic Auth Module replacement operation for the selected Site. It must deactivate conflicting
  Auth UI provider Modules in the affected Areas, activate the replacement's compatible Area projections,
  verify that exactly one active Public provider owns the canonical `/login` route, and report every
  activation and preset change. Do not derive the login path from an NPM package name.
- Decide where the capability check runs. The control plane holds no Module metadata, so it cannot verify
  that the selected Admin/App projections provide their declared `site-settings`, `account-security`, or
  in-place `primary-login` capabilities. `restore-preset` needs no such check -- its target is the
  first-party Module by definition -- but replacement does, and that check belongs wherever the Module
  catalog is resolvable. The control plane can only read what the Builder already materialized into the
  Area preset, which is exactly what the restore verification does today.
- Keep replacement idempotent under the same rule repair follows: preserve unrelated navigation
  customization and historical Page revisions, and clear or clone only the Auth-owned effective preset
  pointers, overrides, and tombstones the selected operation requires.

## P2: Advanced multi-host Instance and round-robin topology

- Generate proxy upstreams from all healthy Instances instead of resolving only the current primary
  Instance. Instances on different hosts may use the same port; Instances on one host require distinct
  ports or an equivalent isolated socket/network namespace.
- Distribute the one immutable P1 release artifact to remote Instance hosts with authenticated transport,
  host-level health checks, controlled drain/promotion, rollback, and a consistent release inventory.
- Preserve a direct Source proxy mode for development only. Production must never build independently on
  each Instance because that can produce divergent releases behind round-robin routing.

## P2: PostgreSQL high availability

- Define and automate a multi-host PostgreSQL primary/standby topology using streaming replication. Make
  the asynchronous versus synchronous durability and latency choice explicit for each deployment class.
- Give every Phi Site Instance one stable database endpoint and provide controlled failover, fencing, and
  split-brain prevention. Do not present PostgreSQL replication as built-in multi-primary operation.
- Monitor primary and standby health, replication lag, WAL retention, disk capacity, and failover state.
- Keep replication separate from disaster recovery: maintain tested base backups, WAL archiving, and
  point-in-time recovery on storage that does not share the database hosts' failure domain.
- Document and rehearse failover, rejoin, restore, and full-host-loss procedures before treating the
  database tier as highly available.

## Post-v1: Decide the CMS payload migration policy

Not v1 work. v1 deliberately accepts ABI breaks and ships no fallback, shim, or compatibility reader,
so this section must not be used to justify one.

`readValidatedPageRevisionTree` applies `validateCmsPageWriteInput` — the write-input validator — to
already persisted revisions. Tightening a payload rule therefore invalidates existing stored data on
read, and the Builder answers `500` rather than rendering. In v1 the accepted resolution is to clean or
recreate the affected Draft; the `sourceUrl is forbidden when sourceKind is "asset"` rule was handled
that way on 2026-08-17, where exactly one persisted node was affected.

Revisit when a versioned payload beyond v1 is introduced, because the same break would then hit
installations whose Drafts cannot simply be recreated:

- Decide whether the read boundary normalizes retired fields for a declared payload version, or whether
  a validated `phis-cli` repair operation upgrades stored revisions explicitly.
- Whichever is chosen, keep exactly one path. Do not reintroduce per-field tolerance in the shared
  validator.
- Report affected scopes and nodes before changing anything, and make the operation idempotent.

Persisted legacy internal navigation `href` values are the same question again. The write path stopped
producing them, and `parseSiteNavigationOverlay` -- the write validator -- also guards every read, so a
persisted local path in an external target cannot render as a link: the read throws. There is therefore
nothing to detect at runtime that does not already announce itself, and no silent wrong behavior to
migrate away from. The development database was checked on 2026-08-25 and holds none; its only `href` is
a legitimate external URL. In v1 the repair is to author the item again, and for an installation that
upgrades it is the same decision as above.

The reference index raises the same question in its own form. The Area source landed on 2026-08-25 and,
like the Page source, indexes the draft that was just written, so an Area revision persisted before that
date carries no index row until it is saved again -- and until then the Asset delete guard cannot see a
reference that only sits in Area Region or widget config. In v1 the accepted repair is the same one:
save the Area again. It becomes a real question only for an installation that upgrades across that
version, at which point it is the same decision as above -- a validated `phis` repair operation that
reports what it changed, not a silent backfill and not a scheduler.
