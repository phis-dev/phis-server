# Translation Contract

This document defines the normative v1 translation-storage and provider contract for `phis`.

## Canonical source languages

- Global messages in `phis.tr_msg` always use English as their canonical source language.
- Site messages in `phis.tr_site_msg` always use the immutable `sourceLocale` configured for that Site.
- A Site's `defaultLocale` controls locale fallback. It is not the source language.
- `availableLocales` controls selectable target and UI locales. It does not restrict the source language
  of attached external content.
- Global presets and third-party label sets may declare their own source locale. An omitted global source
  locale means English.
- A request with no explicit source locale uses its store's canonical source locale. A request whose
  source locale equals the canonical locale follows the ordinary canonical path.

The Site source locale is selected when the Site is created and must not be changed later. Changing it
would invalidate every canonical Site message and translation.

## External and non-canonical sources

An explicit source locale that differs from the selected store's canonical source locale is an external
source variant:

1. The exact external source text is hashed and looked up by `locale + source_hash` and the encoded
   context. A full-text comparison is mandatory after the hash lookup.
2. The external text is translated to the store's canonical source locale.
3. That canonical result owns the `tr_msg` or `tr_site_msg` row.
4. The exact external original is stored unchanged in `tr_lang` or `tr_site_lang` with its non-null
   `source_hash` and links to the canonical message through `msg_id`.
5. Other target locales are resolved from that same canonical message unit.

`source_hash IS NULL` identifies an ordinary generated or manually editable translation.
`source_hash IS NOT NULL` identifies a protected external source variant. Normal translation writes,
row deletion, and locale-wide deletion must not modify or remove protected variants.

The same external source text, source locale, and context intentionally resolve to the same translation
unit even when several documents use it. Hash matches never replace the mandatory full-text collision
check.

## Context flags

`ctx` is natural-language translation context for the provider. Resource identity, URLs, message keys,
and source languages do not belong in provider context.

Internal storage flags use one strict leading envelope:

- `[html]` means provider input uses HTML tag handling.
- `[extern]` means the canonical unit originated from a non-canonical source.
- Combined flags are stored in canonical order, for example `[html:extern]`.

Only registered flags are accepted. The complete leading flag envelope is removed before a provider
request. Any remaining text is sent as provider context; if none remains, provider context is omitted.
Brackets appearing later in natural-language context are preserved.

## Provider requests

- `sourceLocale` is sent as the provider's source-language parameter and never encoded into context.
- DeepL requests must remain below its 128 KiB request-body limit. Batch input is chunked according to
  the actual UTF-8 serialized request size while preserving input order.
- Markdown and HTML translation use the batch endpoint even for a single document.
- Unsupported external source languages are rendered unchanged and are not repeatedly redetected.

## Markdown and HTML

- Structured documents are parsed before translation.
- Semantic units are headings, paragraphs, paragraph content inside list items and block quotes, and
  table cells.
- Code blocks, inline code, and link destinations are not translated. Visible link text and image alt
  text are translatable.
- Inline emphasis and links are preserved by translation-safe HTML markup and translated with HTML tag
  handling.
- Cache hits are resolved first; only misses are sent to the provider in the fewest valid batches.
- Image alt text is translated inside the image's placeholder token; an authored image title is prose
  too, but travels as a unit of its own. Asked for both in one string, a provider returned them merged
  and re-split at a different point.

When an external Markdown or HTML source is attached, its source language is detected once and stored as
plain `sourceLocale` in Widget config. Builder may overwrite that value. Ordinary fetches and renders do
not redetect it. Attaching a different source may explicitly start a new detection. Detection uses a
sufficiently long representative document sample and the provider's normal automatic source detection.

## Batch isolation

A batch is a transport detail, not a unit of failure. One message that cannot be resolved in the
catalogue falls back to its source text on its own; every other message in the same request is
translated and stored as usual, and the request answers `200`.

This matters because catalogue identity can genuinely fail for a single message. `msg_hash` covers the
first 50 characters of `msg`, which the public `hash` parameter of `/api/v1/tr` is documented against, so
two messages sharing an opening are one message to the unique key `(site_id, msg_hash, ctx)` and the
second is rejected. An external source can likewise conflict with a stored protected variant. Before
batch isolation such an error left the whole request: a page lost every translation on it because one
paragraph began like another.

A skipped message is logged as `translation.message_skipped` with its stage, locale, context and the
opening of the text. Failures that are not about one message -- a database that is unreachable, a
provider that refuses the whole batch -- are not caught here and still surface.

A request in which any answer is such a stand-in -- a skipped message, or a provider that failed and
left source text behind -- carries `"provisional": true` next to `translation` or `translations`. A
caller that keeps answers must not keep these: they end with the outage, not with an edit. Source text
that is the answer by configuration (no provider, a locale that is not offered) is not provisional.

## Change markers

Sites keep translations without expiry. Core tells them when to let go: `/api/v1/site` carries
`translationMarkers: { global, site }`, one opaque value for the global store (`tr_msg`, `tr_lang`) and
one for the Site's (`tr_site_msg`, `tr_site_lang`). A Site compares them on every Site config read and
empties a store whose marker differs from the one it saw last. Only equality means anything.

- Triggers in `001_create_phis.pgsql` give a store a fresh marker in the same transaction as any write to
  it, whichever path the write takes -- the editor, the phis CLI, a script, plain SQL -- including a
  delete that arrives by cascade and a `TRUNCATE`.
- The request path that fills a missing translation marks its transaction (`phis.translation_fill`) and
  is skipped. What it adds was a miss for every Site, so nobody holds anything to empty, and taking the
  marker row lock there would serialize every concurrent fill of a Site.
- Each marker also carries a fingerprint of the translation configuration (mode, whether a DeepL key is
  set, the offered locales), because that decides every answer that is source text by configuration.
- The markers are rows, not statistics counters: a read replica sees them, with its replication lag.

## Content revisions and deletion

Site content keeps stable content identity but immutable version text links:

`site_content -> site_content_versions -> site_content_version_text -> tr_site_msg -> tr_site_lang`

Editing content creates a new content version and normally a new canonical message. It must not overwrite
the message of an older revision. Old messages remain available for rollback until revision-aware orphan
garbage collection removes them.

Removing a Widget or external URL only detaches the reference. It does not purge shared translation
units. Editor or Builder may explicitly purge a complete external unit after confirmation, but Site units
referenced by any content version must be rejected. Purging the canonical message cascades to all of its
variants.
