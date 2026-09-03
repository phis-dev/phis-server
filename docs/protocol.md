# phis API Protocol

## Authentication
All external API clients must send the header `x-phis-token` with the shared public token.
Requests without the header or with an invalid token return `403`.
Public requests use the configured public API token in all non-internal flows.
Internal/operational endpoints use the configured internal API token and are marked accordingly.

Frontends are expected to reach `/api/v1` through local site `/api/v1/*` route handlers where possible:
- Browser traffic remains same-origin and does not expose token handling to client JS.
- Route handlers inject `x-phis-token` from server runtime configuration before forwarding to this backend.
- Browser callers should never include any token in JavaScript-accessible environment variables; only server route handlers may attach token headers.
- Public form guards are issued centrally by `phis`.
- Frontend pages should fetch form guards server-side via an internal call to `GET /api/v1/forms/guard`.
- Frontend `/api/contact` and `/api/register` routes are thin forwarders only.
- Site-specific form/mail runtime config is split as follows:
  - process-level flags such as `PORT` may remain in environment variables
  - central runtime secrets and service settings are loaded from `config/phis-runtime.json`
  - `public_base_url`, `mail_from`, `mail_from_name`, `support_email`, `contact_recipient`, `medusa_base_url`, and `medusa_publishable_key` are loaded from the `site_config` table
  - `medusa_base_url` must point to the canonical Medusa backend base that exposes `/auth` and `/store`; it must not point to the public `/api/shop` proxy path
  - media storage settings are also loaded from `config/phis-runtime.json` and may select a local filesystem backend or an S3-compatible provider

## Versioning
All external endpoints live under `/api/v1/`.

## Caching policy

- GET/HEAD endpoints under `/api/v1` are cache-eligible by default.
- The local frontend proxy uses a shared cache tag (`phis-api-v1`) and explicit revalidation.
- Recommended cache defaults:
  - `/api/v1/tr` -> `revalidate: 86400`
  - `/api/v1/locales` -> `revalidate: 86400`
  - `/api/v1/news` -> `revalidate: 86400`
  - all other `GET/HEAD` public `/api/v1/*` -> `revalidate: 86400`
- POST/PUT/PATCH/DELETE/OPTIONS remain non-cacheable and must be treated as write/command paths.
- Tagging baseline is `phis-api-v1` (common tag for all public API cache entries).
- Explicit UI/admin revalidation should call `revalidateTag("phis-api-v1")` after content/admin mutations.
- Invalidating the baseline tag is enough to clear all cache entries that also carry endpoint-specific tags (`phis-api-v1:<segment>`), because each cached response is tagged with both.
- Invalidation belongs to the consumer's own server side, which is why this API exposes no endpoint for it: admin cache control must not become a public route.
- Optional endpoint-level tags can be added later (`phis-api-v1:<endpoint>`, `phis-api-v1:locale`), but are not required for the baseline.
- Non-public/internal endpoints and user-specific responses should not be cached.

## Endpoints

### GET /api/v1/presets
Returns the public preset list.

**Headers**
- `x-phis-token`: required
- (value for public endpoints must match the configured public API token)

**Query params**
- `collection` (optional): filter by collection slug

**Response**
```json
{
  "version": "2024-09-20",
  "presets": [
    {
      "id": 1,
      "name": "Lamp Glow",
      "slug": "lamp-glow",
      "tags": ["warm", "evening"],
      "imageUrl": "https://.../image.png?v=1726790400000",
      "palette": ["#F8C27A", "#6B3B2A"],
      "collectionSlug": "cozy",
      "createdAt": "2024-09-01"
    }
  ]
}
```

### GET /api/v1/preset-collections
Returns the preset collections list.

**Headers**
- `x-phis-token`: required

**Response**
```json
{
  "version": "2024-09-20",
  "collections": [
    {
      "id": 1,
      "name": "Cozy",
      "slug": "cozy",
      "description": "Warm evening scenes",
      "presetCount": 12,
      "imageUrl": "https://.../image.png?v=1726790400000"
    }
  ]
}
```

### GET /api/v1/locales
Returns the supported locales list.

**Headers**
- `x-phis-token`: required

**Response**
```json
{
  "defaultLocale": "en",
  "locales": ["en", "de"],
  "labels": {
    "en": "English",
    "de": "German"
  },
  "options": [
    { "code": "en", "label": "English" },
    { "code": "de", "label": "German" }
  ]
}
```

### GET /api/v1/news
Returns the news feed (latest first).
Items with `outdated` dates in the past are omitted.

**Headers**
- `x-phis-token`: required

**Response**
```json
{
  "version": "2024-10-02",
  "news": [
    {
      "id": "phi-vision-update",
      "created": "2024-10-02",
      "outdated": null,
      "title": "Phi vision update",
      "subtitle": "Clearer path for the automation OS.",
      "content": "We clarified the long-term roadmap around adapters, channels, and automation graphs.",
      "link": null,
      "tags": ["roadmap"]
    }
  ]
}
```

### GET /api/v1/tr
Returns a translated string using cached DeepL results.

**Headers**
- `x-phis-token`: required

**Query**
```text
locale=de&msg=Hello%20world&ctx=landing&hash=3a52e668b4de55309c7cf18e4f4b89fa03063035f4a7d4fb3bc00f6baa5538ef&format=text
```

**Response**
```json
{
  "translation": "Hallo Welt"
}
```

`GET` is the preferred frontend lookup path because Next.js can cache it in render fetches.
`hash` is optional. If omitted, the server computes SHA-256 using only the first 50 characters
of `msg`.
`format` is optional and defaults to `text`; use `html` when the source string is intentional translatable HTML markup.

## Errors
- `403 Forbidden`: missing/invalid token, missing user-agent, or blocked bot user-agent
- `429 Too many requests`: rate limit hit; includes `Retry-After` header

### POST /api/v1/email/send

Used for internal server-to-server email dispatch for registration/contact workflows.

Headers:

- `x-phis-token` **or** `Authorization: Bearer <token>` required
- internal endpoints require the configured internal API token

Body:

- `template`: one of `registration_verify`, `registration_welcome`
- `to`: recipient email address
- `locale`: locale string (`en`, `de`, ...)
- `name`: optional recipient name
- `siteKey`: optional site key; fallback resolves from headers / request context
- `verificationUrl`: required when `template=registration_verify`
- `body`: optional generic email payload with `subject` and either `text` or `html`

Response:

- `sent`: boolean
- `template`: selected template
- `siteKey`: resolved site key
- `to`: recipient
- `messageId`: nodemailer message id (nullable)

### GET /api/v1/forms/guard

Used for server-side form rendering. Returns signed guard fields for a supported public form.

Headers:

- `x-phis-token` **or** `Authorization: Bearer <token>` required
- internal endpoints require the configured internal API token
- `x-phis-site-key` required; there is no host, origin or referer fallback

Query:

- `form`: `contact` or `registration`

Response:
```json
{
  "form": "contact",
  "siteKey": "phisys",
  "issuedAt": "1742630400000",
  "formToken": "..."
}
```

### POST /api/v1/forms/contact

Internal centralized contact-processing endpoint.

### POST /api/v1/forms/register

Internal centralized registration-intent endpoint.

### POST /api/v1/forms/register/confirm

Internal centralized registration confirmation endpoint.

Headers:

- `x-phis-token` **or** `Authorization: Bearer <token>` required
- internal endpoints require the configured internal API token
- `x-phis-site-key` required; there is no host, origin or referer fallback

Body:

- `token`: verification token from the registration email link

Response:

- `ok: true, status: "confirmed"` when Medusa customer creation succeeded
- `ok: true, status: "already_confirmed"` when the token was already consumed
- `ok: false` with `code` for invalid/expired/non-usable tokens

## Notes
- Responses include an `ETag` header and support `If-None-Match` for `304`.
- JSON responses are cached (see `Cache-Control` per route).
- `GET /api/v1/news` and `GET /api/v1/presets` include permissive CORS headers for browser clients.

## Supported devices

Device type enum: `unknown`, `wifi`, `ble` (Bluetooth Low Energy), `bt` (Bluetooth Classic), `zigbee`, `thread`, `lan`, `zwave`, `infrared`

Device class enum:
```
enum class DeviceClass : quint8 {
  Unknown     = 0,
  Light       = 1,
  Switch      = 2,
  Sensor      = 3,
  Button      = 4,
  Plug        = 5,
  Cover       = 6,
  Thermostat  = 7,
  Gateway     = 8,
  MediaPlayer = 9,
  Heater      = 10,
  Gate        = 11,
  Valve       = 12,
  // ...
};
```

| Model | Manufacturer | Adapter/Plugin Type | Type | DeviceClass |
| --- | --- | --- | --- | --- |
| TBD | TBD | TBD | wifi | Unknown |
