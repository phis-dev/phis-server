# phis (phi server)

`phis (phi server)` is the dedicated **backend/API** for the frontend.
The project primarily exposes API endpoints and runs independently from the frontend as a separate service.

## Initial Version / Intent

- This API instance is the clean initial version: no Payload/CMS fallback interface, no UI layer, and no legacy compatibility layers.
- v1 favors explicit contract changes over compatibility shims. ABI breaks are acceptable when they keep the contract coherent.
- Focus on `api-dev.phi-systems.tech` (dev) and `api.phi-systems.tech` (prod) as the only public API hosts.
- No workarounds without prior approval.
- Always identify the real root cause first; if unclear, consult official documentation or migration notes before changing a contract.
- Documentation must be written in English.

## Frontend Separation

- Frontend repositories such as `phisys.com` and `phi-systems.tech` consume the API via:
  - Dev: `https://api-dev.phi-systems.tech`
  - Prod: `https://api.phi-systems.tech`
- Public content can be loaded in the frontend through SSR or Server Components.
- Commerce browser calls are standardized through site-local `/api/shop/*` (rewritten to `/store/*`).
- Authentication browser calls use the Site runtime's same-origin `/api/auth/*` facade over the canonical
  `phis` `/api/v1/auth/*` API.
- SSR and server-only code may call `api-*` directly so caching stays controlled and operational flow remains explicit.
- `phis` is the session owner for storefront auth flows.
- Browser-facing session cookies are set and read on the site runtime, while `phis` issues and verifies the underlying session state.
- SSR and Server Actions consume that session state, but they do not replace cookie-based session transport.
- Medusa remains the commerce/customer backend and may be called by `phis` for customer synchronization,
  but it is neither the Phi identity authority nor the browser-session owner.
- This service is the target home for storefront session and auth routes; browser-visible cookies remain host-bound at the consuming site.

## Database Model

The database-facing contract lives in [DB.md](./DB.md).
It contains:

- target `phis` schema
- smallint and flag contracts
- table-level contracts
- global vs site translation model

The normative canonical-source, external-source, context-flag, provider-batching, and structured-document
translation contract lives in [TRANSLATIONS.md](./TRANSLATIONS.md).

The normative mutable Site Page path and structured Page/Asset reference contract lives in
[REFERENCES.md](./REFERENCES.md).

CMS rich HTML is sanitized authoritatively by the backend when an HTML content binding is posted. The
sanitized value is the only value written to Widget config and `site_content(type=html)`; Public and App
clients do not repeat that persistence check. That sanitizer is also the enforcement point for the
internal content channel: it preserves canonical `phi:page/` and `phi:asset/` URIs, drops obfuscated or
malformed ones, and the same write transaction indexes the surviving references into
`site_cms_references`.

## Server Add-on Contract

The normative extension, capability, installation, routing, Site-enablement, migration, and
load-balancing contract lives in [SERVER_ADDONS.md](./SERVER_ADDONS.md).

The normative target v1 Site viewer-role, provider-claim, persistence, and access-enforcement contract
lives in [AUTHORIZATION.md](./AUTHORIZATION.md).

The provider-neutral Site user/group administration and future LDAP, Active Directory, SCIM, Entra, or
other Directory Add-on boundary lives in [DIRECTORY_PROVIDERS.md](./DIRECTORY_PROVIDERS.md).

The normative target v1 global-user, Site authentication-method, identity-linking, session, Auth Module,
and CLI-recovery contract lives in [AUTHENTICATION.md](./AUTHENTICATION.md).

Approved but not yet implemented infrastructure and contract work is tracked in [TODOS.md](./TODOS.md).

The terminology is strict:

- Site/client extensions are **Modules**.
- Server extensions are **Add-ons**.
- One package carries one product: a Module half, an Add-on half, or both, under one name and one
  version. The Add-on half lives under `@scope/name/addon/…`.
- Every Module binds to exactly one Add-on or to Core.
- Only `phis-cli` may install, migrate, build, or globally activate Add-on code.
- A Site may enable or disable only an already installed Add-on for itself.

## Media Storage Contract

The normative target-v1 contract for general Site groups, Site/User/Group Media Spaces, folders,
quotas, Storage Profiles, Local and Add-on Storage Providers, uploads, migration, and protected Asset
delivery lives in [GROUPS_AND_STORAGE.md](./GROUPS_AND_STORAGE.md).

The global `media.kind` switch, `media_groups`, ambiguous Asset `user_id`, persisted `public_url`, and
Storage-key delivery are removed. A Storage Provider and its configuration bind per Site through
`media_storage_profiles`, and delivery resolves by Asset id and variant key. `config/phis-config.json`
retains only local Storage defaults under `media.storageKeyPrefix` and `media.local.rootDir`; inline S3
credentials are not part of the model. Remaining implementation work is tracked in
[TODOS.md](./TODOS.md).

## CMS direction

- `phis` is the structural CMS source for standard site pages.
- The backend owns page lookup, region composition metadata, widget placement, widget config, and redaction/publishing state.
- Layout, Widget, Overlay, and resolved Navigation item instances use exactly one canonical 96-bit `PhiCmsInstanceId`, serialized as 16 Base64URL characters. Draft, preview, published runtime, persistence, history, structural references, and `cms:<instanceId>[:<subcontrolKey>]` signal receivers all use the same id where applicable; there is no negative/positive CMS node-id lifecycle, UUID alias, or parallel runtime identity.
- The central shared CMS instance creator/codec is the only identity authority. Codec v1 includes the closed `area`, `page`, or `navigation` domain. Preset instances derive deterministically from `(contractVersion, domain, ownerModuleId, presetKey, nodeKey)` without Site/target/path input. New and duplicated authored instances use the owning Area, Page, or Navigation Draft revision plus its persisted sequence. Third-party packages never generate concrete identities.
- A Page/Area Working Draft keeps one stable revision row across saves. Its revision metadata owns the optimistic Draft `version` and monotonic `nextNodeSequence`; stale versions conflict and deleted sequence values are never reused.
- Page and Area publish validate 96-bit encoding, active-context uniqueness, structural references, and signal targets, then atomically activate the selected revision without remapping node identities.
- `phis` must not know React component names or frontend import paths.
- Standard pages are intended to resolve through explicit area routing in the consuming frontend:
  - `app/[lang]/layout.tsx`
  - `app/[lang]/[area]/layout.tsx`
  - `app/[lang]/[area]/[[...path]]/layout.tsx`
  - `app/[lang]/[area]/[[...path]]/page.tsx`
- `area` comes from the canonical set `public`, `app`, `admin`, `builder`, `editor`, or `accounting`.
- Area resolution should follow a stable contract:
  - `public` for anonymous/public browsing
  - `app` for authenticated users without a dedicated staff Area, including Supporters
  - `admin`, `builder`, `editor`, and `accounting` only for matching site-role users
- Staff role to area mapping must follow this contract:
  - `Admin -> /admin`
  - `Developer -> /admin`
  - `Builder -> /builder`
  - `Author -> /editor`
  - `Publisher -> /editor`
  - `Supporter -> /app`
  - `Accountant -> /accounting`
- Support is a Site Module backed by Core support/thread/resource-link capabilities, not a fixed CMS
  Area. Its pages and navigation may be injected into any eligible Area by the Site module contract.
- Default area resolution priority should be:
  - `admin`
  - `builder`
  - `editor`
  - `accounting`
  - `app`
  - `public`

### Site role contract

The complete target v1 contract is defined in [AUTHORIZATION.md](./AUTHORIZATION.md). Core and
third-party roles are Site-scoped, additive provider-local flag matrices. Runtime transport contains
provider claims rather than expanded permission lists.

Core Admin is the Site superuser for every Site-scoped role policy. It is intentionally not repeated in
ordinary access masks. The override does not satisfy anonymous-only presentation, unavailable
capabilities, disabled Add-ons, external-provider authorization, operator authority, or cross-Site
access.

| Capability | Admin | Developer | Builder | Author | Publisher | Supporter | Accountant |
| --- | --- | --- | --- | --- | --- | --- | --- |
| User and role administration | yes | no | no | no | no | no | no |
| Site settings and locale settings | yes | no | no | no | no | no | no |
| Operational logs and developer tools | yes | yes | no | no | no | no | no |
| Builder structure drafts | yes | yes | yes | no | no | no | no |
| Theme and navigation drafts | yes | yes | yes | no | no | no | no |
| Editorial content and translations | yes | yes | no | yes | yes | no | no |
| Review drafts and revisions | yes | yes | yes | yes | yes | no | no |
| Publish drafts | yes | yes | no | no | yes | no | no |
| Support tickets | yes | yes | no | no | no | yes | no |
| Accounting and billing | yes | yes | no | no | no | no | yes |

Area access uses the same shared declarative access policy:

| Area | Roles |
| --- | --- |
| `/admin` | `Admin`, `Developer` |
| `/builder` | `Admin`, `Developer`, `Builder` |
| `/editor` | `Admin`, `Developer`, `Author`, `Publisher` |
| `/accounting` | `Admin`, `Developer`, `Accountant` |

API guards, Area access, Pages, Navigation, and renderable contributions must delegate to the same
policy evaluator. Role-specific guard names may remain only as wrappers around canonical policies.

An Add-on-backed Site Module may always inspect Core roles and may additionally inspect roles of its
own bound provider. A Developer can therefore receive an Add-on role such as GitHub Admin without
receiving Core user- or role-administration authority.

Pure builders can create and update builder drafts but cannot publish without an additional `Publisher` role. Pure authors can perform editorial work and review drafts/revisions but cannot publish. Pure publishers can review drafts/revisions, correct editorial content, and publish drafts, but cannot change builder structure, theme, or navigation. Developers are site technical co-admins for builder, authoring, publishing, support, accounting, and logs, but they must not manage users, roles, site settings, or locale settings.

- `builder` is the structural and design-authoring area.
- `editor` is the content and publishing area.
- `dev` is the technical and diagnostic area.
- Staff areas and commerce/customer identity should stay disjoint:
  - `admin`, `builder`, `editor`, `accounting`, and `dev` users should not also be modeled as Medusa customer users
- If `site + area + normalized page path` is not found in the CMS backend, the consuming frontend should return `404`.
- Site-specific special flows may still live as explicit Next.js routes outside the CMS path.

## Bootstrap Contract

- The site scaffold bootstrap and repair contract lives in [BOOTSTRAP.md](./BOOTSTRAP.md).
- `phis init` should materialize the site scaffold.
- `phis reconcile` should repair or refresh an existing scaffold.

### CMS rendering contract

- A standard CMS page resolves by `site + area + path`.
- The default outer region set is owned by an area preset, not by the page itself.
- An area preset activates a fixed set of regions such as:
  - `header_top`
  - `header_main`
  - `header_bottom`
  - `hero`
  - `sider_left`
  - `sider_right`
  - `content`
  - `footer_top`
  - `footer`
  - `drawer`
- Every active region must point to exactly one root layout node.
- Regions must never contain content widgets directly.
- Layout nodes may contain child layout nodes and child content widgets.
- Content widgets are leaf nodes and must never own children.
- The shell owns placement for all stable outer slots, including `header_bottom`, `hero`, `sider_right`, `footer_top`, and `content`.
- Page-level CMS records provide payload for page-capable shell slots:
  - `header_bottom`
  - `hero`
  - `sider_right`
  - `footer_top`
  - `content`
- `content` is the only truly page-internal region in the target contract.
- Page-level payload must not redefine the outer area frame; it only fills the shell's page-capable placeholders.
- Controlled page-level slot injections into area-owned regions are allowed when the area preset contract explicitly exposes those slots, for example `header_main.actions`.
- Widget-specific configuration belongs to widget rows, not to `sites.theme.widgets.*`.
- `sites.theme` remains reserved for site-wide presentation defaults such as colors, fonts, and shell-level deltas.
- Backend region/preset payloads should normalize to a stable shared contract in `@phis/ui/types` before rendering.
- CMS live reads stay on:
  - `GET /api/v1/site/area`
  - `GET /api/v1/site/page`
- Normal live reads resolve the published CMS revision state only.
- Normal published-live reads are the primary performance path and must not pay draft-preview or builder overhead.
- `/public` and `/app` are the primary live-performance Areas and should stay on the published-only read path unless an explicit preview request is active.
- Draft previews use the same read endpoints with `revision=<id>`.
- `revision=<id>` is an explicit authoring/preview path and may pay extra cost for cookies, role checks, and draft-revision reads.
- Draft preview reads require:
  - the internal API token
  - a site-scoped session
  - and an effective role of `Builder`, `Author`, `Publisher`, `Developer`, or `Admin`
- CMS builder reads and mutations live on:
  - `GET /api/site/cms/area/draft`
  - `POST /api/site/cms/area`
  - `DELETE /api/site/cms/area`
  - `POST /api/site/cms/area/publish`
  - `GET /api/site/cms/page/draft`
  - `POST /api/site/cms/page`
  - `DELETE /api/site/cms/page`
  - `POST /api/site/cms/page/publish`
  - `GET /api/site/cms/theme`
  - `GET /api/site/cms/theme/draft`
  - `POST /api/site/cms/theme`
  - `DELETE /api/site/cms/theme`
  - `POST /api/site/cms/theme/publish`
- `POST /api/site/cms/area`, `POST /api/site/cms/page`, and `POST /api/site/cms/theme` now save draft revisions only.
- `POST /api/site/cms/*/publish` promotes a selected draft revision to the published revision pointer for the requested scope and requires publisher permissions.
- `GET /api/site/cms/theme` exposes the Theme scope's explicit `publishedRevisionId` and `workingDraftRevisionId`; Builder clients use those pointers to distinguish the concrete Site Theme from immutable preset choices and must not infer ownership by comparing Theme payloads.
- `GET /api/v1/site` exposes the same pointers as `site.themeRevision` so server-rendered Builder presets can select the Site-owned Theme before hydration. The Theme payload remains under `site.theme`; revision ownership metadata must not be embedded into the visual payload.

### CMS ownership split

- `phis` stores only:
  - widget `PhiCmsInstanceId` identities / namespaced widget types
  - widget flags
  - widget config JSON
  - parent/region/slot placement
  - `content_id` references into `site_content`
- area-specific access requirements live on page-level CMS records, not on widget records
- widget `site_id` and `content_id` are intentionally redundant so widget ownership stays site-local while the referenced content remains explicit; writers must validate that both belong to the same site
- `site_content(type=asset)` is created on demand when a widget binds a media asset; media uploads themselves do not eagerly create content rows
- `site_content(type=text)` is the intended persisted source for normal `simple-text` widget copy so search, revisions, and later publisher/editor flows can resolve that text centrally
- a future rich-text widget should use its own dedicated `site_content(type=html)` path instead of overloading `type=text`
- the backend write path must not branch on concrete widget `typeKey`s for that content persistence contract
- instead, the incoming CMS widget row should declare explicit content-binding metadata, for example storage channel and source field, and the backend should persist against that declarative contract
- shared preset trees are the explicit exception: they may still ship local `simple-text.config.text` values without a backing `content_id`
- `simple-text` uses the widget `NoTranslate` flag in the CMS revision widget payload to render source text directly and skip translated lookup
- deleting a widget must remove its owned `site_content` only when no other widget in the same site references the same `content_id`; otherwise only the widget row is removed
- deleting a media asset must remove its owned `site_content(type=asset)` wrapper rows, but must be rejected while any widget/layout/page/area/navigation tree still references that content or asset
- Numeric widget and layout type IDs are defined by central frontend registry constants, not by backend-local hardcodes.
- `@phis/ui` resolves internal widget types into shared widget implementations.
- Site frontends resolve only site-custom widgets through a dedicated bridge component.
- Backend-owned widget contracts must stay numeric and documented; frontend component names must never leak into SQL or JSON payloads.
- Backend validation must currently enforce direct-slot cardinality:
  - one direct node per slot
  - a direct node may be either a layout node or a content widget
  - specialized layouts may additionally restrict which slot types are allowed
- Runtime communication for standard CMS pages should stay layered:
  - site frontend such as `phisys.com`
  - `@phis/ui`
  - `phis`

## Registration and Email Verification Contract

Registration, verified-email account discovery/linking, credentials, bootstrap, and Site membership follow
[AUTHENTICATION.md](./AUTHENTICATION.md).

- `registration_intents` is Site-scoped workflow history, not global account identity.
- The final global user is `user_accounts`; verified addresses, password credentials, and Site membership
  are persisted through their normalized relations.
- Registration mode is Site policy. Public registration never grants an Admin role, including on an empty
  Site; first-Admin setup is a `phis-cli` bootstrap operation.
- A matching verified email never creates a duplicate global user. Linking is completed only through the
  configured `disabled`, `verified-email-confirm`, or `verified-email-auto` policy and its safety gates.
- Auth Core owns verification tokens, replay protection, rate limiting, and final transaction boundaries.
  Form guard secrets remain Site configuration, while short-lived challenge state may use Redis or an
  equivalent central expiring store.
- Email changes write `user_emails`; password changes write `user_password_credentials` and apply the
  configured session-revocation policy.
- Medusa account creation or synchronization is a separate Site-scoped commerce workflow represented by
  `user_site_external_accounts`; it does not become Phi identity or session authority.
- Email delivery is server-only and protected. Outbound mail uses `mx01.phisys.com` primary with
  `mx02.phisys.com` fallback.

## Locale Capability Contract

- Locale support has two levels:
  - `phi-server` defines the maximum platform capability superset.
  - each site enables only a subset of that superset.
- The platform superset must cover at least every target language supported by the configured DeepL target-language snapshot.
- Site config must be validated against that superset:
  - `default_locale` must be known to Phi.
  - every entry in `available_locales` must be known to Phi.
  - `default_locale` must be included in `available_locales`.
- Site locales should use BCP-47-style identifiers where applicable, for example `de-DE`, `de-CH`, `en-US`, `en-GB`, `ja-JP`, `zh-Hans`, `zh-Hant`, `pt-BR`, and `pt-PT`.
- Runtime locale resolution must return capability data, not only a string:
  - effective site locale
  - language/script/region
  - text direction
  - DeepL target language
  - Ant Design locale key
  - Intl locale
  - Phi label fallback chain
- External integrations must use their resolved target instead of the raw site locale:
  - DeepL example: `de-CH -> DE`, `en-GB -> EN-GB`, `pt-BR -> PT-BR`, `zh-Hans -> ZH-HANS`.
  - Ant Design example: `de-CH -> de_DE`, `en-GB -> en_GB`, `zh-Hans -> zh_CN`.
- Locale, translation-target, Ant Design locale, direction, and fallback-chain mapping must be resolved centrally by `phi-server`.
- `GET /api/v1/site/locale` is the request/runtime resolver. It accepts the raw browser/request locale context and returns the validated resolved locale contract.
- Resolution order is explicit request locale, authenticated user preference, locale cookie, browser `Accept-Language`, then site default.
- `sourceLocale` and `defaultLocale` are separate concepts. The immutable Site `sourceLocale` owns CMS source text and Site translation messages; `defaultLocale` is only the final request-locale fallback.
- Site-scoped translation requests derive `sourceLocale` from the Site when the caller omits it. An
  explicit different source locale selects the protected external-source path defined in
  `TRANSLATIONS.md`. Admin Locales exposes the canonical Site source read-only together with locale
  settings; Editor Translations exposes it with its translation workspace data.
- Global Core, package, and preset translation requests are not Site-scoped. Phi-owned preset source text is `en` and never inherits a Site locale.
- The Site source locale remains available as a Site locale but is excluded from translation-target selectors. A Site with no target locale returns an empty translation workspace instead of treating its source as a target.
- `phi-shared-ui` must not carry the platform capability table. It consumes the resolved locale contract and maps the effective locale to its own bundled UI locale modules, such as Ant Design and Dayjs.
- Site configuration remains separately cacheable. Request locale resolution is `no-store` because it can depend on user session, cookies, and request headers.
- Sites may restrict their offered locales, but they must not expand beyond the platform superset.
- When DeepL adds new target languages, update the platform capability superset first; sites may opt into the new locales only after that update.
- Translation sources must contain only translatable text and stable placeholders. Dynamic values such as first names, last names, usernames, email addresses, company names, customer numbers, site names, and URLs must never be embedded directly into a string that is sent to `tr`, `trGlobal`, a label set, or `translateWithCache`.
- If dynamic values are part of visible translated text, use positional placeholders in the source text and apply the values after translation. The canonical format is `%1`, `%2`, ...; for example `Hello %1,` with `%1 = recipientName`.
- `/api/v1/tr` accepts an optional `format` hint. `text` is the default; `html` means the source string is intentional translatable HTML markup and should use the provider's HTML-aware translation mode when available.
- Label sets are static UI copy only. They may contain placeholder templates such as `Login history for %1`, but they must not contain already-resolved user/profile/company/email values.
- Email templates follow the same contract: the template line is translated first, then recipient names, site names, support emails, and links are inserted into `%n` placeholders.

## Customer number contract

- Customer numbers are generated centrally in `phis`.
- The site-specific prefix is stored in `sites.customer_number_prefix`.
- By default, the effective Site customer number is derived from the global `user_accounts.id`.
- Format:
  - `<PREFIX>-<ID padded to 7 digits>`
- A Site that owns an external customer-number lifecycle stores its optional explicit value on the
  matching `user_site_external_accounts` relation, never on the global user row.
- Example:
  - `PHS-0000123`
- Padding is only the minimum width. Higher IDs continue to grow naturally:
  - `PHS-12345678`
- Gaps in numbering are acceptable and expected. The effective numeric part must remain traceable back to the final `user_accounts.id`.
- The default fallback is `<PREFIX>-<user.id padded to 7 digits>`.

## Internal Request Security for Mail Endpoints

- Mail-sending endpoints in `phis` are not intended for direct public use.
- A static shared token header is required for initial implementation.
- Recommended initial contract:
  - Frontend-side API route adds `Authorization: Bearer <PHI_INTERNAL_TOKEN>` when calling `phis` mail-related endpoints.
  - `phis` must reject calls without a valid token.
  - The token is loaded from server runtime config and never exposed to browser code.
- Future hardening:
  - Move to HMAC signed request validation with timestamp and nonce.
  - Headers:
    - `X-Internal-Timestamp`
    - `X-Internal-Nonce`
    - `X-Internal-Signature` (`HMAC_SHA256(secret, method + path + timestamp + nonce + bodyHash)`)
  - Reject requests outside a small clock-drift window and reject replayed nonces.
- Alternative second layer (optional):
  - a short-lived grant token (about 30 seconds), issued by the frontend service and verified by `phis` before sending email.
  - This requires shared Redis/central cache access between frontend and `phis`.
  - The grant token should be single-use and consumed on first successful verification request.

## Logging Contract

- Runtime logs must be emitted as one-line JSON objects to stdout/stderr so `systemd` and `journalctl` can filter them consistently.
- Do not add a separate log table for operational logging.
- CLI commands may keep human-readable text output; this contract applies to runtime server and proxy logs.
- Fixed service names are `phi-server`, `phi-ui`, `phi-site`, and `phi-cli`.
- Runtime code should log through a `PhiLogger` instance with `child(...)`, `debug(...)`, `info(...)`, `warn(...)`, and `error(...)`.
- The common log shape is:
  - `ts`
  - `level`
  - `service`
  - `event`
  - `message`
  - optional `siteKey`
  - optional `area`
  - optional `requestId`
  - optional `userId`
  - optional `actorRole`
  - optional `pluginKey`
  - optional `method`
  - optional `path`
  - optional `status`
  - optional `durationMs`
  - optional `targetType`
  - optional `targetId`
  - optional `error`
  - optional `meta`
- `event` names should use dot notation, for example:
  - `auth.login.success`
  - `auth.login.failed`
  - `auth.password.reset.requested`
  - `auth.profile.email.change_requested`
  - `auth.profile.password.updated`
  - `admin.user.created`
  - `admin.user.updated`
  - `admin.user.deleted`
  - `proxy.request.slow`
  - `proxy.request.failed`
  - `translation.fallback`
  - `form.abuse.detected`
- `siteKey` is mandatory for site-scoped request logs.
- `requestId` should be added whenever a request context is available.
- The admin log feed is owned and served by `phi-server` at `GET /api/site/admin/logs`; it is the only supported reader for site-scoped operational logs and must filter by `siteKey` before applying secondary query filters.
- Sensitive values such as passwords, full tokens, and raw secret material must never be logged.
- Emails, IP addresses, and user agents should only be logged when they are relevant to the event.
- Prefer `warn` for degraded but expected states, `error` for failures, and `info` for successful lifecycle events.
- Successful CMS mutations use the closed `PhiCmsAuditEvent` vocabulary. It covers page, area, navigation, and theme draft saves/deletes and publishes plus revision restore/delete operations.
- Draft reset endpoints emit `*.draft.deleted` only when a draft was actually removed; they do not imply deletion of published content.
- CMS reads and ordinary page requests do not emit audit events.

### API Routing Standard

- `/<site>/api/shop/*` is the commerce pass-through to Medusa (`/store/*`).
- `/<site>/api/auth/*` is the same-origin Site facade for Core authentication under `/api/v1/auth/*`.
- CORS remains enabled for direct browser calls against `api.*` with explicit allow-origins instead of a wildcard.
- Non-personalized `GET` endpoints are cacheable via TTL or revalidation on the API or frontend layer.
- Personalized or sensitive endpoints such as `cart`, `customer`, `session`, and uploads must use `no-store`.
- Site-aware API endpoints require `x-phi-site-key`. The former host/origin/referer fallback is removed:
  a request without the explicit key is not Site-scoped. Site proxies and SSR callers inject the header;
  the commerce `/api/shop/*` path is unaffected because it terminates at Medusa, not at `phis`.

### API-only Note

- This repository only serves backend routes.
- All existing UI and `[lang]` pages were removed.
- New frontends should consume `/api/shop/*` for Medusa commerce, `/api/auth/*` for same-origin Phi
  authentication, and the appropriate Site-local API facade for other backend APIs.

## Getting Started

Runtime baseline:

- packaged runtime and emitted `dist` CLI are validated with Node `20.19.2` or newer
- repository-local development should use Node `22` or newer
- the source CLI entrypoint `pnpm phis` requires a newer Node because it uses `--experimental-strip-types`

Package manager contract:

- Until `phi-server`, `phi-shared-ui`, and the frontend packages are split into standalone repositories, the workspace root `pnpm-lock.yaml` is the authoritative lockfile.
- Do not use or maintain `package-lock.json` in this repository during the workspace phase.
- After the repository split, each standalone package must choose exactly one package manager lockfile and generate it fresh from that package's own `package.json`.
- TODO: Revisit ESLint 10 after `eslint-plugin-react`, `eslint-plugin-import`, and `eslint-plugin-jsx-a11y` publish ESLint 10-compatible releases. The current latest versions are transitively required by `eslint-config-next` and crash or declare peers only up to ESLint 9.

Start via the Next.js dev server:

```bash
pnpm dev
```

For the shared development stack:

```bash
# in systemd: via ENV PORT=3101
pnpm dev -- --port 3101
```

The dev service runs on port `3101`.

### Consuming frontend production bundler policy

For the Phi Next.js frontend that consumes this API, use the default Turbopack
pipeline for local development and production builds:

```bash
# development
pnpm dev

# production build
pnpm build
```

The former Webpack production override is no longer required: the Next.js 16.2.11
Turbopack production graph keeps inactive Builder implementations out of the Public
payload. Validate production behavior through downloaded browser resources and
interactivity, not build duration or `.next` size.

## Environment

Set only process/runtime values such as `PORT` through `.env`.

Application runtime configuration now lives in JSON files:

- `config/phis-config.json`
  - tracked, non-secret static config
- `config/phis-runtime.json`
  - local/untracked runtime and secret config

`config/phis-runtime.json` contains:

- `database.uri`
- `api.internalToken`
- `deepl.apiKey`
- `registration.intentEncryptionKey`
- `forms.timeouts`
- `cors.*`
- `email.*`

`config/phis-config.json` contains tracked non-secret defaults such as:

- `runtime.containerized`
- `bootstrap.enabled`
- translation defaults
- `media.defaults.*`

`media.defaults` holds the versioned Media installation defaults applied once when a Site's
`site_media_config` row is first materialized: `userQuotaBytes` and `groupQuotaBytes`. Capacity only --
whether a User or Group Space exists at all follows from the Modules a Site activates, so a Site that
activates none has neither. The layer is operator-owned; Site administration edits the database row
instead, and there is no request-time fallback to configuration. See
[GROUPS_AND_STORAGE.md](./GROUPS_AND_STORAGE.md).

`DEFAULT_CONFIG` in code is intentionally only a minimal technical fallback.
The actual versioned product defaults live in `config/phis-config.json`, and
`config/phis-runtime.json` overrides both for the local running instance.

## Runtime Config

Runtime config is read from `config/phis-config.json` and `config/phis-runtime.json` at runtime.

`forms.timeouts` is the generic submit-guard timing block. It defines the
shared minimum and maximum submit age for form guard checks and applies to all
forms.

The effective config root is resolved in this order:

- `PHIS_ROOT`, when set
- otherwise the current working directory

This applies both to the running server process and to the `phis` CLI unless the CLI receives `--root|-r <path>` explicitly.

For Debian or `systemd` stage deployments, the service should keep the application
runtime under the installed app root and set `PHIS_ROOT=/srv/phis/stages/<stage>`.
The recommended loopback port convention for the central `phis` runtime starts at
`5301` for the first stage (`prod` by convention) and increments by `1` for each
additional stage. Port assignment is a host-local deployment choice and must not
be derived from the stage name itself; stage names remain free-form.

`/setup/*` routes are only available when `bootstrap.enabled` is set to `true` in the merged config, typically via `config/phis-config.json`.
Otherwise those routes return `404`.

Runtime config policy:

- Hard runtime config such as `database.uri`, internal API tokens, bootstrap mode, and base transport settings is expected to stay stable while the process runs.
- `runtime.containerized` defaults to `false` when omitted and may be shipped as tracked config when the deployment target is explicitly container-based.
- `api.publicToken` is the incoming public API token for this phis instance.
- `api.phisCdnPublicToken` is a separate outgoing token used when this instance reads global translations from an upstream phis CDN.
- Config-backed platform operators are the exception: authentication should read them fresh from `config/phis-runtime.json` instead of relying on a long-lived process cache.
- Soft operator config changed through the admin UI, such as a DeepL API key, may be written to `config/phis-runtime.json` and applied directly by the responsible save flow.
- Process-critical config changes do not require a generic global reload mechanism; they either stay static for the running process or require an explicit restart/reinitialization path.

## phis CLI

`phis` includes an operator-oriented CLI for runtime config and break-glass operator management.

Node support split:

- packaged runtime and emitted `dist/cli/phis.mjs` support Node `20.19.2+`
- repository-local source CLI development uses Node `22+`
- `pnpm phis` is a source-level development helper and is not the compatibility baseline for packaged deployments

The CLI runs against the current working directory by default. To target another
phis installation root, append `--root|-r <path>`. Without `--root`, the CLI
uses `PHIS_ROOT` first and falls back to the current working directory.

Direct shell wrapper:

- `./phis config validate`
- `./phis operator list`
- `PHIS_ROOT=/srv/phis/stages/prod ./phis config validate`
- `./phis --root /srv/phis/stages/prod config validate`

Optional installation into the system path:

- `./scripts/install-phis-cli.sh`
- `./scripts/install-phis-cli.sh /usr/local/bin/phis`

By default the installer creates a symlink. To copy the wrapper instead:

- `PHIS_INSTALL_MODE=copy ./scripts/install-phis-cli.sh`

Examples:

- `./phis config paths`
- `./phis config validate`
- `PHIS_ROOT=/srv/phis/stages/prod ./phis config paths`
- `./phis --root /srv/phis/stages/prod config paths`
- `./phis site list`
- `./phis site add --key moonhug --name "Moonhug" --hostname moonhug.example --public-base-url https://moonhug.example --source-locale en --default-locale de --available-locales de,fr --support-email support@moonhug.example`
- `./phis site config nginx --key moonhug`
- `./phis site config nginx --key moonhug --source`
- `./phis site config systemd --key moonhug`
- `./phis operator list`
- `./phis operator add --email root@example.com --password 'replace-me' --name 'Primary Operator'`
- `./phis operator passwd --email root@example.com --password 'replace-me-again'`
- `./phis media check [--fix]`
- `./phis maintain [--list] [--task upload-sessions] [--dry-run]`
- `./phis storage list --site moonhug`
- `./phis storage add --site moonhug --key s3 --provider @phis/storage-s3/s3 --config @s3.json --secret-name secret-access-key`
- `./phis storage cors`
- `./phis storage probe --site moonhug [--key s3]`
- `./phis addon list`
- `./phis addon check`
- `./phis addon install --artifact ./dist/addon.mjs`
- `./phis addon enable --addon @phis/github`
- `./phis addon reconcile --release 2026-07-28.1`
- `./phis addon storage --addon @phis/marketplace --site moonhug --quota-bytes 52428800 --max-objects 500`
- `./phis addon storage --addon @phis/marketplace --site moonhug --recount`
- `./phis addon storage --addon @phis/marketplace --site moonhug --sweep`
- `/usr/local/bin/phis --root /srv/phis/stages/prod site config runtime --key moonhug --json`

The CLI currently writes platform operators into `config/phis-runtime.json`.
Site creation requires an explicit source locale. The CLI stores it as the immutable
`sites.overrides.<siteKey>.sourceLocale` value in `config/phis-runtime.json`; the versioned
`translation.sourceLocale` value is only the installation fallback. There is deliberately no command
for changing a Site source locale after creation.
`maintain` is where cleanup that nobody is waiting for lives, and the only place it lives. Cleanup a
request needs the result of belongs to that request -- an expired upload reservation is released when
the same Media Space is next reserved against, and a reader discounts one the writer has not reached
yet. What `maintain` does is repair a figure for a Space nobody has uploaded into since, and collect
files an Add-on no longer links to. `--list` names the tasks, `--dry-run` reports without changing
anything, and running it twice is running it once. Adding a task is adding an entry to
`src/cli/maintain.mts`; nothing else changes.

`storage probe` establishes what a configured endpoint can actually do, by doing it: whether the bucket
takes a write, which declared digests it checks against the bytes it stores, and whether it will compute
one of them over a whole object assembled from parts. From that answer one algorithm is chosen and
recorded on the Profile, because duplicate detection compares digests and two are only comparable under
the same one. One adapter
serves AWS, MinIO and Garage alike and they do not agree on everything, so this is measured per Profile
rather than assumed per Provider, and the answer is recorded with the moment it was true.

Adding a Profile and changing one probe it themselves, and report the finding beside the change: a wrong
endpoint or a missing permission is then an answer the operator reads while still at the terminal,
instead of somebody else's failed upload later. `storage set` replaces the recorded answer rather than
keeping it, because the old one describes the endpoint the old configuration reached. Running the
command by hand stays what re-measures a Profile whose endpoint changed underneath it -- credentials
rotated, a bucket policy edited -- since nothing about that reaches the Server.

A Profile that reaches an upload with nothing recorded is probed once, there and then, by the request
that needs the answer. That covers what no command can: a Profile restored from a dump, written by a
migration, or configured before the probe existed. The result is recorded however it came out, and a
failure is not retried per request -- an endpoint that is down would otherwise be dialled again on every
upload into it, so what such a Profile carries is a finding saying so, and `storage probe` is how it is
tried again.

`addon storage` bounds the key space `storage:v1` hands an Add-on on one Site and reports what it holds.
`--recount` sets the counters to what the store actually holds -- they are a running total and can drift,
and a ceiling reached by drift refuses writes against space that is free. `--sweep` collects the Add-on's
declared **assets** that nothing points at any more, together with upload reservations that ran out; the
files there are Media Assets in the Add-on's own Space, so finding the orphans is a join rather than a
listing. An Add-on's declared assets are bounded by that Space's own quota, not by the figures this
command sets.

The generated `nginx` site config includes `client_max_body_size 2g;` by default so media uploads can handle large video files without allowing unlimited request bodies by accident.

Server Add-on desired state is operator-owned in `config/phis-addons.json`, and the artifacts it
names live under `addons/`. `phis addon install --artifact <path>` copies one self-contained
`addon.mjs` into that root, validates its manifest, and records the entry with both digests;
`phis addon check` re-verifies the installed set. No Add-on is compiled into `phi-server`, so
installing one needs neither a rebuild nor a restart. New Add-ons are installed disabled. Enabling or
disabling updates the desired state; `phis addon reconcile --release <id>` then records the deployed
release and global state in PostgreSQL. Site Module activation never changes this file or the server
dependency graph. See [ADDON_HOWTO.md](./ADDON_HOWTO.md) for how an Add-on is built and compiled.

The fixed runtime entrypoints are:

- `/api/v1/addons/[scope]/[name]/[[...path]]`
- `/api/v1/hooks/[scope]/[name]/[[...path]]`
- `/api/v1/site/capabilities`

An empty generated manifest is valid and makes both Add-on dispatch routes return `404`.

### Dev Source Nginx Note

- When nginx proxies a site source that runs through `next dev`, the dev HMR websocket at `/_next/webpack-hmr` must keep the usual websocket headers and must override `Origin` to the upstream dev origin.
- Without that `Origin` override, the upstream Next.js dev server may answer the websocket handshake with `Unauthorized`, which shows up in the browser as an invalid websocket status line.
- The visible failure mode is misleading:
  - HMR never connects
  - client hydration becomes unreliable
  - interactive header widgets such as locale/account dropdowns can look rendered but stay dead
- `phis site config nginx --key <site> --source` emits a dedicated `location = /_next/webpack-hmr` block with the required websocket headers and `proxy_set_header Origin http://<upstream-host>:<upstream-port>;`.
- The normal `phis site config nginx --key <site>` output stays on the runtime instance target and does not inject the dev-source HMR block.

For an emitted operator build:

- `pnpm build:cli`
- `node dist/cli/phis.mjs config validate`
- `node dist/cli/phis.mjs --root /srv/phis/stages/prod config validate`

## Notes

Open API endpoints by your frontend routing layer (not this docs repo's direct UI pages).

This project uses Next.js in API/backend mode; shared UI scaffolding in this README is intentionally minimal.

## Cross-Origin Notes

- `phi-systems.tech` to `api.phi-systems.tech` is already cross-origin.
- `phisys.com` or `moonhug.ch` to `api.phi-systems.tech` is additionally cross-site.
- CORS is still required for browser requests, but the underlying session state and CSRF validation are owned by `phis`, not by Medusa.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
