# Bootstrap Contract

## Purpose

`phis` owns the bootstrap and reconcile flow for PHIS-powered site repositories.

The goal is to keep consuming site repositories thin:

- route registration stays in the site repo
- CMS, runtime, proxy, and shared shell logic stay in `@phis/ui`
- repeated manual scaffold copying should not be required
- broken or stale sites can be repaired from the control plane

## Scope

This contract covers the files and runtime wiring a site needs to start as a PHIS frontend.

It should not introduce site-specific CMS logic, branding, or content.

It should not create a second competing routing model.

## CLI Contract

The control-plane CLI should support at least:

- `phis init <siteKey>`
- `phis reconcile <siteKey>`

Semantics:

- `init`
  - creates a fresh site scaffold
  - may create or update the DB/site runtime state as part of the first install
  - must be strict
  - if the site already exists, it should fail with a clear error that tells the operator to use `phis reconcile`
- `reconcile`
  - repairs an existing site scaffold
  - adds missing files
  - refreshes wrappers and defaults
  - fixes broken or stale scaffold state without reintroducing the site from scratch

Optional later convenience command:

- `bootstrap`
  - may inspect the current state and dispatch to `init` or `reconcile`
  - is a convenience wrapper, not the primary contract

## Generated Files

A bootstrap generator should materialize the following site files:

- `src/app/layout.tsx`
- `src/app/page.tsx`
- `src/app/[root]/layout.tsx`
- `src/app/[root]/[[...path]]/page.tsx`
- `src/app/[root]/not-found.tsx`
- `src/proxy.ts`
- `src/app/api/auth/[[...path]]/route.ts`
- `src/app/api/site/[[...path]]/route.ts`
- `src/app/api/shop/[[...path]]/route.ts`
- `src/app/media/[...asset]/route.ts`
- `src/app/api/site/forms/route.ts` when site form forwarding is needed
- `src/app/globals.css`
- `config/site-runtime.json`
- `config/site-runtime.example.json`

The generated `/api/auth/[[...path]]` route is the thin same-origin browser facade from
`AUTHENTICATION.md`; it forwards only the approved Auth surface to `phi-server` `/api/v1/auth/*` and does
not contain Site-owned credential or identity logic.

## Site-Owned Route Shape

The generated site routes should stay thin and delegate into shared helpers:

- `src/app/layout.tsx`
  - document shell only
  - `<html>`, `<body>`, fonts, providers, theme wiring
- `src/app/page.tsx`
  - locale redirect only
- `src/app/[root]/layout.tsx`
  - thin wrapper around `PhiCmsRootLayout`
- `src/app/[root]/[[...path]]/page.tsx`
  - thin wrapper around `PhiCmsRootPage`
- `src/app/[root]/not-found.tsx`
  - area-aware 404
- `src/proxy.ts`
  - locale and area request routing
- `src/app/api/*/route.ts`
  - thin proxy or bridge wrappers only
- `src/app/media/[...asset]/route.ts`
  - thin media delivery wrapper around shared media resolution helpers

## Thin Wrapper Contract

All generated site entrypoints should remain thin wrappers around shared logic.

Rules:

- route files may import helper functions from `@phis/ui`
- route files may adapt request and response objects, but should not implement business logic
- route files should not duplicate CMS, media, proxy, or locale resolution logic
- changing shared behavior should normally only require updating `@phis/ui` and rebuilding the site

The intended pattern is:

- `src/app/[root]/[[...path]]/page.tsx`
  - thin wrapper around shared CMS page rendering
- `src/app/media/[...asset]/route.ts`
  - thin wrapper around shared media resolution and delivery helpers
- `src/app/api/*/route.ts`
  - thin wrapper around shared bridge or upstream helpers

This keeps site repositories small and makes shared updates centrally maintainable. The site still needs a rebuild after shared package changes, but it does not need local logic rewrites for each contract update.

## Module and Group Boundary

The canonical scaffold contains only the permanent thin Site runtime and its required Core packages.
Optional feature packages are installed explicitly through `phis-cli`; they are not copied into generated
routes or silently added by `init` or `reconcile`.

In particular:

- Core exposes the permanent provider-neutral `@phis/server/groups:v1` capability independently of
  Site scaffold generation;
- `@phis/groups` is an optional Site Module installed only by an explicit Module operation;
- installing a Module updates package metadata and generated external build state, not canonical wrapper
  source;
- `reconcile` repairs CLI-owned scaffold files while preserving installed Modules and their generated
  build state; and
- a release artifact records the exact resolved Module package set and bound Add-on capability
  requirements used for its build, so every Instance deploys the same graph.

## Runtime Inputs

A bootstrap generator should read the site and platform truth from `phis`/DB first.

Relevant values include:

- `site.key`
- `site.publicUrl`
- `site.defaultLocale`
- `site.availableLocales`
- `phis.apiBaseUrl`
- `phis.internalToken`

Optional inputs:

- `site.name`
- `site.shortName`
- `network.internalApiTimeoutMs`

## Runtime Files

The bootstrap should create a local site runtime file with only deployment-local values.

Typical values include:

- `site.key`
- `site.publicUrl`
- `phis.apiBaseUrl`
- `phis.internalToken`
- `network.internalApiTimeoutMs`

## Reconcile Contract

Bootstrap must not be a one-time initializer only.

`phis reconcile` should be able to:

- add new required files
- update route wrappers
- refresh thin bridge contracts
- materialize new defaults
- repair missing or corrupted scaffold files

This is necessary so existing sites can pick up new shared scaffold requirements without manual rewriting.

`phis reconcile` is the canonical repair path for any site that already exists.

`phis init` must not silently morph into a repair command.

## Responsibility Split

- `phi-server`
  - canonical backend storage, CMS, site registry, and media serving
  - owns the bootstrap and reconcile CLI contract
- `@phis/ui`
  - shared shell, CMS bridge, runtime helpers, proxy helpers, and shared UI/runtime contracts
- site repository
  - thin Next.js entrypoints plus local runtime file

## Non-Goals

The bootstrap contract should not:

- duplicate CMS rendering logic in the site repo
- copy site-specific page trees from production
- hardcode media or commerce upstreams per site
- add local workarounds that bypass shared helpers
- invent a second routing model parallel to the shared root/page contract

## Outcome

After bootstrap, a site repository should be able to run as a PHIS frontend with:

- the shared CMS root contract
- the shared proxy contract
- the shared runtime contract
- minimal local route glue only
