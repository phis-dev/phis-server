# API Reference

## Auth

`phis` is the Site authentication and session authority. The normative target behavior is defined in
[AUTHENTICATION.md](../AUTHENTICATION.md).

- The canonical server API uses `/api/v1/auth/*`.
- Site runtimes expose an approved same-origin `/api/auth/*` facade and keep the server token and provider
  secrets outside browser code.
- `/api/shop/*` remains the Medusa commerce facade and is not the Phi identity/session authority.
- Global users, Site memberships, credentials, linked provider identities, and Site sessions remain
  Core-owned even when a third-party Auth Module replaces the login UI.
- The current direct `/api/auth/*` handlers are migration input and must converge on the canonical
  server/facade split rather than remain a second wire contract.

## External v1 API (Token Guarded)

All `/api/v1/*` endpoints require `x-phi-token` and a non-bot user-agent header.
Public endpoints use the configured public API token.
Internal endpoints use the configured internal API token via `x-phi-token` or `Authorization: Bearer <token>`.
Frontend clients should prefer same-origin `/api/v1/*` proxy calls from their local Next route handlers instead of exposing token handling in browser code.

### GET /api/v1/presets?collection=slug
Returns `{ version, presets }`. Optional `collection` filter.

### GET /api/v1/preset-collections
Returns `{ collections }`.

### GET /api/v1/locales
Returns `{ defaultLocale, locales, labels, options }`.

### GET /api/v1/news
Returns `{ version, news }`.
News items with an `outdated` date in the past are not returned.

### GET /api/v1/adapter-versions
Returns `{ plugins }` (unique `plugin_type` list).

### POST /api/v1/adapter-versions
Body: `{ pluginType, version }`  
Returns `{ plugins, currentVersion, latest, updateAvailable }`.

### POST /api/v1/email/send
Internal/internal-service use only. Requires the configured internal API token via `x-phi-token` or `Authorization: Bearer <token>`.

Body:

- `template`: `"registration_verify"` or `"registration_welcome"`
- `to`: recipient email
- `locale?`: locale code (defaults to `en`)
- `name?`: recipient display name
- `siteKey?`: explicit site key
- `verificationUrl?`: required for `registration_verify`
- `body?`: optional generic mail payload for non-template sends
  - `subject`, `text` or `html` required
  - `to` optional (if omitted, root `to` is used)
  - `from` optional override

Examples:

```json
{ "to":"user@example.com", "template":"registration_verify", "verificationUrl":"https://..." }
```

```json
{
  "to":"user@example.com",
  "body":{
    "subject":"Support request",
    "text":"Your message..."
  }
}
```

Returns:

- `{ sent: true, template, siteKey, to, messageId }`.

## Site Media API

These endpoints describe the current pre-Space implementation only. The normative target API and
authorization model is defined in `GROUPS_AND_STORAGE.md`; `groupId`, multipart upload, and Site-wide
Asset ownership below are migration input and not a v1 compatibility promise.

These endpoints require the internal API token and a resolved site context. They are intended for developer-scoped site media and branding assets.

### GET /api/site/media
Returns `{ ok, groups, assets }` for the current site.

### POST /api/site/media
Accepts `multipart/form-data` with:

- `file` required
- `groupId` optional
- `title` optional
- `altText` optional
- `visibility` optional (`public` or `private`)

Returns `{ ok, asset }`.

### DELETE /api/site/media?id=<assetId>
Deletes the site media asset and its backing object.

## Translation API (Token Guarded)

### GET /api/v1/tr
Headers: `x-phi-token`  
Query: `locale`, `msg`, optional `ctx`, optional `hash`, optional `format=text|html`
Returns `{ translation }`. Only locales from `config/phis-config.json` are translated via
DeepL; all others return the original `msg`.

Token, database, DeepL, mail, CORS, and other runtime-sensitive settings are loaded from:

- `config/phis-config.json`
- `config/phis-runtime.json`

Notes:
- `GET` is the preferred frontend lookup path because it can be cached by Next.js render fetches.
- `format` defaults to `text`; use `html` only when the source string is intentional translatable HTML markup.
- `hash` is optional and must be a 64-char hex SHA-256.
- If `hash` is omitted, the server computes SHA-256 from the first 50 characters of `msg`.

## Admin / Account APIs

The following legacy endpoint families were intentionally removed from this repo:

- `/api/admin/*`
- `/api/account/*`
- `/api/catalog/supported-devices`

Please add replacements in dedicated services if those capabilities are needed again.
