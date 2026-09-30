# phis (phi server) roadmap

This file lists open directions: where the server is meant to go, without the detail an approved work item
carries. Approved work is tracked in [TODOS.md](./TODOS.md), and designs that are worked out but not built
live in [design/](./design/README.md). Nothing here describes current behaviour.

## Principles that shape the directions

- `phis` is the control plane and API for every Site of an installation. Sites are separate Next.js
  applications, scaffolded by `phis init`, built and deployed on their own.
- Explicit contract changes over compatibility shims. Before v1, ABI breaks are acceptable when they keep
  the model coherent, and stored data is swept rather than carried by fallbacks.
- Privileged host work -- `nginx`, `systemd`, unpacking releases -- stays outside the web process.
- The database selects among installed artifacts and never becomes a code loader.

## Add-on platform

- **Activation waits for the fleet.** Every instance reports its release, Add-on manifest digest, and
  packages in `phis.server_instances`, and `phis instance list` shows when the fleet disagrees, but nothing
  waits for agreement. An Add-on must not be reported active until every serving instance holds its
  artifact; this gap has to close before Add-ons are installed into a multi-instance deployment.
- **Add-on desired state in the database**, so hosts can pull it and an operator surface can read it
  ([ADDONS_PLANNED.md](./design/ADDONS_PLANNED.md) section 4).
- **Delegated installation** by a Site administrator, bounded by approved sources and signatures
  ([ADDONS_PLANNED.md](./design/ADDONS_PLANNED.md) section 5).
- **Capabilities supplied by Add-ons** and consumed by other Add-ons
  ([ADDONS_PLANNED.md](./design/ADDONS_PLANNED.md) section 1).
- **Sidecar Add-ons** for native binaries or a runtime of their own, when the first real case arrives
  ([ADDONS_PLANNED.md](./design/ADDONS_PLANNED.md) section 3).
- **Site administration of installed Add-ons.** Enabling an Add-on for a Site and setting its non-secret
  configuration exist only as `phis addon site` and `phis addon config`; a Site-admin API over the same
  operations is open.
- **Handler timeouts do not cancel work.** A handler past its `timeoutMs` is answered with 504 and its
  `AbortSignal` fires, but a handler that ignores the signal keeps running and may commit side effects after
  the caller was told the request failed.
- **Resident code.** Node cannot unload an ES module, so an upgrade leaves the superseded version in
  memory until a restart, and timers, listeners, and pools an Add-on started survive disable and upgrade. A
  lifecycle hook for resident resources, or a periodic rolling restart, is the direction.
- **Install root isolation.** Guarantee that no ancestor of the install root contains `node_modules`, so a
  bare import in an artifact cannot resolve to the server's own packages.
- **Core capabilities follow real Add-ons.** `resource-links:v1` was built because the GitHub binding
  needs it, and `threads:v1` was recut around the same case; `images:v1` does not exist, and since native
  dependencies are excluded from artifacts, an Add-on that needs image processing is impossible today. Build each when an Add-on needs it, never as a speculative catalogue. A job runs
  without an actor, so any capability offered to jobs needs a narrower surface of its own.
- **Validate both halves end to end** with the `@phis/github` reference binding of SERVER_ADDONS.md
  section 20.

## Distribution

- **Sources, lists, packages, and provenance** as designed in
  [DISTRIBUTION.md](./design/DISTRIBUTION.md). `@phis/marketplace` serves a listing in that format;
  acquisition from a source by `phis-cli` does not exist.
- **Whether `@phis/server` itself is distributed through the same list**, which would give the server one
  answer to version, compatibility, and update questions instead of two.

## Multi-host operation

- **Three roles, three rights.** Local privileged work belongs to `phis-host` on each host; distributing a
  release to every host needs reach across hosts, which a package installed everywhere must not have; and
  round-robin is the reverse proxy's job, fed an upstream list that `phis` generates and `phis-host` applies.
- **Pull, not push.** Each host reads which release it should run, fetches it, and reports ready; no host
  holds credentials to another. A new host needs the root encryption key and a database connection and
  reads everything else, including secrets from `phis.server_secrets`.
- **Shared object storage is a precondition.** An Asset on one host's local disk does not exist for the
  others, so more than one instance requires the S3 Storage Add-on or a deliberately shared filesystem.
- **`phis-host`** as the host integration package -- `nginx`, `systemd`, and Docker templates, privileged
  helpers, stage-aware roots, and a clear request to rerun with `sudo` -- is not part of this repository
  yet; the Debian package only recommends it.
- **Rate limits need a shared store.** Every limit -- per address, per credential subject, per relayed
  visitor, per contact sender -- counts in the memory of one `phis` process (`src/lib/rate-limit.ts`). A
  second process or host multiplies each allowance by the number of processes, and a restart forgets it.
  More than one instance needs the buckets somewhere all of them see, such as the database or a shared
  cache, with the same keys the in-memory limiter uses today.

## Logging

- Put `siteKey` into native journald fields so `/admin/logs` can filter by Site before parsing JSON, and
  keep structured log events as the source of payload detail.
- Emit a parsable Site identifier at the transport layer for upload, finalize, and Media route failures.
- Add a reusable ingest transport once `@phis/server` and a Site app no longer share a host, instead of
  relying on shared filesystem or journal access.

## Error contracts

- Audit `throw new Error(...)` paths in shared helpers and storage code so route handlers emit structured
  log events rather than surfacing raw runtime errors.
- Prefer explicit result contracts over exceptions for route-adjacent helpers where the failure is a normal
  operational case rather than a programmer invariant.

## Media upload transport

- Local Storage uploads stream through the Site's Next proxy, bounded by the proxy body limit. For large
  bodies the direction is a same-origin upload front door outside Next, such as `nginx` or a dedicated
  upload service, with the upload-session contract of `@phis/server` staying the coordination point.
  Providers that store remotely already avoid the proxy through presigned uploads.

## Form submit transports

- A form handler declares `transport: "relay" | "api" | "serverAction"`, but only `relay` is carried
  out: the Site's form route forwards the values to the handler's upstream path on `@phis/server`, and
  it refuses a handler that declares another transport rather than relaying it anyway. `api` (the
  browser calls the upstream directly, with the Site's session and CSRF pair) and `serverAction` (a
  Next Server Action owned by the Module) are reserved in the vocabulary. Either needs its own
  dispatcher, a statement of what the relay's checks become there -- active Module, Area, credential
  policy, CSRF -- and a first handler that actually needs it before it is built.
