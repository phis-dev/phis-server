# Audit findings

Audit of `phi-server` `src/` on 2026-08-17 at commit `77e96e5` (plus the same-day Media work).
Method: full export/usage scan across `.ts`/`.tsx` (tests separated), loop/await sweep, index
coverage against `scripts/sql/001_create_phis.pgsql`, connection-lifecycle scan, and targeted reads of
the flagged sites. Every finding below was verified at the stated location; this file records state,
it does not change behavior. Remove entries as they are fixed.

## 1. Correctness and contract gaps

### 1.1 Quota reservations leak on every non-success upload path — FIXED 2026-08-17

Fixed in the same audit session: `abortMediaUploadSessionByToken` deletes the session row and releases
its reservation in one idempotent statement, and every non-success path in the PUT and finalize routes
uses it. The init route releases directly on its two failure paths, where no session row exists yet.
Verified live: a declared-100-byte init raised `reserved_bytes` by 100 and a size-mismatch abort
returned it to the previous value. An active sweep for sessions that expire without any further request
remains open (see TODOS.md).

### 1.2 Reservation accounting drifts when actual size differs from declared size — FIXED 2026-08-17

Finalize now commits the declared `session.sizeBytes` — the exact amount that was reserved — instead of
the re-measured object size. The PUT step already enforces equality of stored and declared size, so the
values are identical today; committing the declared amount makes the invariant explicit for transports
that no longer re-buffer the body. Verified live: a successful 11-byte upload moved `used_bytes` by
exactly 11 with `reserved_bytes` returning to its prior value, and asset deletion returned `used_bytes`
to the starting value.

### 1.3 Widget-owned `site_content` is never deleted — FIXED 2026-08-17

`deleteOrphanedSiteContentByIdsWithDb` deletes candidate content rows only when no page or area
revision of the Site still references the id in its `contentWidgets` array, so anything a historical
revision could restore survives. Candidates come from the points where references actually disappear:
the removal diff of page and area draft saves, draft resets, and single/bulk revision deletion (via
`DELETE … RETURNING tree_json`). Each call runs inside the caller's transaction, and the Content-source
rows of the reference index are retired with the deleted ids. Note the earlier claim here was imprecise:
the reference index tracks what content references, not who references content — the safe count is the
structured `contentWidgets` scan above. Verified against the live schema in a rolled-back transaction:
a referenced candidate is protected, the same candidate becomes deletable once its last referencing
revision is gone. The pre-existing pool-level `deleteSiteContentBySiteAndId` remains uncalled and is
still listed under 3.2.

### 1.4 Media routes inherit the host-based Site fallback — FIXED 2026-08-17

The host/origin/referer fallback is removed from `resolveSiteFromHeaders` entirely: the explicit
`x-phis-site-key` header is the only Site identity, per the roadmap's cleanup item. Every active caller
— the shared-ui gateways, the Skeleton proxies, and direct SSR calls — already sends the key, and
`/api/v1/tr` handles a Site-less request gracefully. `getSiteByHostname` and its cache lost their last
caller and were removed with the fallback. Verified live: a request carrying only `Host` or
`x-forwarded-host` for a real Site hostname no longer resolves (404), the explicit key still does, and
the public Skeleton render is unaffected. Legacy frontends that never adopted the mandatory header
would now fail closed; their own READMEs have required the header on direct backend calls throughout.

## 2. Performance

### 2.1 Write-on-read in the ensure helpers — FIXED 2026-08-17

The three Media helpers (`ensureSiteMediaSpace`, `ensureSiteMediaConfig`, `ensureUserMediaSpace`) now
select first and only fall into their transactional create/backfill path on a miss or while the Local
profile's config is still unseeded; the config materialization uses `ON CONFLICT DO NOTHING` plus a
re-select so a race stays safe. Verified live: three list plus three folder requests left the
`updated_at` of both rows untouched, where the upsert previously bumped them on every read. Correction
to the original entry: the two scope ensures in `site-pages.ts` sit on draft-save write paths, not on
read paths — they were misattributed here and are fine as they are.

### 2.2 Duplicate resolution work in the Media listing — FIXED 2026-08-17

`resolveAuthorizedMediaSpace` authorizes a requested Space directly — owner match for a User Space,
effective membership for a Group Space — instead of materializing the full authorized list, and
`listSelectableMediaSpaces` accepts the already-resolved config from the resolution result. The listing
now resolves the config once and runs one Space-list query per request.

### 2.3 Row-by-row inserts inside transactions — FIXED 2026-08-17 (two of three)

`replaceSiteCmsReferencesWithDb` and the two Support recipient loops now insert through one
`INSERT … SELECT unnest(...)` each; the reference batch shape — including NULL-bearing arrays for all
three target kinds — was verified against the live schema in a rolled-back transaction. The recovery
code loop in `user-auth-factors.ts` is left as is deliberately: it writes a fixed ten rows on the rare
TOTP enrollment path, where batching buys nothing worth touching a security flow for.

### 2.4 Sequential external calls — RESOLVED 2026-08-17 (with a correction)

The original diagnosis was wrong: the loop was not the limiter. DeepL requests pass through a
deliberate process-wide slot semaphore, `DEEPL_MAX_CONCURRENT_REQUESTS = 1`, paired with a circuit
breaker on 429/5xx — a rate-limit policy, not an accident. The batch loop now fires concurrently and
lets the semaphore bound it, so the constant is the single knob for provider concurrency; at the
current limit of 1 behavior is exactly as before. Raising the constant is an operator decision about
the DeepL account's rate tier, because a 429 opens the circuit for 30 s and pauses all translation.
The `external-document.ts` loop is a redirect chain and is correctly sequential.

## 3. Dead code — REMOVED 2026-08-17 (with corrections)

Sections 3.1 and 3.2 are implemented: the dead files and exports below were deleted, orphaned imports
and local helpers cleaned, and the operator pages, public render, media variants, and the translation
endpoint verified live afterwards. Four corrections against the original lists:

- `renderSiteConfig`, `assertPhisAddonManifest`, and `validatePhisAddonDesiredState` are used
  by the CLI (`src/cli/*.mts`), which the scan had not covered — they stay.
- `resolveOperationalMode`, `readOperatorInfrastructureSnapshot`, and `trGlobalLabelSet` are used by the
  operator pages and stay; the compiler caught the attempted removal.
- `src/lib/cors.ts` is reclassified: it is the only implementation of the documented configured
  allow-origin policy and is recorded under 5. as unwired contract, not deleted.
- `buildFallbackVariantSvg` was removed as dead, but it was the unwired implementation of a documented
  behavior — recorded under 5.

### 3.1 Landing/marketing leftovers in an API-only repository — REMOVED

`src/content/` (news, teasers, landing/section JSON), `src/theme/phiTokens.ts`, and the
`trGlobal`/`trGlobalForLocale`/`trForLocale` family in `src/lib/landing-tr.ts` are gone;
`trGlobalLabelSet` and the site-scoped `tr` remain in use by the operator UI.

### 3.2 Unused DB/lib functions — REMOVED (list as verified, minus the corrections above)

- `src/db/media.ts`: `deleteMediaAsset`, `getMediaFolderById`, `listImageAssetVariantsByAssetId`,
  `listMediaAssetsBySite`, `resolveMediaFolderPathId`
- `src/db/site-content.ts`: `deleteSiteContentBySiteAndId` (see 1.3), the four pool-level
  `upsertSiteContent*` wrappers (`…WithClient` variants are the used path),
  `listSiteContentAssetReferencesByAssetId`
- `src/db/site-pages.ts`: `getSitePageByPath`, `getSiteAreaPresetByAreaMask`
- `src/db/site-cms-references.ts`: `countSiteCmsReferencesToPage`/`…ToAsset` pool wrappers
- `src/db/supported-devices.ts` and `src/lib/adapter-plugin-flags.ts`: `phi_systems` domain layer,
  **moved** on operator instruction rather than discarded — parked as non-building reference in
  that project's own repository, to be folded into its future server Add-on. `phis` stays clean of
  domain Add-on code.
- `src/db/translations.ts`: `getTranslation`, `getSiteTranslation`, `upsertSiteTranslation`
- `src/db/user-*`: `setUserAccountEnabled`, `deleteUserSiteMembership`, `setUserSiteRoleClaim`,
  `deleteUserPasswordResetTokensForSite`, plus `getSupportInboxSummary`, `getSupportTeamBySiteAndKey`
- `src/lib`: `withCors`, `createCorsOptionsResponse`, `sendVerificationEmail(+WithHtml)`,
  `canAccessPage`, `authenticateMedusaCustomer`, `getSupportedDeepLSourceLanguages`,
  `buildFallbackVariantSvg`, `isImageVariantKey`, `parseVariantRequestPath`, `phiServerLogger`,
  `renderSiteConfig`, `readOperatorInfrastructureSnapshot`, `resolveOperationalMode`,
  `assertPhisAddonManifest`, `validatePhisAddonDesiredState`, `nextJsonError`
- Guards: `requireSiteAdminApiContext`, `requireSiteEditorApiContext`,
  `requireSiteAccountingApiContext` (declared role surface, no route uses them yet)

Deliberate ABI kept for planned work and therefore **not** dead despite zero callers:
`registerPhisMediaStorageProvider` (S3 Add-on hook). `releaseMediaSpaceReservation` gained its callers
with the 1.1 fix and is no longer on this list.

### 3.3 Closed-vocabulary constants without direct references

The `SUPPORT_TICKET_*`/`SUPPORT_GITHUB_*` families (`src/db/support.ts`), `SITE_CONTENT_TYPE_PAGE/
LEGAL/SNIPPET`, `PhiCmsPageType`, `PhiCmsRegionStatus`, `PhiCmsRevisionScopeType`,
`PhiMediaFolderFlags`, and `PHIS_INSTANCE_FLAG_READY` are unreferenced values of documented closed
vocabularies. They document the contract and are accepted as data-driven values; not recommended for
removal, listed to keep the unused-export scan honest.

### 3.4 Exports used only by tests

`createPhiAssetUri`/`createPhiPageUri` (server side; the shared-ui twins are production-used),
`createPhiPresetCmsInstanceId`, `createTotpCode`, `encryptAuthTransactionPayloadWithKey`,
`hasTranslationContextFlag`.

## 4. Duplicate paths

### 4.1 Route-local helper copies — FIXED 2026-08-17

`src/lib/helpers/request.ts` now owns `normalizeString`, `readRequestBody`, `parsePositiveInt`
(null-returning), and `parsePositiveIntWithFallback`; twenty-four route files dropped their local
copies. The only remaining local variant is deliberate: the admin users route parses `QueryValue`
(string arrays) through its own normalizer. The two `parsePositiveInt` semantics were separated by
name instead of merged, so no call site changed behavior.

### 4.2 Inconsistent error envelope — TARGET DECIDED, STAGE 1 DONE 2026-08-17

Correction first: the original 350-vs-7 count was wrong — a formatting-sensitive grep. The `ok`
envelope spans roughly seventy files: the auth flows, the whole form gateway, Support, Admin, and
Operator, all predating this week and all with live consumers.

Decided target: `{ error, message?, details? }` plus the HTTP status; the `ok` flag duplicates what
`response.ok` already says. Stage 1 converged everything built this week — the Media family, Groups,
the Admin Media settings, and the Builder page-path command — on both sides in one step: fifteen
server files dropped the `ok` field from success and error responses, and the seven shared-ui gates
(`phi-image-preview-data`, `asset-collection-service`, `media-upload-flow` ×3, `image-editor`,
`builder-page-catalog-client`) now gate on `response.ok` plus payload plausibility. Verified live:
listing without `ok`, `space_kind_unavailable` as `{ error, message }` with 409, and a full
upload/finalize/delete cycle with the quota accounting returning to its starting values.

Stage 2 (2026-08-17, same day) converged the legacy families outside the form protocol: the auth
facade and v1/auth action routes, Support, Admin, editor translations, Operator auth, setup, the
customer registration profile, and translation detection — about fifty files, with the shared query
helpers' tests adjusted and the two `login-body` gates reduced to the transport status. Verified live
against the running server: login answers `complete`/`area` without `ok` and still sets the session,
Admin settings, Support threads, and editor translations return bare payloads, and the Admin error form
is `{ error, details }`. Deliberately excluded as its own protocol rather than postponed: the form
gateway and its handler routes, where `ok` is the success flag of a signal value whose consumers have
no HTTP context, and the internal result objects in `form-guard`, `write-validation`, and
`external-login`.

Found while verifying, pre-existing and unrelated to the sweep — FIXED 2026-08-17: **the widget login
broke after a cold start.** `POST /api/site/forms` answers 502 `Missing phis apiBaseUrl for
fetchResolvedSiteLocale`. The live Area read has answered 404 all day (no published Area override), so
the handler resolution always takes the code-preset fallback introduced with `f5c41a8`; that fallback
builds `buildPhiDefaultSiteAreaPresetTree`, whose labels call `trGlobal` →
`resolvePhiRequestLocale()` → the request runtime store — which is empty in a route-handler context.
A warm label cache masked this until the Skeleton process restarted mid-afternoon. Setting the store
in the fallback does not help: the store is `React.cache`-based and has no request scope outside RSC
rendering, which was confirmed empirically. Fixed by completing the store contract instead of bypassing it:
`runWithPhiRequestRuntime` scopes the request runtime store through AsyncLocalStorage for work outside
the React render, with the `React.cache` store remaining the RSC path, and the handler-resolution
fallback wraps its preset instantiation in that scope. Verified in the real browser flow: the widget
login submits 200, redirects to the resolved area, and sets the session cookie — which also closes the
stage-2 widget-level verification.

### 4.3 Two Site resolution entry points — RESOLVED 2026-08-17 (semantics unified)

Since the host-fallback removal both entry points share one resolution semantic: the explicit
`x-phis-site-key` only. What remains are two ergonomic wrappers over that one semantic —
`requireSiteFromRequest` returns `site | null` for callers that shape their own response, and
`requireSiteFromExplicitKeyRequest` returns `{ site, error }` for the eleven auth routes that want the
ready-made 400/404. That is one resolver with two return shapes, not two resolution paths; collapsing
the wrappers would only churn eleven call sites.

## 5. Smaller improvements

- `serializeMediaAssetForTile/Detail` still expose the full management record minus storage fields
  (`projectPublicMediaAsset`, `src/lib/media-response.ts:54`) including `meta`, `checksumSha256`, and
  audit ids to any Media-role viewer. Defensible for staff, but an explicit field list like the public
  reference projection would prevent silent widening.
- `resolveCmsPageScopeAddress`-style query parsing exists in both `site-cms-write-route.ts` and route
  files; the CMS read/write route helpers in `src/lib/site-cms-*.ts` carry several near-identical
  guard/param prologues that could share one context builder.
- `test/` and `src/**/*.test.ts` split: test placement is inconsistent (six files under `test/`, the
  rest co-located). Pick one convention.
- Unwired contract: CORS. README promises "explicit allow-origins instead of a wildcard" and
  `config/phis-runtime.json` carries a validated `cors.*` block, but the public v1 routes (`tr`, `news`,
  `locales`, `email/send`) hardcode `Access-Control-Allow-Origin: *` per route, and `src/lib/cors.ts` —
  the only implementation that reads the configured origins — has no caller. Either wire the configured
  policy or align the documentation; the helper is kept for that decision.
- Logging unification status (surveyed 2026-08-17). `phi-server` is effectively unified: the
  `PhiLogger` factory in `src/lib/log.ts` is the documented contract's implementation,
  `logRuntimeEvent` wraps it, 118 call sites across 51 files use it, every event name is
  dot-notation, and there is no stray `console.*` outside the emitter itself. Of 118 calls, 15 omit
  `siteKey`; most are legitimately platform-scoped (`operator.login.*`), while the two
  `translation.*` rejections in `/api/v1/tr` fire before Site resolution and could carry the key once
  resolved. `phis-ui` is the split half: `net/log.ts` is a deliberate same-shape copy of the
  server logger (the packages must not depend on each other), but only the Next proxy uses it — twelve
  other emitting sites bypass it, from `[tag]`-prefixed `console.warn` objects up to a hand-rolled
  `JSON.stringify` line in `gateway/tr.ts`. About half of those are browser Client code, where the
  one-line-JSON stdout contract does not apply and `console.warn` diagnostics are acceptable; the
  server-side half (`navigation-descriptor-resolver.server.ts`, `server-helpers/runtime.ts`,
  `server-helpers/cms-request.ts`, `next/navigation-target-route.ts`, `gateway/tr.ts`,
  `plugins/runtime-modules/resolver.ts`) should route through `net/log.ts` so journald keeps one
  parseable format. The two logger copies should be kept field-identical whenever the shape changes.
  Roadmap items (native journald fields, cross-host ingest) remain open and are tracked there.
- Unwired contract: variant fallback icon. DB.md states "Variant requests for non-image media kinds
  return a fixed SVG preview icon", but the variants route answers 404 for non-images
  (`ensureImageAssetVariant` returns null) and no client requests such URLs — `thumbnailUrl` is null
  for non-images. The dead `buildFallbackVariantSvg` implementation was removed with section 3; decide
  whether to implement the documented behavior or amend DB.md.
