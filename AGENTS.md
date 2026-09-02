# Repository Guidelines

## Project Structure & Module Organization
- `src/app/` holds the Next.js App Router entry points (`layout.tsx`, `page.tsx`) and global styles (`globals.css`).
- CSS Modules live alongside components, e.g. `src/app/page.module.css`.
- Static assets are in `public/` and are served at the site root.
- Repository config is centralized in `next.config.ts`, `tsconfig.json`, and `eslint.config.mjs`.

## Build, Test, and Development Commands
- Use `pnpm` for local commands in this workspace.
- Use low-output verification.
  - Capture one Git baseline at the start of a coherent work block.
  - During implementation, inspect only affected files and targeted hunks. Do not repeatedly print full diffs, repository documentation, successful check output, or unchanged status.
  - Before a commit, run `git diff --check`, inspect the changed-file list and only risk-relevant hunks, then run the required checks once unless an earlier check is needed to unblock implementation.
  - Report successful checks concisely. Show detailed output only for failures or when the operator explicitly requests it.
  - Re-read repository guidance after a new session, repository switch, major context compaction, or relevant contract change; do not repeatedly re-read it during one uninterrupted work block.
- Do not commit without explicit operator authorization.
  - A task-local instruction to implement, verify, and commit authorizes only the logically scoped commit for that task.
  - Commit only after the agreed checks pass and no required manual or browser verification remains unresolved.
  - If a required functional check cannot be performed, report the pending check instead of committing the change as complete.
- Until the packages are split into standalone repositories, the workspace root `pnpm-lock.yaml` is the authoritative lockfile. Do not add or maintain `package-lock.json` in this repository.
- `pnpm dev` starts the local dev server; in the shared dev stack it is expected to run on port `3101`.
- `pnpm build` creates the production build via Next.js.
- `pnpm start` serves the built app (run after `pnpm build`).
- `pnpm lint` runs ESLint with the Next.js core-web-vitals and TypeScript configs.
- `pnpm exec tsc --noEmit` runs the TypeScript check without a production build.
- When the app already runs in dev mode, prefer `pnpm exec tsc --noEmit` plus `pnpm lint` as the default verification path.
- Run `pnpm build` only when production behavior, bundling, routing, or SSR output must be verified explicitly.

## Project Intent

- Initial version without backward compatibility: no Payload/CMS or legacy stack inside this backend.
- The only runtime path is direct API endpoints for frontend repositories.
- No workarounds without prior operator approval.
- Never create, change, extend, replace, or reinterpret a documented or typed contract without explicit
  prior operator approval. If a requested implementation cannot be expressed by an existing contract,
  stop and ask before adding fields, enum values, fallback paths, local conventions, or parallel behavior.
- In v1, prefer explicit contract changes over compatibility shims: do not add legacy or fallback code paths unless the operator explicitly asks for them. ABI breaks are acceptable when they keep the contract coherent.
- Always determine and state the actual cause first; if needed, read official documentation or release and migration notes before changing a contract.
- Documentation must be written in English.

## Migration contract

- Runtime database execution and inline SQL belong exclusively under `src/db/`. CLI commands, route
  handlers, setup actions, components, and general-purpose libraries must call typed database-library
  functions instead of issuing queries directly. Versioned schema DDL remains in `scripts/sql/` and may
  only be loaded and executed through a `src/db/` function.
- PostgreSQL business data for this service lives in schema `phis`.
- `phis.sites` owns the complete site configuration: `hostname`, `default_locale`, `flags`, `public_base_url`, `mail_from`, `mail_from_name`, `support_email`, `contact_recipient`, `medusa_base_url`, `medusa_publishable_key`, `customer_number_prefix`, and `form_guard_secret`.
- The former `site_config` table is retired and must not be reintroduced in code or documentation.
- Global account existence resolves against `phis.user_accounts`; durable emails, credentials, external
  identities, and Site membership follow the normalized target contract in `AUTHENTICATION.md` and must
  not be collapsed back into the global user row.
- `registration_intents` is workflow history only; after `consumed`, personal snapshot fields may be minimized to `NULL` while `user_id` remains as the durable link.
- Default customer numbers are derived per Site from `sites.customer_number_prefix` and
  `user_accounts.id`; any explicit override is Site-scoped in `user_site_external_accounts`, never stored on the
  global user row.
- CMS Layout, Widget, Overlay, and resolved Navigation item instances use exactly one canonical 96-bit `PhiCmsInstanceId`, serialized as 16 Base64URL characters and preserved unchanged through Draft, review, preview, and publish. Codec v1 contains a version/origin byte plus the closed domain `area`, `page`, or `navigation`; the remaining bytes contain either a 48-bit owning Draft revision plus 32-bit sequence or an 80-bit preset hash. Layout type keys are exactly `<plugin-key>/<layout-type>`; visual treatment is ordinary Layout config and must not introduce another node kind or type-key suffix. Structural references and `cms:<instanceId>[:<subcontrolKey>]` signal receivers use the same id. Region padding is stored flat as `padding`, `paddingTop`, `paddingRight`, `paddingBottom`, and `paddingLeft` in Region config. Preset ids derive deterministically from `(contractVersion, domain, ownerModuleId, presetKey, nodeKey)` without preset version, Site, concrete Area key, route, or path input. Each Area, Page, or Navigation Working Draft owns its monotonic sequence. Publish validates identities/references and activates the revision atomically; it never allocates or remaps identities. Numeric node-id sequences/materializers, UUIDs, aliases, fallback readers, the pre-domain v1 layout, and parallel identity fields are forbidden.

## Maintenance contract

- Cleanup belongs to the request that needs its result. State that only harms its own scope is repaired
  by the next request that touches that scope, inside the transaction already open there: an expired
  upload reservation is released when the same Media Space is next reserved against, and an index row a
  discarded Working Draft left behind is disregarded by the reader that would otherwise act on it. No
  background timer, no in-process scheduler, no lock election between Instances.
- A reader repairs nothing and trusts no counter it can derive. Where a stale row would inflate a
  reported number, the read discounts it in its own query and leaves the write to the writer. Reader and
  writer use the same predicate, so what is reported free is what the next request will actually grant.
- What no request can reach is not maintenance. A staging object left behind by an abandoned upload is a
  bucket lifecycle rule for S3 and a deliberate operator command for Local; neither may be simulated
  with an in-process timer.
- Explicit maintenance operations remain a legitimate category and this contract does not close the door
  on them: rebuilding a search index, verifying links, reporting drift, or repairing an installation
  after an upgrade are operator-invoked, bounded, reporting operations, and `phis` is their home. What is
  forbidden is using such an operation -- or a scheduler -- as a substitute for state that could have
  been correct at the moment it was written or read.
- Those operations live in one registry, `src/cli/maintain.mts`, reached by `phis maintain`. A task there
  states its id and a summary, answers `--dry-run` without changing anything, and is safe to run twice
  and from two Instances at once. Adding one is adding an entry; a cleanup that does not fit those rules
  does not belong in the registry, and almost always belongs to the request that needs its result.

## API Routing Contract

- `/api/shop/*` is the only standardized commerce path forwarded to Medusa (`/store/*` in the proxy layer).
- Core Site authentication is served by `phis` under `/api/v1/auth/*`; Site runtimes expose its approved
  browser facade under same-origin `/api/auth/*`.
- Other backend endpoints in `phis` are not forwarded to Medusa and are served from `/api/v1/*`.
- Frontends should consume those endpoints through their local same-origin `/api/v1/*` route handlers so browser traffic remains same-origin.
- Browser-side calls should prefer site-local `api` routes to avoid cross-site complications.
- Server extension work must follow the normative `SERVER_ADDONS.md` contract.
- Site viewer roles, provider claims, Core Admin override, persistence, and API enforcement must follow
  the normative target v1 contract in `AUTHORIZATION.md`.
- Global users, Site authentication methods, identity linking, sessions, Auth Module replacement, and CLI
  recovery must follow the normative target v1 contract in `AUTHENTICATION.md`.
- Canonical translation sources, protected external variants, context flags, provider batching, and
  structured-document translation must follow the normative target v1 contract in `TRANSLATIONS.md`.
- Mutable Site Page paths, stable Page/Asset references, navigation targets, reference indexing, and
  internal/external Markdown/HTML trust boundaries must follow the normative target v1 contract in
  `REFERENCES.md`.
- General Site groups, Media Spaces, folders, quotas, Storage Profiles, Storage Provider Add-ons, and
  protected Asset delivery must follow the normative target v1 contract in `GROUPS_AND_STORAGE.md`.
- Provider-neutral Site user/group administration, stable Directory bindings, membership provenance,
  scoped synchronization, and future LDAP/SCIM/Entra Add-ons must follow the normative target v1
  contract in `DIRECTORY_PROVIDERS.md`.
- Site/client extensions are Modules; server extensions are Add-ons. Every Module binds to exactly one
  Add-on or to Core.
- One package carries one product, named for the product and not for the half. The Add-on half is
  reached through `@scope/name/addon/manifest` and `@scope/name/addon/runtime`.
- Only `phis-cli` may install, migrate, build, remove, or globally activate Add-on code. HTTP requests,
  database rows, and Module activation must never become dynamic server package imports.

## Internal Endpoint Hardening

- Server-side calls from `dev.phisys.com` and `phi-systems.tech` to `phis` internal endpoints require an internal auth token (`Authorization` header).
- Initial implementation uses static shared secrets:
  - public APIs use the configured public API token
  - internal APIs use the configured internal API token
  - values are loaded from server runtime config and never exposed to browser code.
- No env aliases or fallback token variables are allowed. Secret/internal token configuration belongs in `config/phis-runtime.json`; the public API token is optional and should only be set deliberately per deployment.
- Any token name or guard-path change requires prior approval.
- Optional stronger control can be added with a short-lived grant token (TTL about 30s) stored in shared Redis:
  - Frontend server receives/stores grant token for the registration intent.
  - `phis` validates the token and consumes it immediately before allowing email delivery.
  - This must only be used when both services share the same Redis plane or equivalent central cache.
- Any shared-token flow must remain server-only and never be exposed to browser-side code.

## Coding Style & Naming Conventions
- Use TypeScript/TSX for React code; keep the existing 2-space indentation.
- App Router files should follow Next.js naming (`page.tsx`, `layout.tsx`, `route.ts` when added).
- CSS Modules use `*.module.css`; global styles stay in `src/app/globals.css`.
- Import alias `@/*` maps to `src/*` (see `tsconfig.json`).
- Use the golden ratio (1.6...) for Phi spacing and layout proportions (spacing, sizing, drawers, header heights, etc.).

## Testing Guidelines
- No test framework or test script is configured yet.
- If you add tests, include a run command in `package.json` and document the locations and naming pattern (for example `src/__tests__/`).

## Commit & Pull Request Guidelines
- Git history currently contains only “Initial commit from Create Next App,” so no established convention exists yet.
- Prefer short, imperative commit messages (e.g., “Add dashboard layout”).
- Pull requests should include a clear description, local run steps, and screenshots for UI changes.
- For larger changes, align with the operator first, for example on topology, deployment, DNS, or API/database changes, then implement.

## Configuration Tips
- Update ESLint rules in `eslint.config.mjs` and Next.js behavior in `next.config.ts` as needed.
- Keep dependency changes scoped and explain why they are required.
- Runtime constants, enums, and flag definitions belong in `src/lib/constants/*`, pure helper functions in `src/lib/helpers/*`, and type-only declarations in dedicated type files. Do not depend on `phi-shared-ui` from `phis`; counterpart constants/helpers must be defined locally when needed.

## Frontend styling coordination

- Frontend repositories are responsible for AntD token strategy and theme defaults.
- Keep `ConfigProvider` token configuration centralized in each frontend root layout.
- Keep `phis` UI intentionally lightweight; avoid pulling frontend-site AntD coupling into this repository unless explicitly required.
