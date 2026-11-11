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
would invalidate every canonical Site message and translation. It is stored as
`sites.overrides.<siteKey>.sourceLocale` in the runtime configuration; `translation.sourceLocale` is only
the installation fallback.

## Locale capability

Locale support has two levels:

- `PHI_LOCALE_CAPABILITIES` in `src/lib/locale.ts` is the platform-wide capability superset. Every entry
  states the locale key, `language`, optional `script` and `region`, text `direction`, `intlLocale`, the
  DeepL target (`deeplTargetLang`), and the label fallback chain (`labelFallbacks`, by default locale,
  language, `en`). Aliases such as `zh`/`zh-CN` for `zh-Hans` resolve to their entry.
- Each Site offers a subset through `sites.default_locale` and `sites.available_locales`. A locale unknown
  to the superset is dropped, and `default_locale` must be one of `available_locales`.

Rules:

- Locale identifiers use BCP-47-style values, for example `de-DE`, `de-CH`, `en-US`, `en-GB`, `es-419`,
  `zh-Hans`, `zh-Hant`, `pt-BR`, and `pt-PT`.
- A stored Site locale is not an external provider target. DeepL receives the resolved target
  (`de-CH -> DE`, `en -> EN-GB`, `en-US -> EN-US`, `pt-BR -> PT-BR`, `zh-Hans -> ZH-HANS`); Intl and
  `<html lang>` receive the effective locale; label sets use the fallback chain (`de-CH -> de -> en`).
- Locale validation, DeepL targets, direction, and fallback chains are derived only from the capability
  table in `@phis/server`. Widgets and Sites never carry their own table.
- The Ant Design locale key is resolved in phis-ui (`helpers/antd-locale.ts`, for example
  `de-CH -> de_DE`, `zh-Hans -> zh_CN`), which also loads the bundled Ant Design and Dayjs locale modules.
- A locale DeepL gains is added to the capability table first; only then may a Site offer it.
- The translation target locales of a Site are its available locales without its source locale. A Site
  whose only locale is its source has an empty translation workspace.
- Global Core, package, and preset translation requests are not Site-scoped. Phi-owned preset source text
  is `en` and never inherits a Site locale.

### Request locale resolution

`GET /api/v1/site/locale` (internal token) resolves the locale of one request. The candidates, in order,
are the explicit request locale (`locale` query parameter or `x-locale` header), the language the
signed-in person has chosen, the `phis_locale` cookie, and `Accept-Language`. The first candidate that
matches an available Site locale, exactly or by language, wins; otherwise the Site default applies. The
response carries the capability entry together with `requestedLocale` and `source`
(`requested`, `user`, `cookie`, `browser`, or `default`).

Because the explicit locale comes first, a request that names one exactly as the Site serves it has an
answer that depends on nothing else. `GET /api/v1/site` therefore carries `localeCapabilities`, the
capability entry of every served locale in matching order (`resolveSiteLocaleCapabilities`), and a Site
process answers such a request from it without asking this endpoint. It asks only when the visitor's
preference has to decide.

`user_accounts.preferred_locale` is empty until somebody answers the question, and its absence is what
puts the cookie in charge. `PATCH /api/v1/auth/profile/locale` is the only endpoint that writes the
column: registration leaves it empty although it knows the language the form was read in, the admin
screens leave it empty for an account they create, and an edit that is about a name never touches it. A
value there is therefore always somebody's own answer, which is why it may outrank the language their
browser is being read in.

A registration or an email change still needs a language for the mail it sends, and nobody is signed in
to ask: those take it from the hidden `locale` field the form carries (the language of the page it was
read on) and keep it on the registration intent. That is the mail's language, not the account's.

Site configuration is cacheable per Site. A resolved request locale is not, because it depends on the
session, cookies, and request headers.

### The locale a sign-in serves

Signing in answers the same question with the same candidates, minus the explicit one: the saved language,
else the `phis_locale` cookie the browser already carries, else `Accept-Language`, else the Site default
(`resolveSignedInLocale`). Password login, a provider callback, and a confirmed identity link all take
that answer and write it back into the cookie for the length of the session. The viewer snapshot carries
the same answer, so the Language panel under a German page offers German rather than the Site default.

This is what carries a language across the door. Somebody who reads the Public pages in German and then
signs in stays in German, because the cookie their language switch wrote is a candidate; and they keep it
until they save something else under their profile, because that save is the only write there is.
Sign-in used to read `preferred_locale` alone and overwrite the cookie with it, so an account that had
been given the Site default at creation handed every such visitor English -- the one place that did
exactly what the Site proxy refuses to do, which is to overwrite a choice nobody withdrew.

### Translation requests

- `GET /api/v1/tr` translates one `msg`. `POST /api/v1/tr` accepts one `msg` or a `msgs` array.
- Both accept `format=text|html`; `text` is the default and `html` marks intentional translatable HTML.
- A request with the internal token and `x-phis-site-key` uses the Site store (`tr_site_msg`,
  `tr_site_lang`). A request without `x-phis-site-key` uses the global store (`tr_msg`, `tr_lang`).
- A request with the public token must not send `x-phis-site-key` (`403`) and uses the global store only.
  Public requests are refused unless `translation.allowPublicReads` is `true`, and they store new
  translations only when `translation.allowPublicWrites` is `true` -- and then only for messages the
  catalogue already holds, unless the request names an application and the window for new messages is
  open. A public request that may not have a missing message translated answers with the source text and
  `"provisional": true`: it never asked a provider, so what it hands back states nothing about that
  message except that it is not here.
- Public requests to `/api/v1/tr` are rate limited per address with an allowance of their own, because a
  batch of up to 50 messages is not a page fetching its own data and a cold caller asks once per Label
  Set. The internal token is not counted. A refused request answers `429` with `Retry-After`, which a
  CDN step reads as "not held there": it falls through to its own provider rather than failing.
- A target locale outside `translation.supportedLocales` answers with the source text.

### Dynamic values

- Translation sources contain only translatable text and stable placeholders. Names, email addresses,
  company names, customer numbers, Site names, URLs, and other dynamic values are never embedded in a
  string sent to `tr`, `trGlobal`, a label set, or `translateWithCache`.
- Dynamic values use positional placeholders `%1`, `%2`, ... that are filled after translation, for example
  `Hello %1,` with `%1 = recipientName`.
- Label sets are static UI copy. They may contain placeholder templates such as `Login history for %1`,
  never resolved user, profile, company, or email values.
- Email templates translate the template line first and then insert recipient names, Site names, support
  emails, and links into the `%n` placeholders.

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

### Somebody else's strings in the global store

An application that is not this platform can be given write access to the global store. Its strings have
nothing to do with the Label Sets, and they must not share a key space with them.

**The application names itself in a header, and the server builds the context.** A write from outside
carries its application name in `x-phis-app`, and what is stored is that name in front of the context the
caller sent: `acme: ui label set`. The stored context is the server's construction, never the caller's
string, which is what makes this a rule rather than an agreement -- whatever a caller sends, its entries
begin with its own name and cannot land in a register of the platform's own.

**The same header applies to reads.** Identity is `(msg_hash, ctx)`, so a message stored under
`acme: ui label set` is found only by a request whose context resolves to exactly that. An application
therefore sends the header on both, and sends `ui label set` either way. Prefixing writes alone would
have it store under one key and read under another: nothing found, nothing wrong, and the data correct in
the table all along.

**The header names which door, and that decides what a write may do.** Without it a request is in the
platform's own space, and a public caller there may fill in a translation for a message the catalogue
already holds -- it may not create one. With it a request is in the application's own space, where
creating is the point. So the two rights are not the same grant: filling the platform's catalogue can
stand open, while creating entries needs a window that is opened deliberately and is short -- ten minutes
at most, closing by itself rather than waiting to be switched off.

**What the header is not is an identity.** Anybody holding the public token can claim any name, so it
does not protect one application from another. It protects the platform's space from all of them. What
bounds the rest is how narrowly and how briefly write access is granted, and the rate limit on the route.

**The name is part of a key, so it is checked like one.** A leading `[` is refused: the flag envelope
above is reserved, and an application calling itself `[html]` would forge a storage flag. The name plus
the caller's context must fit `ctx`'s 128 characters, and an overlong one is refused rather than
truncated -- a cut context silently merges two key spaces into one, which is the collision this whole
rule exists to prevent. And the name is normalised, so `Acme`, `acme ` and `acme` are one space rather
than three an application would search in vain.

None of it can be undone later: the global store has no deletion path, and a protected external variant
is kept by contract, so an entry written this way stays.

The prefix also stays within the rule this section opens with rather than bending it. `ctx` reaches the
provider as translation context once the flag envelope is stripped, and "acme: ui label set" is natural
language that reads correctly to a translator -- it says the text is a caption and not a sentence. A URL,
a message key or a resource id would not be, and they stay out of it for the reason they always did.

**Where the two rights are settled.** `translation.allowPublicWrites` grants the first one and stands
until it is taken away. The second is `translation.allowPublicWritesUntil`, an ISO timestamp naming when
the window closes: absent is closed, a moment in the past is closed, and what the operator opens is
capped at ten minutes where it is written rather than where it is read -- clamping a stored end against
"now" on every read would keep any window permanently ten minutes from closing. Taking
`allowPublicWrites` away clears the timestamp with it, so switching writes back on later does not reopen
a door somebody opened this morning.

## Translation modes

The operator sets one mode. It names where a translation comes from, and there are four:

| mode | who translates |
| --- | --- |
| `deepl` | DeepL |
| `cdn+deepl` | the CDN first, DeepL for whatever it does not answer |
| `add-on` | the translation service provider the operator selected |
| `none` | nobody |

**The chain lives inside a mode, not in the operator's hands.** `cdn+deepl` asks the CDN and falls
through to DeepL; the operator states an arrangement, not a rule set. `deepl` is the same arrangement
without the CDN in front, and it is a real choice rather than a leftover: the CDN answers first, so an
installation that has worded its own global messages picks `deepl` to keep them.

**The CDN is asked with a token, because it is our own route on somebody else's installation.** The
request is the public form of `/api/v1/tr`: `api.phisCdnPublicToken` in `x-phis-token`, no Site header,
global messages only. A mirror refuses a request that carries no token at all, so an installation with a
`translation.cdnBaseUrl` and no token is answered `403` for every batch -- which the step reads as "not
held there" and falls through, quietly turning `cdn+deepl` into `deepl`. The operator's CDN check sends
the same token and reports the refusal.

**A DeepL key is optional under `cdn+deepl`.** The CDN holds the platform's own messages, so an
installation with a CDN and no key still has a translated interface; what it does not have is Site
content and conversation messages. The CDN is therefore asked before the key is considered at all --
deciding on the key first would make a half-configured installation translate nothing, which is not
what the operator configured.

**What the provider is asked, and how often.** The store is read first and the provider is asked only
for what it does not hold. Every answer the provider gave is kept, also one that reads like the source
("Dashboard" is German for "Dashboard"): a message left out of the store is asked again on every render.
A stand-in is never kept, so a message that fell back to its source text is translated once the provider
answers again. A refused request pauses DeepL: thirty seconds after `429`, `500` or `503`, and an hour
after `456`, which says the account's character quota is used up and does not change within seconds.
While it is paused every miss falls back to the source text without a request.

**The CDN only ever serves global messages.** A CDN can hold translations of text that is the same
everywhere -- `phis.tr_msg` and the label sets above it. It cannot hold a translation of a Site's own
string, and it cannot hold one of a message somebody wrote a minute ago. `tr_site_msg` is never served
from it, and neither is anything outside this contract.

**And only messages written in the canonical source language.** A shared answer needs a shared
identity, and identity here is the exact canonical text: `msg_hash`, SHA-256 over the whole `msg`, plus
`ctx`. An external source variant has none. Its `tr_msg` row is owned by a *generated*
canonical result (steps 2 and 3 of "External and non-canonical sources" below), so the same German
sentence becomes one English text on this installation and a slightly different one on the next -- two
hashes for one string. A mirror can hold neither of them, and whichever it does answer, it answers for
another text.

So a Module not written in the canonical source locale is translated by every installation that runs it,
on that installation's own key, and the CDN never carries those strings. This is not a gap left open for
later: it is what sharing costs when the thing to be shared is produced locally. Everything first-party
is English, so this concerns Modules from elsewhere.

The way in is to declare the canonical text instead of generating it. A package that ships its English
beside its own language has an identity every installation agrees on, and its strings are ordinary
catalogue entries with nothing special about them. No part of this contract asks a package for that
today, and a local pre-translation is not a substitute: it produces an identity that looks shareable and
is not, which is the worst of the three states because nothing about it fails.

What this costs today is one wasted round trip. The CDN step is asked whenever the mode is `cdn+deepl`
and the audience is `platform`, which an external unit's requests are; the mirror does not hold the text
and the step falls through to DeepL. The answer is right, the request was pointless.

**`none` is the last link of every chain, not a fourth thing.** When no step answers, the source text
is returned unchanged and the result is marked as not succeeded. That is what the other modes already
do when their provider fails, which is why a stand-in is recorded and must not be stored.

**`add-on` hands the whole question over.** A provider is asked for a translation and answers with one;
whether it consulted a CDN, a local model, or a vendor of its own is its business and is not configured
here.

Translation is a **Core-owned service kind**, `@phis/server/service/translation`, implemented by an
Add-on on the same terms as a Media Storage Provider ([SERVER_ADDONS.md](./SERVER_ADDONS.md), "Internal
service providers"). That is the extension path for an infrastructure implementation, and it is the
only one: a loopback HTTP route, a dynamic import, or a Module-owned adapter is not an alternative.

**Several implementations may be installed, and the operator selects one.** Uniqueness is on
`(service kind, provider key)`, not on the kind, so an installation may hold a vendor provider and a
local one and switch between them without uninstalling either. The selection is
`translation.providerKey`, and `add-on` cannot be saved without one: with nothing installed there is
nothing to select and the mode is refused, and a provider that is installed but disabled or built
against another interface is offered in the list and cannot be chosen. An installation saved with an
unusable selection would look configured and translate nothing, which is the state the refusal exists
to prevent.

**The call itself.** `add-on` resolves the selected provider through the service-provider registry --
installed, enabled, interface-current, registry-matched -- and instantiates its factory once, keyed by
the selection *and* the manifest digest, so an upgraded Add-on and a changed selection are both a
different adapter rather than a stale one. Nothing else is consulted: no CDN step in front and no DeepL
behind it, because an operator who chose a provider chose it, and a chain that quietly reached a second
translator would make an installation's answer depend on which one happened to be reachable.

Not resolvable is `unconfigured` and a provider that threw is `failed`, which is the same distinction
every other mode reports and the reason it matters here too: only the second will be right again later
without anybody changing anything. The reason a provider is unusable is logged and never returned -- a
Site is told that translation is unavailable, not which Add-on an operator misconfigured.

**A provider's secret is `translation.secretReference`,** a reference that names a stored secret and
never holds one. It sits in the installation's translation configuration rather than in the Add-on's
per-Site settings for the reason the service context carries no Site at all: which translator an
installation uses is an installation's decision. Core resolves it as Core, because the configuration
that names it is Core-owned state and an Add-on resolving its own reference would be an Add-on trusted
to ask only for its own. Empty is a provider that needs none, which is a real case.

A provider gets `null` where a Storage Profile passes its configuration row. There is no profile row to
configure a translator in, so its secret is the only thing an operator can hand it today; a provider
that needs an endpoint or a model name has nowhere to read one from, and that is a gap in the
configuration rather than something to paper over.

`translation.customEndpoint` is gone. It configured an HTTP endpoint that translated and could say
nothing else about itself, so an installation could not learn which languages it accepted without
sending it text to find out. A service provider is installed, version-checked, digest-checked and
activated before Core resolves its factory, and it declares what it supports on the way in.

### How a mirror is served

**A mirror is a deployment, not a feature.** Nothing in this codebase makes an installation a CDN. A
mirror is an ordinary phis-server that a reverse proxy publishes under a host name of its own, with two
paths reachable and nothing else, which is why `translation.cdnBaseUrl` names a *server* address. The
installation behind it is ordinary in every other respect, and its own mode is not `cdn+deepl`: a mirror
pointed at itself would ask over HTTP for what it had just failed to find in its own tables.

**Two doors, matched exactly.** `POST /api/v1/tr` is what a reader asks in batches, `GET /api/v1/tr`
answers a single message, and `GET /api/v1/locales` is what the operator's CDN check and the locale
options read. A prefix match would make `/api/v1/tr/anything` a door as well; an exact match keeps the
surface countable. A query string is not part of a path and needs no allowance of its own.

**What the host name must not publish** is everything else the process serves: `/operator`, `/setup`
while `bootstrap.enabled` is true, and the internal `/api/v1` routes. Those refuse a caller without the
internal token, so an unfiltered mirror is surface rather than a leak -- but a second public name for the
control plane is a second place to get it wrong, and the setup pages have no login at all, which is the
one case where the difference is not academic.

**The filter belongs to the proxy, not to a route.** A route cannot decline to be routed to, and which
paths a host name answers is what a reverse proxy is for. The mirror's *correctness* does not depend on
it either: the guard, `translation.allowPublicReads`, the write mode and the rate limit all hold on an
unfiltered installation too. The filter bounds what else that host name is, which is a deployment
question and stays with the deployment -- the shipped nginx template publishes `location /`, so a
mirror's vhost is a deliberate departure from it ([docs/INSTALL.md](./docs/INSTALL.md), "Web server and
service units").

**A mirror answers nobody until `api.publicToken` is set.** Without it `getApiV1TokenMode` cannot return
`public` for any request and the mirror refuses every batch with `403`. A reader takes that for "not held
there" and falls through to its own provider, so the failure is invisible: the mirror looks reachable,
every installation pointed at it pays its own provider, and nothing anywhere logs a complaint. It is the
first thing to check when a mirror seems to help nobody.

**Never through a Site.** A Site's proxy routes -- `/api/auth`, `/api/site`, `/api/addons`,
`/api/hooks` -- are the ordinary way something outside reaches this server, and they are the wrong way
here. They strip every `x-phis-*` and `authorization` header the caller sent and set the installation's
*internal* token, which is right for a Site's own traffic and ruinous for this one: a batch arriving that
way is `internal`, and `internal` means the write mode `extend` with no window, no application namespace
and no rate limit. The public/internal distinction is what this endpoint is built on, and a Site proxy
exists to erase it. The Skeleton takes no new routes either, so there would be nothing to add there.

**A mirror is not a cache in front of a translator; it is a store that already holds the answer.** Every
request is resolved from `phis.tr_msg` and `phis.tr_lang`, so there is nothing to warm and nothing to
invalidate. An edge cache in front of a mirror is possible, and it is the only thing that would earn the
name CDN, but it has two conditions. A batch read is a `POST` with its messages in the body, which an
ordinary proxy cache does not key on; and an answer carrying `provisional` must never be stored, because
a stand-in is source text and a cache that keeps one serves an untranslated string for as long as its
lifetime lasts. A cache that cannot read the body cannot see that flag either.

### Which targets a mode can reach

For `deepl` and `cdn+deepl` the answer is already in `PHI_LOCALE_CAPABILITIES`: a locale carries its
`deeplTargetLang`, and a locale DeepL gains is added to the capability table before a Site may offer
it. There is no second list to fetch and no live query to depend on.

For `add-on` the table cannot answer, because the provider is not DeepL. The selected provider declares
its own reachable targets, and an installation offers the intersection with the Site's available
locales.

### Whose text it is

Every request to the translation unit states an **audience**, and it is required rather than defaulted:

| audience | what it is | what follows |
| --- | --- | --- |
| `platform` | a keyed message out of `tr_msg` or `tr_site_msg` | the CDN step may answer it |
| `private` | text belonging to one installation -- a conversation body above all | the CDN step is skipped |

The CDN step is a POST of the text to somebody else's service. That is the right thing for the
platform's own catalogue, which is the same English sentence on every installation and the only reason a
shared step is possible at all. It is the wrong thing for a message somebody wrote to a support agent an
hour ago.

It is required and has no default because the safe value is the one a caller would forget. A body sent
to the CDN cannot be unsent, and nothing in a request's shape would have revealed that it had been.

**A conversation body never reaches this store at all.** It is not keyed, hashed or versioned, so it has
no place in `tr_msg`, `tr_site_msg` or the change-marker path; it goes to the translation unit directly
as `private` and its answer is returned and dropped. What the two share is the provider mode and
nothing above it.

**`sourceLocale` is nullable, and null is an answer.** It means "whoever translates decides", which is
the ordinary case for a conversation body: nobody writing on a Site is asked which language they are
writing in, because every provider detects it for itself. Core must never put a Site's default there --
that would tell a translator German about Portuguese text.

**The detected source language comes back.** A DeepL translation reports what it read each text as, per
text and not per request, so a caller that wanted only the language has already paid for it by asking
for one translation -- which is why nothing asks twice. It arrives as `detectedSourceLocales` beside the
translations, empty where whoever answered reports nothing: the CDN step says nothing about what it
read, and the Provider contract has no field for it.

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

This matters because catalogue identity can still fail for a single message: an external source can
conflict with a stored protected variant, and a `hash` sent to `/api/v1/tr` must be SHA-256 over the
whole message or it is refused. `msg_hash` covered only the first 50 characters until 2026-11-10, and
every HTML message opening with the same link or code element was then one key to `(site_id, msg_hash,
ctx)` -- the second such paragraph was skipped on every request. Before
batch isolation such an error left the whole request: a page lost every translation on it because one
paragraph began like another.

A skipped message is logged as `translation.message_skipped` with its stage, locale, context and the
opening of the text. Failures that are not about one message -- a database that is unreachable, a
provider that refuses the whole batch -- are not caught here and still surface.

A request in which any answer is such a stand-in -- a skipped message, a provider that failed and left
source text behind, or a read that was not allowed to fill what it found missing -- carries
`"provisional": true` next to `translation` or `translations`. A caller that keeps answers must not keep
these: they end with the outage, not with an edit. Source text that is the answer by configuration (no
provider, a locale that is not offered) is not provisional.

The third case is the public read, and it is there for the caller behind it rather than for this store.
An installation asking a mirror has DeepL after that step, and it may only take that turn if a miss
arrives marked; unmarked, the English source text would be stored as the translation and the string
would never be translated again. That is also why the flag stays coarse: it covers the batch, the
mirrored route states no per-entry answer, and a caller inventing one would be inventing a contract with
somebody else's service.

## What DeepL actually does

Measured against the Free API on 2026-09-24, because several decisions elsewhere rest on it and a guess
in a document outlives the person who guessed.

**Billing is by source text.** A request is charged the length of what is sent, never of what comes
back, and a `context` parameter is **not charged at all**. Sending the surrounding sentence as context
therefore costs nothing, while sending the same words as another text to translate costs their full
length. This is why a translation that wants coherence should reach for `context` rather than for a
bigger batch.

**There is no detection without translation.** `/v2/translate` rejects a request without `target_lang`
(`400`, and nothing is billed), and no separate detection endpoint exists. Leaving `source_lang` out
detects the language as a by-product of a real, billed translation, which is the only way to get the
answer. `detectTranslationSourceLocale` therefore pays for a translation it throws away.

That is why its sample is `DEEPL_DETECTION_SAMPLE_CHARS`, 600 characters. It was 16 KiB, written while
this cost was thought to be zero, which in the Free tier is about thirty detections before the month is
spent. Identification needs a fraction of that, and nothing is cached past requests in flight, so every
detection is paid for again.

**Detection is per text within a batch.** Three texts in English, Portuguese and French in one request
each came back with their own correct `detected_source_language`. DeepL's own wording is that texts in
one request share no context with each other, which is the other side of the same fact: a batch is a
transport detail to DeepL as much as it is to us, and batching buys throughput, never quality.

**Source equal to target returns the text unchanged.** A German sentence asked for German came back
byte-identical, with and without an explicit `source_lang` -- and was billed in full. So such a request
wastes money but does not corrupt text. Note what this does *not* cover: a Provider behind `add-on` mode
gives no such assurance, and one built on a model may well rewrite.

**`context` demonstrably changes the answer.** `bank` alone translates to `Bank`; with a context sentence
about a river it becomes `Ufer`, with one about depositing money it stays `Bank`. The context never
appears in the output.

**Free tier limits**: 500,000 characters per month (readable from `/v2/usage` as `character_limit`), 128
KiB per request. No maximum number of `text` parameters per request is documented -- our
`DEEPL_MAX_TEXTS_PER_REQUEST` of 50 is a limit we chose, not one DeepL states. Rate limiting answers
`429` with no documented request-per-second figure; concurrency was not measured.

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
