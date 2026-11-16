# Module media

A design, not a contract. Nothing of it is built. It describes how a Site Module (an npm package with
presets) brings its own pictures -- an app icon, screenshots, later fonts -- so that they stand in the
Site's Media library and the Module's presets can name them. Section 9 holds what the operator decided.

## 1. Why

A preset names a picture by the Media library's Asset id (`sourceKind: "asset"`, `phis:asset/<id>`, a
gallery's `folderId`, an `asset:` icon). An id belongs to one Core's database, so a preset that names one
works on the Site it was written beside and nowhere else. `@phis/phisys` does exactly that, and says so
(`PHISYS_ASSETS`: "on any other installation the pictures would simply be missing"); `@phis/ui` forbids
it for its own presets (MODULES.md, "An icon a preset names is already resolved when it names it").

What a Module may ship today does not cover it: Module icons are single-colour drawings, a Theme ground
is one picture adopted on save, fonts are bundled by Next, and "a Module ships no static files"
(THIRD_PARTY_MODULES.md). Nothing writes Media from the server side: an Asset comes from a signed-in
upload, and the CLI has no import.

## 2. The idea

The Module declares its files. Core puts each into the Site's Media library once, as an ordinary Asset,
and remembers **which Asset stands for which declared name on this Site**. The Module is handed that
answer when it builds its presets and names the picture by the id it was given.

So the Media library and every Widget stay as they are: an Asset is an Asset, an id is an id. What is new
is the list of names in the package, one mapping table, one import step and one resolver.

The mapping is a binding, not an origin stamp: an operator may point a name at another Asset of the Site
(their own icon), and the Module follows.

## 3. What the Module declares

In the package's `package.json`, in the `phis` block the CLI already reads for `modules`:

```json
"phis": {
  "media": {
    "folders": [{ "key": "phi-dossier", "name": "PhiDossier" },
                { "key": "phi-dossier-screenshots", "name": "Screenshots", "parent": "phi-dossier" }],
    "files": [{ "key": "phi-dossier-icon", "file": "dist/media/phi-dossier-icon.png",
                "folder": "phi-dossier", "alt": "PhiDossier app icon" }]
  }
}
```

- `key` is the package's own name for the thing, unique within the package, and never changes once
  published: it is what the mapping is found by.
- `file` is a path inside the package, below its root; nothing outside it is read.
- `alt` (and an optional `title`) are written in the package's `sourceLocale`, like every other text of it.
- `package.json` rather than the Module definition, so the CLI reads a manifest and runs no package code.
- The package is the unit, not the Module in it: two Modules of one package share its files.

## 4. What Core stores

Two tables in `phis`, `CREATE` only, each row gone with its Site:

```
site_module_media          site_id (-> sites, CASCADE), package_name, key,
                           asset_id NULL, source_checksum, bound_by_user_id NULL, created_at, updated_at
                           PRIMARY KEY (site_id, package_name, key)
                           FOREIGN KEY (asset_id, site_id) -> media_assets (id, site_id) ON DELETE SET NULL (asset_id)
site_module_media_folders  site_id (-> sites, CASCADE), package_name, key,
                           folder_id NULL (-> media_folders, SET NULL), bound_by_user_id NULL,
                           created_at, updated_at
                           PRIMARY KEY (site_id, package_name, key)
```

Two tables rather than one with a kind column (weighed with the operator, 2026-11-16). The Site binding
is the same either way. What decides it: a picture, a font and any other file are all Assets, so the
only second kind there will be is the folder, and a kind column would hold two values of which one is the
exception -- its own reference column, no checksum, a `CHECK` to keep the two apart, and a `NULL` that
means "gone" in one row and "does not apply" in the next. With two tables every column of a row applies
to it and each reference is one plain foreign key, the Asset's the composite one that keeps it on the
same Site, as `media_assets.folder_id` does. What one table would have given, a single namespace of keys
per package, is kept by the import: it refuses a manifest in which a folder and a file share a key.

A column on `media_folders` naming package and key was weighed as well and is not taken, for a reason of
design and not of migration. What is stored here is a relation -- which folder, which Asset stands for a
name on this Site -- not a property of the folder or the Asset: the operator may point a name at a
folder or a picture of their own, which the package never made, and a row outlives what it pointed at
and says that it is gone. A stamp on the thing can do neither. And the Media library stays the lower
layer: it knows Spaces, folders and Assets, and nothing of packages; what a package calls them is kept
by the layer that knows packages.

`source_checksum` is the SHA-256 of the package file the Asset was last written from.
`bound_by_user_id` is set when an operator pointed the name at another Asset by hand; the import then
leaves the row alone. `media_assets` and `media_folders` gain no column. An imported Asset carries
`meta.source = "module"` with the package and key, as provenance for a reader -- nothing looks it up.

## 5. The import

A step `phis module media sync --site <site key>`, which `phis update <site key>` runs as well: only
there do the package's files and Core's database meet. For every declared folder, then every file:

1. Row present, Asset (folder) present: leave it. For a file whose checksum differs from
   `source_checksum`, see section 9, point 2.
2. Row absent, or its Asset (folder) is gone: create the folder by name in the Site Space, or write the
   file into the Site Space's Storage Profile -- Local or S3, through the Provider, as an upload's
   finalize does -- create the Asset in its folder with `alt`, record the id.
3. A row whose key the package no longer declares: left alone, and listed by `phis module media list`.

It is idempotent, writes nothing when nothing is missing, and never deletes an Asset. Removing the
package leaves the Assets and the rows; `phis module del` says so.

Because a missing Asset is simply written again, the step repairs itself after a restore that lost
files, and on a Site moved to another Core it creates the Module's pictures afresh with that Core's ids
-- they need not be part of any backup.

## 6. Handing the ids to the Module

- Core answers the mapping of a Site over a read route of the Site API (package, key -> Asset id or
  folder id). It is public knowledge of the Site, not a secret; it changes only on `sync` or a rebind.
- `@phis/ui` loads it with the Site's other runtime facts and hands the preset builders a resolver:
  `media.asset("@scope/pkg", "key")` and `media.folder(...)`, each a number or `null`.
- A preset writes the number where it wrote a constant before. A `null` leaves the picture out; the Page
  check reports it.
- The preset icon rule gets its allowed form: an `asset:` icon built from the resolver is fine, a literal
  id stays refused.

A Page saved in the Builder holds the id of that moment, as with every picture; a later rebind reaches
the Pages that still come from the preset.

## 7. The operator's side

CLI first, as for entitlements:

- `phis module media list --site <site key>`: every declared name, its Asset, and whether it is the
  package's file, a hand binding, or missing.
- `phis module media bind --site <site key> --package <name> --key <key> --asset <id>` and `--reset`.

An admin page for it is a later step.

## 8. Not in this step

- Fonts. The same declaration and mapping would carry them (design/FONTS.md in `@phis/ui` asks for "a way
  for the Module to say where its files are"); the first step is pictures.
- Add-on files: an Add-on has its own Media Space and `assets:v1`.
- A portable move of one Site between Cores (ids of uploaded Assets remapped in stored Pages): its own
  gap, named in DB.md, not closed here.
- A check that every Asset's object exists in its Storage Profile with the recorded checksum. `phis media
  check` looks at Local roots only; after a restore this is the check one wants, for S3 as well.

## 9. Decided (operator, 2026-11-16)

1. **The import runs on `phis update`** (and by hand), for every installed package of the Site, whether
   or not a Module of it is enabled in an Area.
2. **A changed file follows the package while the Asset is still what the import wrote** (its checksum
   equals `source_checksum`); an Asset somebody changed is left. Where Core cannot replace an Asset's
   content under its id, following means a new Asset and the row moved to it; a stored Page keeps the old
   picture.
3. **A deleted Asset or folder is written again on the next `sync`.**
4. **An existing Site binds by hand**: where the pictures already lie in the library as uploads
   (dev.phisys.com), the names are bound to those Assets once by `bind`, so nothing lies there twice.

## 10. Order of work

1. Core: the two tables, the import, the read route, the CLI, DB.md and docs/CLI.md.
2. `@phis/ui`: the resolver in the preset builders' context, the Page check, MODULES.md and
   THIRD_PARTY_MODULES.md (what a Module may ship; the icon rule).
3. `@phis/phisys`: icons and screenshots of the four products into the package, `PHISYS_ASSETS` and
   `PHISYS_FOLDERS` reduced to what is not the package's own.
