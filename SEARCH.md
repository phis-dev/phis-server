# Site Search

How a visitor searches a Site's own Pages, and which half of it is phis's.

## The split

A Page's words are not in one place phis could read. They stand in Widget configs of Pages a package
brings as Presets, in content phis stores without knowing which Page shows it (`site_content` is bound to
a Widget instance, and the instance stands in a Page's `tree_json`), and in documents a Widget fetches
while the Page is drawn -- a README read from a repository. Only the Site, resolving a Page the way a
visitor's request resolves it, sees the whole text.

So the Site writes the documents and phis keeps and searches them:

- The Site enumerates its published Pages the way its sitemap does, resolves each one per language,
  asks every Widget on it for the text it shows (a Widget's own declaration in `@phis/ui`), and sends the
  result as one set per Area and language.
- phis stores the set (`site_search_sets`, `site_search_documents`, DB.md), derives the text-search
  vector in the database, and answers a query with the matching Pages.

The shapes both sides read are in `@phis/contracts/search`.

## Endpoints

All three take the internal token and `x-phis-site-key`; a browser never reaches them.

| | |
|---|---|
| `GET /api/v1/site/search?q=&areas=public,app&limit=` | The matching Pages, best first, in the request's locale (`x-locale`). `areas` names the Areas the Site decided this visitor may search; `public` alone by default. An Area outside Public and App is `400`. A `q` the contract calls too short answers an empty result. |
| `GET /api/v1/site/search/index` | The sets phis holds of the Site: Area, locale, fingerprint, count, time. |
| `PUT /api/v1/site/search/index` | One set, replacing what phis held of that Area and language: `{ area, locale, fingerprint, documents[] }`. Answers `accepted: false` when the fingerprint is the one already held and nothing was written. A document without an address is dropped and counted in `dropped`; the rest is written. |

## What phis promises

- A set is replaced in one transaction: a visitor searching meanwhile sees the old set or the new one.
- The set row is locked while it is replaced, so two Site processes offering the same fingerprint
  produce one write and one `accepted: false`.
- Only the Public (`1`) and App (`2`) Areas are indexed; a set for another Area is refused.
- The query is the words of `readPhiSearchQuery`, each matched as a prefix (`install` finds
  `installieren` and `installation`), all of them required. Nothing a visitor types reaches the text
  query's own grammar: the words are letters and digits only.
- The vector uses the `simple` configuration, no stemmer. A Site is written in any language and
  translated into others; a stemmer for the wrong one does worse than none, and the prefix match is the
  part of stemming a reader expects.
- Rank: title (`A`) over description (`B`) over body (`C`), then how close the words stand
  (`ts_rank_cd`). Ties by title, then path.
- The snippet is `ts_headline` over the body, in pieces, each piece saying whether it is a matched word;
  empty where the match was in the title or description alone.
- Deleting a Site drops its sets. Nothing else here is maintenance (AGENTS.md "Maintenance contract"):
  a set is replaced by the next publish the Site notices, and a set nobody replaces describes a Site
  nobody publishes to.

## What the Site promises

- It writes only what a visitor of that Area could read: Public anonymously, App as a signed-in member
  without further roles. A Page with a narrower access policy is not in the set.
- `fingerprint` changes whenever the set would: the live revisions, the route table, the Module
  addresses, the locales. phis compares fingerprints and nothing else.
- It writes a set when it notices the Site's read marker moved and the fingerprint it would build
  differs from the one `GET /api/v1/site/search/index` reports; and at start, for the same reason.
