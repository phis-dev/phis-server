# `phis` command reference

`phis` is the operator CLI of `@phis/server`. It edits the configuration files of one phis root,
writes to the PostgreSQL database that root names, scaffolds and builds Site repositories, and
manages server Add-ons and Site Modules. This file lists every command the dispatcher in
`src/cli/phis.mts` accepts.

For a first installation, read [INSTALL.md](./INSTALL.md) instead; it runs these commands in order.

- [Running the CLI](#running-the-cli)
- [Global flags, output and exit codes](#global-flags-output-and-exit-codes)
- [Environment variables](#environment-variables)
- [The phis root and its files](#the-phis-root-and-its-files)
- [What a command needs](#what-a-command-needs)
- [config](#config)
- [db](#db)
- [schema](#schema)
- [site](#site)
- [init, reconcile, update (Site scaffold)](#init-reconcile-update-site-scaffold)
- [module (Site Modules)](#module-site-modules)
- [addon (server Add-ons)](#addon-server-add-ons)
- [storage (Storage Profiles)](#storage-storage-profiles)
- [secret](#secret)
- [auth](#auth)
- [operator](#operator)
- [media](#media)
- [maintain](#maintain)
- [mail](#mail)
- [licenses](#licenses)
- [instance](#instance)
- [Common tasks](#common-tasks)
- [Payment profiles](#payment-profiles)

## Running the CLI

| Where | How |
| --- | --- |
| Source checkout | `pnpm phis <command>` (runs `src/cli/phis.mts` with `node --experimental-strip-types`), or `./phis <command>` |
| Bundled | `pnpm build:cli` writes `dist/phis.mjs`; `pnpm phis:dist <command>` or `./phis <command>` runs it |
| Debian package | `/usr/bin/phis`, a script that runs `/usr/lib/phis/server/phis` |

The `./phis` wrapper runs `dist/phis.mjs` when it exists and falls back to the TypeScript source.
If `PHIS_ROOT` and `PHIS_APP_ROOT` are unset, the wrapper sets both to the wrapper's own directory.
`./phis` prefers `dist/phis.mjs` even when the source is newer; run `pnpm build:cli` after changing
the CLI, or use `pnpm phis`.

In the Debian package, `/usr/bin/phis` sets `PHIS_ROOT=/srv/phis/stages/prod` when the variable is
unset, the stage the package creates and the root the server uses in production. Pass `--root` or set
`PHIS_ROOT` for another stage.

`pnpm phis` runs with the package directory as its working directory, so without `PHIS_ROOT` or
`--root` it operates on the checkout's own `config/`.

## Global flags, output and exit codes

| Flag | Meaning |
| --- | --- |
| `--json`, `-j` | Print the result as one JSON document on stdout. |
| `--root <path>`, `-r <path>` | The phis root. Default: `$PHIS_ROOT`, else the current working directory. |
| `--help`, `-h`, `help` | Print the usage text. Only recognised as the first argument; elsewhere `-h` means `--hostname`. |
| `--version`, `-v` | Print the package version (`{"version": ...}` with `--json`). Only on a line without a command; inside a command `-v` can be a flag's value. |

Flag parsing rules. Every command has a fixed list of flags (`PHIS_COMMAND_FLAGS` in
`src/cli/argv.mts`), and each flag either takes a value or is a switch:

- A flag that takes a value takes the next argument, whatever it starts with: `--password -x1` passes
  `-x1`. `--name=value` works as well, and is the clearer form for such values.
- An empty string is a value: `--value ""` and `--value=` pass `""`.
- A value flag at the end of the line fails with `--<flag> needs a value.`
- A switch (`--force`, `--json`, `--install`, ...) takes no value; `--force=yes` is refused.
- A flag the command does not read is refused: `phis <command> does not take --<flag>.` This includes
  flags that belong to another command, e.g. `--api-base-url` on `reconcile`.
- The same name can differ between commands: `site admin --revoke` is a switch, `addon role --revoke
  <role>` takes a value.
- Short aliases: `-e --email`, `-u --public-base-url`, `-h --hostname`, `-k --key`, `-l --locale`,
  `-p --password`, `-n --name`, `-d --disabled`, `-j --json`, `-r --root`. Any other single-dash flag
  is refused with `Unknown flag`.
- A line that matches no command is passed to the dispatcher, which answers `Unknown command`.

Output and exit codes:

- On success the command prints a human-readable line, or JSON with `--json`, and exits `0`.
- On failure it prints the message to stderr, plus a structured log line
  (`{"level":"error","service":"cli","event":"cli.command.failed",...}`), and exits `1`. With
  `--json` stderr also carries `{"ok": false, "error": "<message>"}`.
- Some commands finish without throwing but still exit `1` because they found a problem; each is
  noted below (`config validate`, `schema check`, `site check`, `module add|check`, `addon list|check`,
  `addon job`, `secret check`, `media check`, `maintain`, `mail drain`, `licenses check`, and
  `instance list` when the instances have not converged on one release and one Add-on set).

## Environment variables

| Variable | Read by | Effect |
| --- | --- | --- |
| `PHIS_ROOT` | CLI, server | The phis root when `--root` is not given. The server falls back to `/srv/phis/stages/prod` when `NODE_ENV=production`, otherwise to the application root. |
| `PHIS_APP_ROOT` | CLI, server | The application root, where `scripts/sql/001_create_phis.pgsql` is read from (`schema check`, `schema apply`). Default: two directories above the CLI module. The wrapper sets it; set it yourself when running `dist/phis.mjs` directly, because the bundle lives one directory below the application root. |
| `PHIS_INSTANCE_ID` | CLI, server | Identity of a server instance in `phis.server_instances`. Default: `<hostname>:<root>`. `instance drain` uses it when `--id` is not given. |
| `PHIS_SKIP_VERSION_CHECK` | CLI | Any non-empty value skips the root version check (below). |

`update` passes the environment to the package manager and adds `NEXT_TELEMETRY_DISABLED=1`.

### Root version check

Every command except `help` and `--version` compares the CLI version with
`<root>/config/phis-instance.json` (`{"formatVersion": 1, "phisVersion": "..."}`):

- no stamp, or a CLI newer than the stamp: the command runs and the stamp is rewritten to the CLI
  version (a newer CLI first prints `Note: <root> was last operated by phis <old>, this is <new>.`);
- CLI older than the stamp: the command is refused. Use the CLI that belongs to the root, or set
  `PHIS_SKIP_VERSION_CHECK=1`.

The stamp is only written when the root contains `config/phis-config.json` or
`config/phis-runtime.json`, and a failed write is ignored.

## The phis root and its files

All paths are relative to the root.

| File | Written by | Content |
| --- | --- | --- |
| `config/phis-config.json` | the operator | Static configuration: `sites.*` path roots and base port, `translation`, `media`, `email`, `forms`, `bootstrap.enabled`. |
| `config/phis-runtime.json` | the operator, `/setup`, and the CLI | Deployment values and secrets: `database.uri`, `database.migrationUri`, `api.internalToken`, `secrets.encryptionKey`, `auth.transactionEncryptionKey`, `registration.intentEncryptionKey`, `operator.sessionSecret`, `platformSuperUsers`, `sites.overrides`. Values here override `phis-config.json`. |
| `config/phis-instance.json` | the CLI | The version stamp above. |
| `config/phis-addons.json` | `addon` commands | Desired state of server Add-ons. Absent means none. |
| `config/phis-modules.json` | `module add|del` | Desired state of Site Modules per Site. Absent means none. |
| `addons/<scope>/<name>/<version>/addon.mjs` | `addon install|upgrade` | Installed Add-on artifacts. |

The CLI writes `phis-runtime.json` through a temporary file and a rename. A running server caches the
merged configuration for up to four hours; restart it after a CLI command that changes
`phis-runtime.json` (`db bootstrap`, `operator add|passwd|enable|disable|del`, `site add|del` and `site
config set|add|del` for `sites.overrides`, `secret init-key`, `auth import-secrets`), or the running
server keeps the old values for up to four hours.

## What a command needs

| Needs | Commands |
| --- | --- |
| An administrative database connection, passed in | `db bootstrap` — it creates what every row below already expects to exist |
| Configuration files only | `config`, `operator`, `secret init-key`, `module list`, `addon list|check|install|upgrade|enable|disable|remove|forget`, `site config set|add|del` (also read the Site row, so a database), `licenses check` |
| `database.uri` (serving role) | `schema check|apply`, all `site` commands except `config set|add|del`, `init|reconcile|update`, `module add|del|sync|check`, `addon reconcile|site|config|role|owner|storage|job`, `storage`, `secret set|check|list|del`, `auth`, `media check`, `maintain`, `payment profile`, `instance` |
| `database.migrationUri` (migration role) | `schema drop --force`, `addon migrate`, `addon purge` |
| `secrets.encryptionKey` | `secret set|check`, `auth import-secrets`, `storage` commands that reach a Provider credential, `addon purge` and `addon storage --sweep|--recount` on a Site with an external store, `payment profile probe|enable` and `maintain --task payments` (they reach the Provider's credential) |
| `api.internalToken` | `init` (copied into the Site), `site check` (running Site), `addon job` and `mail drain` (running server) |

There is no fallback from `database.migrationUri` to `database.uri`.

## config

### `phis config`

Prints the merged configuration (built-in defaults, then `phis-config.json`, then
`phis-runtime.json`) as JSON. The output includes database URIs, tokens and keys; do not paste it
anywhere.

### `phis config paths`

Prints the root and the absolute paths of the static and runtime configuration files
(`{root, static, runtime}` with `--json`).

### `phis config validate`

Parses both files and validates the merged configuration: types of `sites.*`, `platformSuperUsers`
(email and `passwordHash` present, no duplicates), 64-character hex keys
(`auth.transactionEncryptionKey`, `secrets.encryptionKey`), `media`, `translation` (the source
locales must be in `translation.supportedLocales`), `forms.timeouts`, and the presence of the
retired `auth.secrets` field. Exits `1` on any issue. JSON: `{ok, staticError, runtimeError, issues}`.

It does not check that required values are present; a missing `database.uri` is reported by the
first command that needs it.

## db

### `phis db bootstrap --admin-uri <postgres uri>`

Creates the database this installation is applied to, the two roles that own parts of it, and writes both
connection strings into `phis-runtime.json`. The step before `schema apply`, and the only one that needs a
connection of its own: `--admin-uri` is a connection allowed to create databases and roles, which is not
either of the roles being created.

Names are derived from `--name`, so one installation's three are recognisably related:
`--name prod` gives the database `phis_prod`, the serving role `phis_prod_user` and the migration role
`phis_prod_migrator`. Without `--name` they are `phis`, `phis_user` and `phis_migrator`. `--database`,
`--role` and `--migration-role` name any of the three outright, and are taken as typed rather than folded.
Passwords are generated unless `--password` or `--migration-password` gives one.

Two roles because ownership is split: the serving role owns the Core schema `phis`, the migration role owns
the schemas of server Add-ons, and neither can drop what the other made. `schema apply` grants the migration
role what Add-on migrations need, reading its name out of `database.migrationUri`.

Creating is idempotent and reports what it found rather than made. `--force` guards the configuration, not
the database: a role that already exists has its password set — there is no reading one back — so a second
run without `--force` is refused rather than handing a running server connection strings it is not using.

`--admin-uri` must name a host. A local socket connection (`postgresql:///postgres?host=...`) carries none,
and the connection strings written from it have to be ones the CLI can parse back.

Where the administrative connection is not a superuser — a managed database, typically — the command first
grants itself the right to assume the serving role, because `CREATE DATABASE ... OWNER` requires it and
PostgreSQL 16 separated administering a role from assuming it. A superuser is left alone.

The written file holds two passwords. The command does not change its mode or owner: run as root against a
remote database, the file belongs to root, and the server runs as another account. Set mode `0600` and the
owner the server runs as.

## schema

### `phis schema check`

Connects with `database.uri` and compares the tables `scripts/sql/001_create_phis.pgsql` declares
with the tables in schema `phis`. Prints the missing ones and exits `1` if any are missing. Also
lists extensions the script creates (`pg_trgm`) that are not installed. Read-only.

### `phis schema apply`

Runs `001_create_phis.pgsql` with `database.uri`. The script is idempotent (`CREATE ... IF NOT
EXISTS`), so it is safe to repeat and is the step to run after every server upgrade. It runs as the
serving role on purpose: Core tables belong to that role. The role needs the right to create the
schema `phis` and the `pg_trgm` extension, or a superuser creates the extension beforehand.

When `database.migrationUri` is set, it also grants the migration role what Add-on migrations need
(`USAGE` on `phis`, `REFERENCES` on the Core tables Add-ons may reference, read/write on the Add-on
catalogue tables, and a few narrower grants). Prints the created tables and the grantee.

### `phis schema drop [--force]`

Destructive. Without `--force` it prints what would be dropped and changes nothing. With `--force`
it drops every Add-on schema recorded in `phis.server_addons` (with `database.migrationUri`, which
owns them) and then `DROP SCHEMA phis CASCADE` (with `database.uri`). All Core data is lost.
The dry run needs only `database.uri`; `--force` also needs `database.migrationUri`. Run `phis schema
apply` to rebuild an empty schema.

## site

All `site` commands need the database. Site keys and host names are lowercased. A Site key must match
`[a-z0-9][a-z0-9._-]{0,63}` (after lowercasing), the rule for a segment of a secret reference, which
the key becomes part of; `site add` refuses any other key.

### `phis site list [--key <site key>]`

Lists Sites (`key`, `enabled`, `hostname`, `name`), optionally one. JSON includes every column the
CLI reads and the resolved `sourceLocale`.

### `phis site add`

```text
phis site add --key <site key> --name <site name> --hostname <hostname> --public-base-url <url>
              --source-locale <locale> --default-locale <locale> [--available-locales <csv>]
              --support-email <email>
```

Creates a Site.

| Flag | Required | Notes |
| --- | --- | --- |
| `--key`, `-k` | yes | Unique Site key. |
| `--name`, `-n` | yes | Display name; also the mail sender name. |
| `--hostname`, `-h` | yes | The host the Site answers on. |
| `--public-base-url`, `-u` | yes | Absolute URL, e.g. `https://www.example.com`. |
| `--source-locale` | yes | The locale content is authored in. Immutable once written. |
| `--default-locale` | yes | Always added to the available locales. |
| `--available-locales` | no | Comma-separated additional locales. |
| `--support-email`, `-e` | yes | `--email` is accepted as an alias. |

Every locale must be listed in `translation.supportedLocales` (default: `["en"]`).

Side effects: writes `sites.overrides.<key>.sourceLocale` to `phis-runtime.json` first, then inserts
the `phis.sites` row (mail sender `no-reply@<hostname>`, contact recipient = support email, a random
form guard secret) and an empty `phis.site_auth_config` row in one transaction. If the insert fails,
the runtime file is restored. Refuses when an override with a `sourceLocale` already exists for the
key.

### `phis site set --key <site key> [--name] [--hostname] [--public-base-url] [--support-email]`

Updates the given fields; at least one is required. Also rewrites the mail sender
(`no-reply@<hostname>`), the sender name and the contact recipient from the resulting values.

### `phis site enable|disable --key <site key>`

Sets the Site's active flag.

### `phis site del --key <site key>`

Destructive. Deletes the `phis.sites` row (and whatever cascades from it in the database) and removes
`sites.overrides.<key>` from `phis-runtime.json`. It does not touch the Site's source directory,
release artifacts, secrets stored under `site:<key>:...`, or web server and service configuration.
There is no confirmation.

### `phis site locale add --key <site key> --locale <locale>`

Adds a locale to the Site's available locales. The locale must be in
`translation.supportedLocales`.

### `phis site admin`

```text
phis site admin --site <site key> --email <email> [--password <pw>] [--first-name <n>] [--last-name <n>]
phis site admin --site <site key> --list
phis site admin --site <site key> --email <email> --revoke
```

- Grant (default): gives the account the Admin role on the Site, creating the account and its
  membership if the email is new. A password is written only for an account this call creates;
  without `--password` it gets a random password nobody knows, and the command says how to set one.
  An existing account's password is never changed. Can be run for several administrators.
- `--list`: lists accounts holding the Admin role (email, user id, role flags, name, whether a
  password is set).
- `--revoke`: removes the Admin role; the account and its other roles stay.

### `phis site user --site <site key> --email <email> --password <pw> [--overwrite]`

Sets the password of an existing account that is a member of the Site. Refuses when the account
already has a password unless `--overwrite` is given. The credential belongs to the account, not to
the Site, so it opens every Site the account is a member of; the command prints how many.

### `phis site check --key <site key> [--url <base url>]`

Asks a running Site which of its Modules are deactivated because a server capability is missing:
`GET <base url>/api/site/module-diagnostics` with the `api.internalToken` header. The base URL
defaults to `http://<host>:<port>` of the Site's first configured instance (see
[`site config`](#phis-site-config)). Exits `1` when a Module is deactivated. Requires
`api.internalToken` and a reachable Site. Run it after server or Site updates.

### `phis site config`

Instance locations are derived from `phis-config.json` unless overridden in
`sites.overrides.<key>` of `phis-runtime.json`:

| Value | Default |
| --- | --- |
| Source path | `<sites.sourcePathRoot>/<key>`, `sites.sourcePathRoot` defaults to `/opt/phis/sources` |
| Instance path | `<sites.instancePathRoot>/<key>`, default root `/var/www/phis/sites` |
| Port | `<sites.basePort> + <site id>`, `sites.basePort` defaults to `52000` |
| Host | `localhost` |

The source path is also the default `--path` of `init`, `reconcile`, `update` and `module`.

#### `phis site config set source --key <site key> [--source-host <host> --source-port <port> --source-path <path>]`

Writes `sites.overrides.<key>.source` in `phis-runtime.json`. All three flags together set it; none
removes it. Used by `site config nginx --source` to proxy to a development server.

#### `phis site config add --key <site key> --instance-host <host> [--instance-port <port>] --instance-path <path>`

Appends an instance to `sites.overrides.<key>.instances`. Once any instance is listed, the derived
default instance is no longer used.

#### `phis site config del --key <site key> --instance-host <host>`

Removes every listed instance on that host.

#### `phis site config nginx|apache|systemd|docker-compose|runtime --key <site key>`

```text
phis site config nginx   --key <site key> [--source]
phis site config systemd --key <site key> [--instance <n>]
```

Prints a configuration snippet to stdout. Nothing is written or installed. With `--json` the
snippet is in `config` next to the Site record; `runtime --json` prints the structured summary.

- `nginx`: one file for nginx's `http` context (on Debian, `/etc/nginx/sites-available/<key>.conf`
  linked from `sites-enabled/`, which `nginx.conf` includes inside `http {}`). It holds, in order:
  - `map $http_upgrade $phis_site_<key>_connection`: `upgrade` when the request asks for a protocol
    upgrade, else empty;
  - `upstream phis_site_<key>` with a `server` line for **every** instance (`127.0.0.1:<port>` for a
    local host, `<host>:<port>` otherwise), `keepalive 64` and `keepalive_timeout 4s`;
  - a `server` block for `server_name <hostname>` on port 80 with `client_max_body_size 2g`,
    proxying `location /` to the upstream with `proxy_http_version 1.1`, `Host $http_host`,
    `Upgrade $http_upgrade`, `Connection $phis_site_<key>_connection` and the forwarding headers
    (`X-Forwarded-Host $http_host`).

  `keepalive_timeout` stays below Node's keep-alive timeout of 5 s: otherwise nginx reuses a
  connection Node has closed and a `POST` fails with `502`. `Host $http_host` keeps a non-default
  port, which the Site's form relay compares with the `Referer`. Names carry the Site key (characters
  other than letters, digits and `_` become `_`), so the files of several Sites can be included
  together. With `--source`, the upstream is the source override instead and a `/_next/webpack-hmr`
  location for a development server is added. No TLS.
- `apache`: a `VirtualHost *:80` with `ProxyPass / http://127.0.0.1:<port>/` for the primary
  instance (the first local one, else the first).
- `systemd`: a unit for one instance, running `/usr/bin/node server.js` as user `phis` in the
  instance path, with `NODE_ENV=production`, `HOSTNAME=127.0.0.1`, `PORT=<port>`, `Restart=always`,
  and a commented `Environment=PHIS_RENDER_CACHE_MB=128` (the per-process memory bound of the render
  cache). `HOSTNAME` keeps the Site bound to loopback so only the proxy reaches it. Without
  `--instance` the unit is for the primary instance; `--instance <n>` picks the n-th (from 0) as
  `site config runtime` lists them, so a Site with several instances gets one unit each. The unit has
  no `ExecStop`: `phis instance drain` applies to server instances, and a Site reports no readiness.
- `docker-compose`: a service skeleton with a placeholder image.
- `runtime`: the Site row and its resolved source and instance locations.

## init, reconcile, update (Site scaffold)

```text
phis init      <site key> --api-base-url <url> [--path <dir>] [--package-manager pnpm|npm|yarn|bun] [--install]
phis reconcile <site key> [--path <dir>] [--package-manager pnpm|npm|yarn|bun] [--install]
phis update    <site key> [--path <dir>] [--package-manager pnpm|npm|yarn|bun]
```

The Site row must exist (`phis site add`). The site key is positional.

| Flag | Default | Notes |
| --- | --- | --- |
| `--path` | `<sites.sourcePathRoot>/<key>` (or the source override path) | The Site repository. |
| `--package-manager` | the Site's own | See [Package manager](#package-manager). |
| `--api-base-url` | none, required | `init` only. The address the Site's server-side code uses to reach `@phis/server`, written to `config/site-runtime.json`. The phis root does not record where the server listens (that is `PORT` and `HOSTNAME` in its environment), so there is no default: the Debian package serves on `http://127.0.0.1:5301`, the development server on `http://127.0.0.1:3101`. |
| `--install` | off | Runs the package manager's install after `init` or `reconcile`. `update` always installs. |

The scaffold (version 3) is generated by `src/lib/site-scaffold.mts`.

#### Package manager

Without `--package-manager`, `init` uses npm, and `reconcile` and `update` use the Site's own
manager: the name in `package.json` `packageManager`, else the manager whose lockfile the Site has
(`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock`/`bun.lockb`). A Site with neither,
or with lockfiles of several managers, is refused until `--package-manager` names one. No lockfile
is deleted.

With `--package-manager`, that manager is used, the lockfiles of the other managers are deleted,
and `packageManager` is set to `<manager>@<version>` when it named a different manager.

### `phis init <site key> --api-base-url <url>`

Creates a new Site repository. Fails when the target exists and is not an empty directory
(`Site target ... already exists; use phis reconcile`), when `--api-base-url` is missing or not an
http(s) URL, and when `api.internalToken` is not set in the phis root. Writes every scaffold file and
`.phis/scaffold-manifest.json` (scaffold version, site key, SHA-256 of every file written). See
[INSTALL.md](./INSTALL.md#6-scaffold-the-site) for the file list.

`config/site-runtime.json` gets `site.key`, `site.publicUrl` (the Site's public base URL, else
`https://<hostname>`), `phis.apiBaseUrl`, `phis.internalToken` (`api.internalToken`) and
`network.internalApiTimeoutMs` (`8000`). Only `init` writes this file.

### `phis reconcile <site key>`

Brings an existing Site repository to the current scaffold:

- Canonical files that are missing are created, files that differ are overwritten (`repaired`).
  Site edits to those files are lost.
- The Site root must hold a `package.json` (`No Site at ...` otherwise).
- `package.json` is merged by adding, not resetting: a dependency (in `dependencies` or
  `devDependencies`), script or top-level field the scaffold needs and the Site lacks is added with
  the scaffold's value; everything the Site already has keeps the Site's value, including version
  ranges such as `@phis/ui`. Two exceptions: `engines.node` is set to the scaffold's `>=24.21.0`
  (other `engines` keys stay), and `packageManager` changes only with an explicit
  `--package-manager` (see above).
- Site-owned files (`PHI_SITE_OWNED_AFTER_INIT`) are left alone when they exist: `.gitignore`, the
  Module projection `src/generated/site-modules.ts`, `site-modules-client-<area>.ts` (one per Area),
  `site-modules-authoring-client.ts`, `site-modules-fonts.ts`, `site-module-packages.json`, and
  `config/site-runtime.json`. A
  missing `.gitignore` or projection file is recreated with its initial content. A missing
  `config/site-runtime.json` is not: `reconcile` knows neither the server address nor the token.
  Create it from `config/site-runtime.example.json`.
- Files the previous scaffold wrote (per the old manifest) that the current one no longer writes are
  deleted when their content is unchanged (`removed`), and left in place when the Site edited them
  (`kept`). Directories emptied by a removal are removed. Site-owned files are never removed this way.
- The manifest is rewritten.

JSON output lists every file with its action: `created`, `repaired`, `unchanged`, `removed`, `kept`.
Review `kept` entries by hand; a kept route file can collide with its new location.

### `phis update <site key>`

`reconcile` (with the same `package.json` rule: versions are kept), then in the Site directory:
install (`pnpm install --no-frozen-lockfile`, `npm install`, `yarn install`, `bun install`),
`run typecheck`, `run build`, and then packages a release into `.phis/releases/<release id>/`.
`update` does not raise dependency versions; change them in the Site first (e.g. `npm install @phis/ui@<version>`),
then run `update`.

The release:

- is a copy of `.next/standalone`. Links inside it are copied as links, so a release does not depend
  on `.next/standalone`, which the next build replaces.
- finds `server.js` where Next put it: at the top of `.next/standalone` for a Site that is its own
  tracing root, or nested under the Site's path relative to the tracing root (a Site inside a pnpm
  workspace: `.next/standalone/<site dir>/server.js`, with `node_modules` at the top). Fails when
  there is none. For a nested build a `server.js` at the release top starts the nested one, so every
  release starts with `node server.js` in its directory.
- gets `.next/static` and `public/` next to that `server.js`.
- contains no `config/site-runtime.json`. Next's file tracer copies the file into
  `.next/standalone`; the copy leaves out every file of that name. In its place the app directory
  gets `config/site-runtime.json` as a relative link to the Site root's
  `config/site-runtime.json`. The standalone server changes into its own directory before it reads
  the file, so a release run where `update` built it reads the Site's current file. A release copied
  to another host needs that host's file at `<release>/config/site-runtime.json` (replace the link).
- holds `release.json` (`releaseId`, `scaffoldVersion`, `buildId`, `appDirectory`, `createdAt`).

`update` prints a note when the Site root has no `config/site-runtime.json`. Nothing is deployed or
restarted; the release directory is what an instance path points at. The scaffold's `.gitignore`
ignores `.phis/releases/`; a Site created before that entry was added needs it added by hand, because
`reconcile` does not rewrite `.gitignore`.

A running Site reads `config/site-runtime.json` once per process; restart it after changing that file.

## module (Site Modules)

A Site Module is a package the Site build imports through the generated projection
`src/generated/site-modules*.ts`. The desired state is `config/phis-modules.json` in the phis root.
`module` commands never fetch packages and never build.

The projection is written together: `site-modules.ts` (Server), one `site-modules-client-<area>.ts` per
Area, `site-modules-authoring-client.ts`, `site-modules-fonts.ts`, and `site-module-packages.json`, the
installed package names the scaffold's `next.config.ts` spreads into `transpilePackages` -- a package from
a tarball or a registry is compiled only when named there, and its `./fonts` boundary loads nothing
otherwise. Everything that is not in the
desired state is read from each package's manifest in the Site's `node_modules`, because no command runs
a Module: the Areas in its `package.json#phis` (`modules[].eligibleAreas`) are written into the Server
file as placements and decide which Area files import the package's Client door; its `exports` decide
whether the fonts file imports `./fonts` — that boundary calls `next/font/local` and throws outside a
Next build. A package that is not installed yet has neither answer: it stays in the Server file, where
the Site's build refuses it by name, and `add` and `sync` say to run `sync` once it is installed.

`--path` (default: the Site source path as for `init`) selects the Site repository for every command
except `list`. Those commands refuse to run when the directory holds no `package.json`
(`No Site at <path>`), so a wrong `--path` does not record a Module for a directory no build reads.

### `phis module list [--site <site key>]`

Lists installed Modules per Site (`packageName`, `origin`, `spec`). Reads only the desired state.

### `phis module add --site <site key> --package <@scope/name> [--spec <spec>] [--path <dir>]`

Records the Module and rewrites the projection. With `--spec` (a version range or `workspace:*`) the
package is also added to the Site's `package.json` dependencies (origin `resolved`); without it the
package must already be resolvable (origin `local`). Then inspects the installed package and prints
its issues, or `not installed yet` before the package manager ran. Exits `1` when the inspection
finds issues. Next: install dependencies, rebuild the Site, activate the Module for an Area in the
Builder. When the package was not installed yet, run `phis module sync` after the install as well:
the font projection is read from the installed package, and without it a Module's typefaces stay out
of the build.

### `phis module del --site <site key> --package <@scope/name> [--force] [--path <dir>]`

Removes the Module from the desired state, its dependency from `package.json` and rewrites the
projection. Refuses when blocks owned by the package are still drawn on published pages, and lists
them per Area; `--force` removes it anyway (the blocks stay in their pages and stop being drawn).
Rebuild the Site afterwards.

### `phis module sync --site <site key> [--path <dir>]`

Rewrites the projection from the desired state, for example after a scaffold, a hand edit, or the
install that followed an `add`. The installed packages are read again, so a `./fonts` boundary that
arrived with the install reaches `site-modules-fonts.ts` here. Rebuild afterwards.

### `phis module check --site <site key> [--package <@scope/name>] [--path <dir>]`

Inspects the installed Module packages in the Site's `node_modules` against the Module contract.
Fails when the path has no `package.json`; exits `1` when a package has issues.

## addon (server Add-ons)

A server Add-on is one `addon.mjs` artifact. `config/phis-addons.json` is the desired state, the
database registry is what the server dispatches against, and `reconcile` publishes one to the other.
The release id recorded is the CLI's package version. The lifecycle is described in
[ADDON_HOWTO.md](../ADDON_HOWTO.md#5-how-it-is-installed-and-activated).

An absent `config/phis-addons.json` reads as no Add-ons installed; the first `addon install` writes it.

### `phis addon list`

Lists installed Add-ons (`addonId`, `enabled`, `package@version`). Entries that no longer validate
against this release are listed first; exits `1` when there are any. Files only.

### `phis addon check`

Verifies every entry: manifest digest, artifact present and matching its digest, no two Add-ons
claiming the same service provider. Reports search queries without a text index. Exits `1` when an
entry does not validate and prints the way out (`upgrade` or `remove`). Files only.

### `phis addon install --artifact <path>`

Imports the artifact once to read and validate its manifest, copies it to
`addons/<scope>/<name>/<version>/addon.mjs` and records it **disabled**. Refuses an Add-on id or
package name that is already installed. Next steps: `reconcile`, `migrate`, `enable`, `reconcile`.

### `phis addon upgrade --addon <@scope/name> --artifact <path> [--repackage]`

Installs a newer (or same-version, different-bytes) artifact beside the old one and repoints the
entry; the enabled state is kept. Refuses a different Add-on id, a lower schema version, the
identical artifact, and a changed package name unless `--repackage`. Until the next `reconcile`
(and `migrate`, when the schema version rose) the Add-on answers `503`. Rolling back is `upgrade`
with the older artifact.

### `phis addon migrate [--addon <@scope/name>]`

Derives and applies the schema of one Add-on, or of all installed Add-ons, with
`database.migrationUri`, granting the serving role (the user in `database.uri`) access. Unchanged
Add-ons report `already at schema version`. Safe to repeat.

### `phis addon enable|disable --addon <@scope/name>`

Changes `enabled` in the desired state only. Takes effect after `phis addon reconcile`.

### `phis addon reconcile`

Writes the desired state into the registry for this release, records each Add-on's effective status
on the Sites that requested it (`available` or `disabled`), and creates groups a manifest declares for
Sites that have the Add-on enabled. Groups are never retired here. Needs the database.

### `phis addon remove --addon <@scope/name>`

Refuses while the Add-on is enabled. Deletes every installed version directory of the Add-on and its
entry in the desired state. Data stays; see `purge`.

### `phis addon purge --addon <@scope/name>`

Destructive and irreversible. Refuses while the Add-on is still installed. With
`database.migrationUri` it drops the Add-on's schema and deletes every record of it (Site assignments,
applied migrations, catalogue row, its stored secrets), notes its Media objects for removal by the
serving instance, and then deletes the objects of its per-Site stores.

### `phis addon forget --addon <@scope/name>`

Removes the entry from `phis-addons.json` without validating it, for a desired state that no longer
parses against this release. The artifact stays on disk. Files only.

### `phis addon site`

```text
phis addon site --addon <@scope/name>
phis addon site --addon <@scope/name> --site <site key> --enable [--without-module]
phis addon site --addon <@scope/name> --site <site key> --disable
```

- Without `--enable`/`--disable`: lists the Sites the Add-on is activated for (site id, requested,
  configuration status, effective status).
- `--enable`: requests the Add-on for the Site, computes the configuration status from its declared
  settings, and creates the groups it declares. If the Add-on has a Module half (the same package
  name) that the Site does not have in `phis-modules.json`, it refuses; run `phis module add` and
  rebuild first, or pass `--without-module` to enable only the server half.
- `--disable`: withdraws the request and retires the Add-on's groups on that Site. Refuses when the
  Add-on was never activated there.

### `phis addon config --addon <@scope/name> --site <site key> [--name <setting> [--value <value>]]`

- Without `--name`: lists the declared settings with the stored value or the default.
- `--name` with `--value`: validates and stores the value. An empty value (`--value ""` or
  `--value=`) is a value and is validated like any other.
- `--name` without `--value`: clears the stored value, so the declared default applies.

Refuses when the Add-on is not activated for the Site (`addon site --enable` first).

### `phis addon role`

```text
phis addon role --site <site key> [--addon <@scope/name>]
phis addon role --site <site key> --user <user id>
phis addon role --site <site key> --addon <@scope/name> --user <user id> --grant <role>
phis addon role --site <site key> --addon <@scope/name> --user <user id> --revoke <role>
```

- No `--user`: lists the roles each installed Add-on (or the one named) declares and who may grant them.
- `--user` only: lists the Add-on roles that user holds on the Site.
- `--grant`/`--revoke`: grants or revokes a declared role. The operator is not subject to the
  role's `grantableBy` rule.

### `phis addon owner --addon <@scope/name> --site <site key> [--from <user id>|none] --to <user id>`

Moves ownership of the Add-on's rows on this Site from one account to another. Without `--from` (or
with `none`) it moves the rows nobody owns. The target must be a member of the Site. Tables without a
Site column are skipped and listed.

### `phis addon storage`

```text
phis addon storage --addon <@scope/name> --site <site key> [--quota-bytes <n>] [--max-objects <n>]
                   [--unlimited] [--sweep] [--recount]
```

Prints the Add-on's store usage on the Site (bytes and objects against their ceilings) and optionally:

| Flag | Effect |
| --- | --- |
| `--quota-bytes <n>` | Sets the byte ceiling (whole number, `0` allowed and means nothing may be stored). |
| `--max-objects <n>` | Sets the object-count ceiling. |
| `--unlimited` | Removes both ceilings. |
| `--sweep` | Deletes Media Assets in the Add-on's Space that nothing links to and expired reservations, then deletes their objects from the store. |
| `--recount` | Lists the store prefix and rewrites the usage counters from what is really stored. Costs a full listing. |

Setting a ceiling refuses when the Add-on is not activated for the Site. `--sweep` runs before
`--recount`. Both reach the store directly; this works for the built-in Local store and for Providers
from installed Add-ons.

### `phis addon job --addon <@scope/name> --job <job id> --site <site key> --api-base-url <url>`

Asks the running server to run a declared job for a Site: `POST <api base url>/api/v1/addons/jobs`
with the internal token. `--api-base-url` is required, the server's address as reached from where the
CLI runs (Debian package: `http://127.0.0.1:5301`); there is no default. Exits `1` when the server
refuses. Requires `api.internalToken` and a running server.

## storage (Storage Profiles)

A Storage Profile binds a Site to a Media Storage Provider with its configuration and a credential
reference. The built-in Provider is Core's Local storage; other Providers come from installed
Add-ons. See [GROUPS_AND_STORAGE.md](../GROUPS_AND_STORAGE.md).

`--site` is lowercased, as in every other command.

### `phis storage list --site <site key>`

Lists the Site's Profiles and which Profile each Media Space writes new uploads to.

### `phis storage add --site <site key> --key <profile key> --provider <provider id> [--config <json|@file>] [--secret-name <name>|--secret-reference <ref>]`

Validates the configuration with the Provider's own factory (for Local: `rootDir` absolute,
`storageKeyPrefix` relative), inserts the Profile, probes it, and writes the CORS rules of every
Profile. `--config @file` reads JSON from a file resolved against the phis root. `--secret-name`
builds the reference `site:<site>:addon:<provider add-on>:<name>` (or `...:core:<name>`);
`--secret-reference` takes a full reference. Store the secret with `phis secret set` first.

### `phis storage set --site <site key> --key <profile key> [--config <json|@file>] [--replace] [--secret-name|--secret-reference]`

Merges `--config` into the stored configuration (`--replace` replaces it), optionally changes the
credential reference, validates, probes again and rewrites CORS rules.

### `phis storage use --site <site key> --key <profile key>`

Points the Site Space (not user or group Spaces) at the Profile for new uploads. Existing Assets stay
where they are. Fails when the Site Space does not exist yet; it is created the first time media is
used.

### `phis storage del --site <site key> --key <profile key>`

Deletes the Profile. Refuses while a Space or an Asset still uses it.

### `phis storage cors`

Writes the CORS rule of every external store from the Site registry (the Sites' public base URLs).
Run it after changing a Site's public base URL.

### `phis storage probe --site <site key> [--key <profile key>]`

Tests each external Profile (writability, verified checksum algorithms) and records the result and the
checksum algorithm on the Profile. The Local Provider is not probed.

## secret

Secrets are stored encrypted in `phis.server_secrets` with `secrets.encryptionKey`. A reference is
`[site:<site key>:](core|addon:<@scope/name>):<name>`; names are lowercase, `[a-z0-9._-]`, up to
64 characters.

### `phis secret init-key`

Writes a new random `secrets.encryptionKey` (version 1) to `phis-runtime.json`. Refuses when a key
exists, because replacing it makes every stored secret unreadable. Every server instance needs the
same key.

### `phis secret set --name <name> [--site <site key>] [--addon <@scope/name>] [--value <value>]`

Stores or replaces a secret. The value is read from stdin (a trailing newline is removed); stdin must
not be a terminal. `--value` works but warns, because the value is visible in the process list and
shell history. An empty `--value` is refused.

```sh
printf '%s' "$SMTP_PASSWORD" | phis secret set --name smtp-password --site acme
```

### `phis secret check --name <name> [--site] [--addon]`

Prints `configured`, `missing` or `unreadable` (stored but not decryptable with the current key)
without printing the value. Exits `1` for `unreadable`.

### `phis secret list [--site <site key>] [--addon <@scope/name>]`

Lists references, key versions and update times. Never values.

### `phis secret del --name <name> [--site] [--addon]`

Deletes the secret.

## auth

### `phis auth restore-preset --site <site key>`

Restores the first-party authentication UI (`@phis/ui/modules/auth`) as the auth provider in the
Public, App and Admin Areas of the Site, deactivates a foreign auth provider Module there, and clears
page-preset overrides of the auth pages. Idempotent; prints per Area whether anything changed and
which Module owns public `/login`. Use it when a Site locked itself out through its auth Module
selection.

### `phis auth import-secrets`

Moves the retired cleartext `auth.secrets` map from `phis-runtime.json` into the encrypted store,
rewrites stored references to the new form, and removes `auth.secrets` from the file once anything
was imported. Requires `secrets.encryptionKey`.

## operator

Platform operators are the accounts of the operator UI (`/operator`). They live in
`platformSuperUsers` of `phis-runtime.json` (argon2 password hashes), not in the database. The server
caches that file for up to four hours: restart it after every `operator` command that changes
something, or a new operator cannot sign in, and a removed or disabled one still can, until the cache
expires.

| Command | Effect |
| --- | --- |
| `phis operator list [--email <email>]` | Lists operators (email, enabled, name). |
| `phis operator add --email <email> --password <pw> [--name <display name>] [--disabled]` | Adds an operator; refuses a duplicate email. |
| `phis operator passwd --email <email> --password <pw>` | Replaces the password and ends the operator's sessions. |
| `phis operator enable|disable --email <email>` | Sets `enabled`. |
| `phis operator del --email <email>` | Removes the operator. The last one can be removed. |
| `phis operator secret` | Writes `operator.sessionSecret` if it is missing. Every operator write above does the same; this is for an installation from before the key existed, which has no operator sessions until it is set. |

Operator session cookies are signed with `operator.sessionSecret` and with nothing else -- not with
`api.internalToken`, which every Site runtime holds.

The cookies are stateless, so what ends one is the operator's `sessionGeneration` in
`platformSuperUsers`: every cookie carries the value it was signed with, and each request checks it
against the runtime file. Logging out and `phis operator passwd` count it up, which ends every session
that operator holds, a copied cookie included. A removed or disabled operator's sessions end the same
way, on their next request.

Passwords given on the command line are visible in the process list and shell history. A password
that starts with `-` is passed as it is (`--password -x1` or `--password=-x1`).

## media

### `phis media check [--fix]`

For every Local Storage Profile's `rootDir`, walks the directory and reports entries not owned by the
owner of the root directory itself (the account the server runs as). Exits `1` when there are
findings and `--fix` is not given. `--fix` changes ownership back (`chown`), which needs a user
allowed to do so, typically root. Missing roots are reported.

## maintain

### `phis maintain [--list] [--task <id>] [--dry-run]`

Runs bounded, idempotent cleanup tasks. `--list` prints them. Tasks:

| Id | Effect |
| --- | --- |
| `upload-sessions` | Deletes expired upload sessions and gives their reserved bytes back to their Media Spaces. |
| `addon-assets` | Deletes the rows of Media Assets in Add-on Spaces that nothing links to any more. The stored objects are not removed; `phis addon storage --sweep` removes them per Add-on and Site. With `--dry-run` it only reports how many Spaces it would examine. |

`--task` runs one, `--dry-run` reports without changing anything. A failing task is reported and the
others still run; the exit code is `1` when any task failed. Safe to run from a timer.

## mail

### `phis mail drain [--limit <rows>] --api-base-url <url>`

Sends what is still owed from the notification outbox (`phis.notification_outbox`). A notification is
tried once by the request that wrote it; this command is the retry, meant to be run from a timer. It
posts to `<api base url>/api/v1/notifications/drain` with the internal token, so the drain runs in the
serving process, where the mail configuration, the translation cache and the transport are.

`--api-base-url` is required, the server's address as reached from where the CLI runs (Debian package:
`http://127.0.0.1:5301`); the usage text shows it in brackets, but the command refuses to run without
it. `--limit` is the number of rows to claim in one run, a positive whole number; the server takes 100
when it is not given and never more than 1000. The command prints how many rows it claimed, sent,
dropped and failed, or the server's JSON answer with `--json`. It exits `1` when the server refuses or
fails the request. Requires `api.internalToken` and a running server.

## licenses

### `phis licenses check [--package <directory>]`

Scans the installed production and development dependencies of a package (default: `@phis/server`
itself) and reports non-permissive licenses. A production finding that is not acknowledged in
`src/cli/licenses.mts` is blocking and makes the command exit `1`. Does not need a phis root
configuration or the database.

## instance

Each server process writes a heartbeat row to `phis.server_instances` (release id, Add-on digest,
readiness).

### `phis instance list [--stale-after <seconds>]`

Lists instances; one counts as ready only if it reported ready within `--stale-after` seconds
(default `90`). Reports when several releases or Add-on sets are serving at once, which means a
rollout has not finished, and exits `1` in that case, so a deployment script can wait on it.

### `phis instance drain [--id <instance id>]`

Marks the instance as not ready, so a load balancer stops sending to it; the row stays. The id
defaults to `PHIS_INSTANCE_ID`, else `<hostname>:<root>`. Run it before stopping a server process; the
Debian unit `phis@.service` runs it as `ExecStop`.

### `phis instance prune [--forget-after <seconds>]`

Deletes rows of instances silent for longer than `--forget-after` seconds (default `2592000`, 30 days).

## Common tasks

| Task | Commands |
| --- | --- |
| First installation | [INSTALL.md](./INSTALL.md) |
| Upgrade the server | install the new release, `phis schema apply`, `phis addon check`, `phis addon migrate`, `phis addon reconcile`, restart, `phis site check --key <site>` |
| Create a Site | `phis site add`, `phis site admin`, `phis init`, `phis update` ([INSTALL.md](./INSTALL.md#5-create-a-site)) |
| Update a Site to a new scaffold or `@phis/ui` | raise the version in the Site (`npm install @phis/ui@<version>`), `phis update <site>`, deploy the new release, restart ([INSTALL.md](./INSTALL.md#11-updating-later)) |
| Add a Module to a Site | `phis module add`, `phis update <site>`, deploy, activate in the Builder ([INSTALL.md](./INSTALL.md#9-add-modules)) |
| Install an Add-on | `phis addon install`, `reconcile`, `migrate`, `enable`, `reconcile`, `phis addon site --enable` ([INSTALL.md](./INSTALL.md#10-add-add-ons)) |
| Remove an Add-on | `phis addon site --disable` per Site, `addon disable`, `addon reconcile`, `addon remove`, then `addon purge` to discard data |
| Reset a forgotten Site admin password | `phis site user --site <site> --email <email> --password <pw> --overwrite` |
| Reset an operator password | `phis operator passwd --email <email> --password <pw>`, restart the server |
| Take a server instance out of rotation | `phis instance drain --id <id>` |

## Payment profiles

Core owns merchant profiles and explicit consumer grants. The CLI uses only installed Provider
artifacts; no profile file can select a package import or supply a credential value.

Before the first profile: apply the Core schema with `phis schema apply`. It creates the Payment
tables, but it does not change a table that already exists, so a database whose
`phis.addon_event_outbox` predates Payments needs that table's new columns and constraints added by
hand before a Payment consumer is admitted ([DB.md](../DB.md#payment-execution)).
Then install and enable the Provider Add-on, enable it for the Site that will take payments
(`phis addon site --enable`), and store its credentials with `phis secret set`, passing the value on
stdin rather than on the command line.

```bash
phis payment profile list --site demo
phis payment profile add --site demo --file /protected/path/stripe-sandbox.json
phis payment profile set --site demo --file /protected/path/stripe-sandbox.json
phis payment profile probe --site demo --key stripe-sandbox --currency CHF
phis payment profile enable --site demo --key stripe-sandbox --currency CHF
phis payment profile retire --site demo --key stripe-sandbox
phis maintain --task payments --dry-run
phis maintain --task payments
```

Add/set file (references only; its policy names must exist in the installed consumer manifest):

```json
{
  "key": "stripe-sandbox",
  "providerKey": "@phis/stripe/stripe",
  "mode": "test",
  "credentialReferences": {
    "apiKey": "site:demo:addon:@phis/stripe:stripe-sandbox-api",
    "webhookSecret": "site:demo:addon:@phis/stripe:stripe-sandbox-webhook"
  },
  "grants": [{
    "consumerAddonId": "@example/shop",
    "operations": ["read", "create", "complete", "refresh", "capture", "cancel", "refund"],
    "merchantActions": {
      "capture": { "roles": [], "jobs": [], "events": [] },
      "cancel": { "roles": [], "jobs": [], "events": [] },
      "refund": { "roles": [], "jobs": [], "events": [] }
    }
  }]
}
```

The consumer must require `payments:v1` and declare `payment.changed`. Empty merchant policies permit
only an authenticated operator or Site Admin, within that consumer/profile grant. Add starts disabled;
set preserves the pinned merchant/provider/mode, increments the revision and disables new creation
until reprobed/enabled. Changing provider, account or mode requires a new key. Retired keys are not
reused, but existing payment evidence and reconciliation remain available. No profile delete or
financial purge is offered. Grant removal hides existing records from that consumer without deleting
financial evidence.

Probe is read-only against the PSP and records merchant identity/mode/method features; a changed
merchant or mode fails closed. Enable probes again and requires every ready serving instance (the
existing 90-second readiness window) to carry the installed Provider version and Core Payment
capabilities. It cannot establish that a webhook endpoint is reachable. Configure the separate
Stripe endpoint signing secret and validate real notification delivery before relying on fulfilment.

The maintenance task selects at most 100 unresolved payments, reconciles stored remote commands and
reports unavailable/concurrent claims. Dry-run changes nothing and makes no Provider calls. Retries
never switch Provider/account or generate replacement financial commands. No polling timer is added.
