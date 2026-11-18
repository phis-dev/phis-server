# Media sources

A design, and since 2026-11-18 the statement of what is being built from it. The contract types are
`@phis/contracts/media-source`; the service-kind rules are [SERVER_ADDONS.md](../SERVER_ADDONS.md),
"Internal service providers". The picker and a Module's own source are `@phis/ui`
(THIRD_PARTY_MODULES.md, "Offering a media source").

## 1. What it is

The Media picker lists the Site's own library. A media source is somewhere else a file can be taken
from -- a stock archive, a DAM, a brand portal -- shown in the same picker behind a switch. The library
stays the default, and a picker without any source looks as it did.

**What is chosen from a source is imported.** It becomes an ordinary Asset of the Site's Media library,
and what a field, a Widget or a Theme stores is that Asset's id. Nothing stores a reference into a
source. A Site keeps its pictures when a subscription ends, and variants, focal rectangle, delivery and
quota go on working on Assets and on nothing else.

What stays as it is: storage Add-ons (`@phis/server/service/media-storage`, chosen by Storage Profile)
store and serve objects and know nothing of sources; an imported file goes through the Site Space's
profile like an upload. Add-on Spaces and slot uploads (`assets:v1`) are an Add-on's own files and are
not a source either.

## 2. Two suppliers, one list contract

A source answers `PhisMediaSourceListInput` (search text, kinds, cursor, limit, locale) with a
`PhisMediaSourcePage` (items, next cursor), whoever supplies it:

| Supplier | Where it runs | Who asks | Who imports |
| --- | --- | --- | --- |
| An Add-on, service kind `@phis/server/service/media-source` | in Core's process | Core, for the picker | Core: the Add-on hands over bytes |
| A Module of the Site's build (`mediaSources`) | in the browser | the picker | the picker: it uploads the file like any other |

It is not the library's own listing. An Asset there has an id, a Space, a lifecycle and a delivery
address; an item of a source has none of them before it is imported. An item says what a source can
say: its own id, kind, title, a thumbnail address, the original's size, a credit line.

## 3. The service kind

`PhisMediaSourceAdapterV1`: `probe`, `list`, `take`. It follows Support Forwarding, not Media Storage:

- Nothing is configured in Core. Every implementation that resolves for the Site and whose probe says
  `usable` is offered, with each source it names. Which account a Site searches with is the Add-on's own
  Site settings and secrets.
- A source is addressed as `<providerKey>#<key>`, the way a forward target is.
- The factory is called with `(null, PhisMediaSourceServiceContext)`.
- Every call carries Core's deadline as an `AbortSignal`: probe 5 s, list 15 s, take 60 s.
- A throw or an answer that does not hold the contract is logged and answered as "the source did not
  answer". It never takes the library's own listing with it.

**Core fetches nothing from an address.** `take` hands over bytes; the Add-on fetches from its archive
with its own credentials. An address handed to Core would be a request made from inside the
installation's network, and `assets:v1` `put` draws the same line for the same reason. The thumbnail
address of an item is the one address that travels, and it is loaded by the browser of whoever has the
picker open: `https:` only, no credentials in it.

What Core checks of an answer, before anything reaches a browser or the library: the page's length
against the limit, each item's id, kind (one that was asked for), title, credit, sizes and thumbnail
address, the cursor; of a taken file, that there are bytes, how many, a file name and a title.

## 4. The routes

All under `/api/site/media/sources`, for somebody who may manage the Site's Media.

- `GET /api/site/media/sources` -> `{ rows: [{ source, label }] }`. Every source of every usable
  implementation. Empty where none is installed, which is the common case and costs one manifest read.
- `GET /api/site/media/sources/items?source=&q=&kind=&cursor=&limit=&locale=` ->
  `{ items, nextCursor }`, the page as the implementation answered it, checked.
- `POST /api/site/media/sources/import` with `{ source, itemId, folderId? }` -> `{ asset }`, the Asset
  as the library's listing shows one. It needs the right to write to the Site Space.

## 5. The import

The same steps an upload takes, with the bytes in hand instead of a session: the size against
`PHIS_MEDIA_SOURCE_TAKE_MAX_BYTES` and the Site's ceiling for one object, the Space's storage profile,
the Folder (it exists, it is not locked), the content read from the bytes and judged against what the
Site Space takes, the quota, the object written, the Asset created as ready, the bytes committed. A
failure after the object was written removes it again.

- The Asset is created by the person who chose it, in the Site Space, in the Folder the picker shows.
- Its title and alt text are what the implementation hands over with the bytes. Core imports by the
  item's id alone and takes no title from the browser.
- `meta` keeps where it came from: `{ source: "media-source", providerKey, sourceKey, itemId, credit }`.
  That is a record, not a link: nothing reads it to find the file again.
- The same bytes already in the Site Space answer with the Asset that is there. Choosing a picture twice
  is one Asset, and an upload's "duplicate" refusal is not what somebody choosing from an archive should
  be told.
- A refusal says what an upload's would, with the same codes, so the picker says it in the words it
  already has.

## 6. Not built, deliberately

- No browsing of a source's folders or collections: a source is searched.
- No refresh of an imported Asset from its source, and no clean-up when a source goes away.
- No credit shown beside a placed picture. The credit is kept on the Asset; showing it is the Site's.
