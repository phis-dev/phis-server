# Installing phis

This walkthrough takes a fresh Linux host to a running `@phis/server` with one Site, in order. Every
command is described in [CLI.md](./CLI.md); the configuration keys are listed in
[README.md](../README.md).

The examples use:

| Placeholder | Example |
| --- | --- |
| phis root (stage) | `/srv/phis/stages/prod` |
| server address | `http://127.0.0.1:5301` (the Debian package's port; use yours) |
| Site key | `acme` |
| Site source path | `/opt/phis/sources/acme` |
| Site instance path | `/var/www/phis/sites/acme` |

Run `phis` with `--root /srv/phis/stages/prod`, or export `PHIS_ROOT=/srv/phis/stages/prod` once; the
examples below assume the variable is exported.

1. [Prerequisites](#1-prerequisites)
2. [Install the server and configure the phis root](#2-install-the-server-and-configure-the-phis-root)
3. [Create the database schema](#3-create-the-database-schema)
4. [Start the server and create the first operator](#4-start-the-server-and-create-the-first-operator)
5. [Create a Site](#5-create-a-site)
6. [Scaffold the Site](#6-scaffold-the-site)
7. [Install, build and run the Site](#7-install-build-and-run-the-site)
8. [Web server and service units](#8-web-server-and-service-units)
9. [Add Modules](#9-add-modules)
10. [Add Add-ons](#10-add-add-ons)
11. [Updating later](#11-updating-later)

## 1. Prerequisites

- **Node.js 24.21.0** or later, for the server, the CLI and every Site. Earlier releases leak memory
  under React Flight rendering and run out of memory under load. `@phis/server` declares
  `"engines": {"node": ">=24.21.0"}`, a generated Site the same, the Debian package depends on
  `nodejs (>= 24.21.0)`, and the server's setup page fails its Node check below that.
- **No package manager for the server itself** when it is installed from the Debian package or the
  package tarball: the server and the `phis` CLI run on Node alone. **pnpm** is needed only to build the
  server from the source workspace (the workspace pins `pnpm@11.9.0`; `@phis/server` declares it in
  `devEngines`, so npm refuses to run the repository's own scripts).
- **A package manager for each Site**, which `phis init` and `phis update` run in the Site's directory:
  **npm** by default for a new Site, or yarn, bun or pnpm if the Site uses one; see
  [Package manager](./CLI.md#package-manager).
- **PostgreSQL** with the `pg_trgm` extension available (Debian: part of the `postgresql`
  package). `pg_trgm` is a trusted extension, so a role with `CREATE` on the database can install it.
- A **reverse proxy** (nginx or Apache) for TLS and public host names.
- A system account the services run as, e.g. `phis`, owning the phis root, the Local media root and
  the Site instance directories.
- Outbound SMTP relay reachable from the server (`email.smtp.targets`), if the Sites send mail.

Create the two database roles and the database. The serving role owns the Core schema `phis`; the
migration role owns the schemas of server Add-ons. Both need `CREATE` on the database.

`phis db bootstrap` does this, once the server is installed — step 2 below, after which:

```sh
phis db bootstrap --admin-uri postgres://<admin>@<host>:5432/postgres --name prod
```

It creates `phis_prod`, `phis_prod_user` and `phis_prod_migrator`, generates a password for each, and writes
both connection strings into `config/phis-runtime.json`, so step 2's table does not ask for them again
([CLI.md](./CLI.md#phis-db-bootstrap---admin-uri-postgres-uri)). `--admin-uri` is a connection allowed to
create databases and roles, and it must name a host; it need not be a superuser.

By hand, equivalently:

```sql
CREATE ROLE phis_prod_user LOGIN PASSWORD '<serving password>';
CREATE ROLE phis_prod_migrator LOGIN PASSWORD '<migration password>';
CREATE DATABASE phis_prod OWNER phis_prod_user;
GRANT CREATE ON DATABASE phis_prod TO phis_prod_migrator;
```

## 2. Install the server and configure the phis root

### From the source workspace

`@phis/server` depends on the workspace package `@phis/contracts`, so it is built inside the phis
pnpm workspace:

```sh
pnpm install                                   # at the workspace root
pnpm --filter @phis/server build               # next build
pnpm --filter @phis/server build:cli           # optional: dist/phis.mjs
```

Run the CLI as `pnpm phis ...` or `./phis ...` from the `phis-server` directory
([CLI.md](./CLI.md#running-the-cli)).

### From the Debian package

The package installs the server to `/usr/lib/phis/server`, the CLI to `/usr/bin/phis`, creates the
`phis` user and the stage `/srv/phis/stages/prod` with an empty `config/phis-runtime.json`, a link to
the packaged `phis-config.json` (`/usr/share/phis/phis-config.json`), and `.env` holding `PORT=5301`, `HOSTNAME=127.0.0.1` and a generated
`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`. The service is `phis@prod.service`. The server address is then
`http://127.0.0.1:5301`. `/usr/bin/phis` operates on `/srv/phis/stages/prod` unless `--root` or
`PHIS_ROOT` names another stage ([CLI.md](./CLI.md#running-the-cli)). Continue with the configuration
below.

### From the package tarball

`@phis/server` is not on npm; the Debian package is the release (README, "Distribution"). The tarball
`pnpm package:pack` builds carries the same standalone server, the same operator CLI and the same schema
file as the Debian package, with the runtime dependencies resolved by npm instead of copied in beside them.
It has not been installed on a real host yet. What it
does not carry is the machine: no service account, no stage, no service unit, no proxy configuration, and no
generated `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` -- which production requires and every Instance of one
installation has to share. Take those from [debian/](../debian/) where the installation needs them.

```sh
npm install -g ./phis-server-<version>.tgz
phis --help                          # the bin wrapper names the application root the CLI reads
```

The server is the standalone `server.js` in the package directory:

```sh
PHIS_ROOT=/srv/phis/stages/prod PORT=5301 HOSTNAME=127.0.0.1 \
  NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=... \
  node "$(npm root -g)/@phis/server/server.js"
```

`npm install` warns that it did not run `argon2`'s install script. It is not needed: both native packages
ship prebuilt binaries, and hashing and image processing work from the installed tarball as it is. Continue
with the configuration below.

### The phis root

The phis root is the directory the server and the CLI read `config/` from. The server takes it from
`PHIS_ROOT`, and in production falls back to `/srv/phis/stages/prod`. Create it, owned by the
service account:

```sh
install -d -o phis -g phis /srv/phis/stages/prod/config
```

| File | Action |
| --- | --- |
| `config/phis-config.json` | Copy from `phis-server/config/phis-config.json` and adjust. |
| `config/phis-runtime.json` | Create; start from `phis-server/config/phis-runtime.example.json` (Debian: `/usr/share/doc/phis/examples/`). Contains secrets: mode `0600`, owned by the service account. |
| `config/phis-addons.json` | Optional; `phis addon install` creates it. |
| `config/phis-modules.json` | Optional; `phis module add` creates it. |

In `phis-config.json`, check at least:

| Key | Why |
| --- | --- |
| `translation.supportedLocales`, `translation.sourceLocale` | `phis site add` accepts only supported locales. |
| `sites.sourcePathRoot`, `sites.instancePathRoot`, `sites.basePort` | Default Site source path, instance path and port (`basePort + site id`). |
| `media.local.rootDir` | Where the Local Storage Profile writes media; create it, owned by the service account. |
| `email.from`, `email.fromName`, `email.smtp.targets` | Outbound mail. |
| `bootstrap.enabled` | `true` serves the setup pages at `/setup` (step 4); `false` hides them. |

In `phis-runtime.json`, set the values the server needs. Generate each 64-character hex value with
`openssl rand -hex 32`:

```json
{
  "database": {
    "uri": "postgresql://phis_prod_user:<serving password>@127.0.0.1:5432/phis_prod",
    "migrationUri": "postgresql://phis_prod_migrator:<migration password>@127.0.0.1:5432/phis_prod"
  },
  "api": {
    "internalToken": "<random token>"
  },
  "auth": {
    "transactionEncryptionKey": "<64 hex>"
  },
  "registration": {
    "intentEncryptionKey": "<64 hex>"
  }
}
```

The example file validates as it is but holds placeholders, and it leaves out the two 64-hex keys
(`auth.transactionEncryptionKey`, `registration.intentEncryptionKey`), because a placeholder there
would not validate; add them as above.

Then write the secret store key and validate:

```sh
phis secret init-key          # writes secrets.encryptionKey; every instance needs the same file
phis config validate
```

`api.internalToken` is what Sites authenticate with. The `/setup` finish step generates one if it is
missing; `phis init` (step 6) copies it into the Site and refuses to run while it is unset.
`operator.sessionSecret` signs the operator session cookies and is written by the same finish step, or
by `phis operator add`; it is deliberately not the internal token, which every Site holds.

In production the server also needs the environment variable `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`
(base64 of 32 bytes: `head -c 32 /dev/urandom | base64`) and refuses to start without it. Instances
of one installation share the value. Other server environment variables (`PORT`, `HOSTNAME`,
`TRUST_PROXY`, `PHIS_INSTANCE_ID`) are described in [README.md](../README.md).

## 3. Create the database schema

```sh
phis schema apply
phis schema check
```

`apply` creates the `phis` schema, its tables and `pg_trgm` as the serving role, and grants the
migration role what Add-on migrations need. It is idempotent and is run again after every server
upgrade ([CLI.md](./CLI.md#schema)).

## 4. Start the server and create the first operator

Start the server with the phis root and a loopback bind:

```sh
# source workspace, in phis-server/
PHIS_ROOT=/srv/phis/stages/prod NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=<key> \
  pnpm exec next start -H 127.0.0.1 -p 5301

# Debian package
systemctl enable --now phis@prod.service
```

The server is built with `output: "standalone"`, so `next start` logs a warning that it does not work
with that setting and recommends the standalone `server.js`. The Debian package runs the standalone
`server.js` (see `debian/rules` for the files it takes from `.next/standalone`).

Before stopping a server process, `phis instance drain` withdraws its readiness; the Debian unit does
this in `ExecStop`.

Create the first platform operator, the account of the operator UI at `/operator`:

```sh
phis operator add --email ops@example.com --password '<password>' --name 'Operations'
```

The server caches the configuration for up to four hours: restart it after this command, or the new
operator cannot sign in yet. The same holds for every later CLI command that changes
`phis-runtime.json` (other `operator` commands, `site add`, `site config set|add|del`, `secret
init-key`), and for editing the file by hand.

### Alternative: the setup pages

With `bootstrap.enabled: true`, the server serves `/setup`, a guided flow: runtime checks, first
operator (only while none exists), translation mode, database connection (writes `database.uri`),
schema (the same script as `phis schema apply`), an optional first Site, and finish, which writes `api.internalToken` if missing and sets
`bootstrap.enabled: false` in `phis-runtime.json`. The setup pages have no login; while
`bootstrap.enabled` is `true`, keep the server reachable only by the operator (loopback bind, SSH
tunnel). They do not write `database.migrationUri`, `secrets.encryptionKey`,
`auth.transactionEncryptionKey` or `registration.intentEncryptionKey`; set those as in step 2. A Site
created there gets no `sites.overrides.<key>.sourceLocale` (its source locale is
`translation.sourceLocale`) and no administrator; continue with `phis site admin` in step 5.

## 5. Create a Site

```sh
phis site add --key acme --name 'ACME' --hostname www.acme.example \
  --public-base-url https://www.acme.example \
  --source-locale en --default-locale en --available-locales en,de \
  --support-email support@acme.example
```

This inserts the Site row and writes the immutable `sites.overrides.acme.sourceLocale` to
`phis-runtime.json`; restart the server so it reads the override. All locales must be in
`translation.supportedLocales`. The key must match `[a-z0-9][a-z0-9._-]{0,63}`
([CLI.md](./CLI.md#site)).

Give the Site its first administrator, who signs in on the Site itself:

```sh
phis site admin --site acme --email admin@acme.example --password '<password>' \
  --first-name Ada --last-name Admin
```

Without `--password` the account gets an unknown random password; set one with
`phis site user --site acme --email admin@acme.example --password '<password>' --overwrite`
([CLI.md](./CLI.md#phis-site-admin)).

`phis site config runtime --key acme` shows the Site's derived source path, instance path and port.

## 6. Scaffold the Site

```sh
phis init acme --path /opt/phis/sources/acme --api-base-url http://127.0.0.1:5301
```

- The Site row must exist, and the target must not exist or be an empty directory; otherwise use
  `phis reconcile`.
- `api.internalToken` must be set in the phis root (step 2); `init` refuses otherwise.
- `--path` defaults to `<sites.sourcePathRoot>/<site key>`.
- `--api-base-url` is required: the address the Site's server-side code uses to reach
  `@phis/server`, as seen from the host the Site runs on. The Debian package serves on
  `http://127.0.0.1:5301`. Only `init` writes it into `config/site-runtime.json`.
- `--package-manager` defaults to `npm` for a new Site.

What `init` writes (scaffold version 3):

| Path | Content |
| --- | --- |
| `package.json` | Scripts `dev`, `build`, `start`, `typecheck`; `next`, `react`, `antd`, `@phis/ui` and types; `engines.node >=24.21.0`; `packageManager`. |
| `tsconfig.json`, `next.config.ts` | `output: "standalone"`, the in-memory render cache handler from `@phis/ui/next/cache-handler`, `transpilePackages` with `@phis/ui` and the installed Module packages from `src/generated/site-module-packages.json`. |
| `.gitignore` | Ignores `node_modules/`, `.next/`, build output, `.phis/releases/` and `config/site-runtime.json`. |
| `config/site-runtime.json` | `site.key`, `site.publicUrl`, `phis.apiBaseUrl`, `phis.internalToken` (from `api.internalToken`), `network.internalApiTimeoutMs` (`8000`). |
| `config/site-runtime.example.json` | The same keys with `site.publicUrl`, `phis.apiBaseUrl` and `phis.internalToken` empty. |
| `src/proxy.ts` | Request routing (`@phis/ui/next/site-proxy`). |
| `src/app/(site)/` | Route group for everything that reads the request: root layout, index page, `not-found`, `forbidden`, `unauthorized`; the Public Area under `[root]/` and the Areas `accounting`, `admin`, `app`, `builder`, `editor`, each with a `(root)` and a `(pages)` branch and their region slots; `builder/api/[[...path]]`. |
| `src/app/(static)/static-render/[marker]/[mode]/[root]/` | Route group for the anonymous Public Area render that is cached per page, locale and colour scheme. |
| `src/app/api/{auth,site,addons,hooks}/[[...path]]/route.ts`, `src/app/api/site/forms/route.ts` | Thin proxies to `@phis/server`. |
| `src/app/api/site/module-diagnostics/route.ts`, `src/app/api/site/navigation-target/route.ts` | Used by `phis site check` and navigation. |
| `src/app/sitemap.xml/route.ts`, `src/app/robots.txt/route.ts` | The crawler files. Asset bytes travel through the `/api/site` proxy. |
| `src/app/globals.css` | Empty Site stylesheet. |
| `src/runtime-modules/` | Area hosts that receive the Module projection. |
| `src/generated/site-modules.ts`, `site-modules-client-<area>.ts`, `site-modules-authoring-client.ts`, `site-modules-fonts.ts`, `site-module-packages.json` | The Module projection, empty until `phis module add`. Build state, ignored by git. |
| `.phis/scaffold-manifest.json` | Scaffold version, Site key, and the SHA-256 of every file written. `reconcile` uses it. |

`config/site-runtime.json`, `.gitignore` and the `src/generated/` files belong to the Site after
`init`: `reconcile` leaves them as they are.

`src/generated/` is ignored by git as well. The projection is what the operator installed, and its
source is the desired state in the phis root (`config/phis-modules.json`), not the Site's history: a
fresh clone gets the empty files from `reconcile` and the installed Modules from `phis module sync`. Every other file is canonical and is overwritten by
`reconcile`. Put Site-specific code in new files, not in canonical ones.

`config/site-runtime.json` is ignored by git, so a fresh clone of the Site has none: create it from
`config/site-runtime.example.json` on every host that builds or runs the Site. `reconcile` does not
create it.

The canonical files are thin wrappers: routes, proxy and Area hosts call into `@phis/ui` and hold no
CMS, media, locale or proxy logic of their own. A change to that shared behaviour reaches a Site by
updating `@phis/ui` and rebuilding. The scaffold contains no optional feature packages; Modules are
added only with `phis module add` (step 9), and `reconcile` keeps them.

Commit the repository.

## 7. Install, build and run the Site

```sh
phis update acme --path /opt/phis/sources/acme
```

`update` reconciles the scaffold, runs the Site's package manager (install, `typecheck`, `build`),
and copies the standalone build with `.next/static` and `public/` into
`/opt/phis/sources/acme/.phis/releases/<release id>/`. The printed release id is the directory name.
Next nests the app inside `.next/standalone` when the Site is built inside a workspace; `update` finds
it there and writes a `server.js` at the top of the release that starts it, so every release starts
the same way. Equivalent by hand: `npm install && npm run typecheck && npm run build` in the Site
directory, without the release copy.

The release holds no copy of `config/site-runtime.json` and so no internal token. Its
`config/site-runtime.json` is a relative link to `/opt/phis/sources/acme/config/site-runtime.json`,
which the release reads when it starts. A release copied to another host needs that host's own file
in place of the link.

`@phis/ui` and the other dependencies must be resolvable by the package manager, from a registry or a
workspace.

Run the release from the instance path:

```sh
ln -sfn /opt/phis/sources/acme/.phis/releases/<release id> /var/www/phis/sites/acme
cd /var/www/phis/sites/acme
NODE_ENV=production HOSTNAME=127.0.0.1 PORT=52001 node server.js
```

- The port is `sites.basePort + site id` (`phis site config runtime --key acme` prints it).
- The Site reads `config/site-runtime.json` once per process, through the release's link from
  `/opt/phis/sources/acme/config/`. After changing the file, restart the Site; no new release is
  needed.
- Rendered Public Area pages are kept in the process's memory, 128 MB per process by default. Set
  `PHIS_RENDER_CACHE_MB` to change it and size the host's memory for all Site processes (see
  `STATIC_RENDERING.md` in `@phis/ui`). Instances do not share the cache.
- `npm start` (`next start`) in the source directory also serves the build, but warns that it does
  not work with the scaffold's `output: "standalone"`; use `server.js` in production.

For development, `npm run dev` in the Site directory runs `next dev`.

## 8. Web server and service units

`phis site config` prints snippets; it writes nothing ([CLI.md](./CLI.md#phis-site-config)).

```sh
phis site config systemd --key acme > /etc/systemd/system/phis-site-acme.service
phis site config nginx   --key acme > /etc/nginx/sites-available/acme.conf
```

The systemd unit runs `/usr/bin/node server.js` as `phis` in the instance path with
`NODE_ENV=production`, `HOSTNAME=127.0.0.1`, `PORT=<port>` and `Restart=always`. It carries
`#Environment=PHIS_RENDER_CACHE_MB=128` commented out; uncomment and change it if the default does not
fit. Check the Node path, then:

```sh
systemctl daemon-reload
systemctl enable --now phis-site-acme.service
```

A Site with several instances (`phis site config add`) gets one unit per instance:
`phis site config systemd --key acme --instance <n>` into `phis-site-acme-<n>.service`, numbered as
`phis site config runtime --key acme` lists them. A Site unit has no drain step; `phis instance drain`
is for server instances.

The nginx file belongs in nginx's `http` context, which is where Debian includes
`sites-enabled/*`. It holds a `map` that sets `Connection` to `upgrade` only for upgrade requests, an
`upstream` with every instance of the Site, `keepalive 64` and `keepalive_timeout 4s`, and a `server`
block on port 80 for the Site's host name with `client_max_body_size 2g`, `proxy_http_version 1.1`,
`Host $http_host` and the forwarding headers. Keep `keepalive_timeout` below Node's keep-alive timeout
of 5 s when you edit it: otherwise nginx reuses connections Node has closed and `POST` requests fail
with `502` (the phis-host README, section "Web server in front of several instances", has the details
and the Apache equivalent). Add TLS (a `listen 443 ssl` block and certificates), enable it and reload
nginx. The Site's proxy routes forward `/api/auth`, `/api/site`, `/api/addons` and `/api/hooks` to the
server internally, so the server itself needs no public host name for the Site.
Expose the operator UI (`/operator`) only to operators.

The same keep-alive rule applies to a proxy in front of several server instances. The templates the
package installs (`/usr/share/phis/templates/nginx/phis.conf` and `.../apache2/phis.conf`, copied to
`sites-available/phis.conf` by `postinst`) carry it: an `upstream phis` pool with the instances the
package runs — `phis@prod.service` on `127.0.0.1:5301` and a commented line for a second one —
`keepalive 64`, `keepalive_timeout 4s`, the `Connection` map, and `Host $http_host`. Add a further
instance of the same stage as a further line in that pool. Another stage is another installation with
its own database: give it its own `upstream` and `server` block, never a line in this one. The Apache
template is a `balancer://phis` with `ttl=4` per member, which is the same rule on that side.

### A translation mirror

An installation that other installations read global translations from -- `translation.cdnBaseUrl` on
their side, `cdn+deepl` as their mode -- is published differently from a Site or an operator host. It
needs `api.publicToken` set and `translation.allowPublicReads` on, and its host name answers two paths
and nothing else:

```nginx
server {
    listen 443 ssl;
    server_name cdn.example.test;

    # certificates, HSTS

    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

    location = /api/v1/tr {
        proxy_pass http://127.0.0.1:5301;
    }

    location = /api/v1/locales {
        proxy_pass http://127.0.0.1:5301;
    }

    location / {
        return 404;
    }
}
```

Exact matches, so `/api/v1/tr/anything` is not a door too. The `404` is the point of the block: the
`location /` the templates above carry would publish the operator UI, the setup pages and every internal
`/api/v1` route under this host name as well. They refuse a caller without the internal token, so an
unfiltered mirror is surface rather than a leak, but the setup pages have no login of their own. A mirror
is never published through a Site's proxy routes -- they set the internal token, which turns every
caller into a trusted one; [TRANSLATIONS.md](../TRANSLATIONS.md), "How a mirror is served", has the
reasoning and what an edge cache in front would have to respect.

## 9. Add Modules

A Site Module is a package the Site build includes.

```sh
phis module add --site acme --package @phis/marketplace --spec 0.1.0 --path /opt/phis/sources/acme
phis update acme --path /opt/phis/sources/acme
```

`module add` records the Module in `config/phis-modules.json`, adds the dependency when `--spec` is
given, and rewrites `src/generated/site-modules*.ts` — including `site-modules-fonts.ts`, which lists
the installed packages that export `./fonts`, and `site-module-packages.json`, which `next.config.ts`
reads so Next compiles every installed Module package. A package added before it is installed is not yet
readable, so run `phis module sync --site acme --path /opt/phis/sources/acme` after the install to
pick up the typefaces it ships. `update` installs and builds a new release;
deploy it (step 7) and restart the Site service. Then activate the Module for an Area in the Builder.
`phis module check --site acme` inspects the installed packages
([CLI.md](./CLI.md#module-site-modules)).

## 10. Add Add-ons

A server Add-on is one `addon.mjs` artifact, installed once per phis root and activated per Site.

```sh
phis addon install   --artifact ./dist/addon.mjs
phis addon reconcile
phis addon migrate   --addon @acme/status
phis addon enable    --addon @acme/status
phis addon reconcile
```

If the Add-on has a Module half (the same package name), add it to the Site first (step 9), then
activate the Add-on for the Site:

```sh
phis addon site   --addon @acme/status --site acme --enable
phis addon config --addon @acme/status --site acme                  # list settings
phis addon config --addon @acme/status --site acme --name <setting> --value <value>
```

Secrets the Add-on declares are stored with `phis secret set --addon @acme/status --site acme --name
<name>` (value on stdin). Roles are granted with `phis addon role`
([CLI.md](./CLI.md#addon-server-add-ons)).

## 11. Updating later

### Server

Install the new server release, then:

```sh
phis schema apply
phis addon check
phis addon migrate
phis addon reconcile
```

Restart the server instances one by one (`phis instance drain` first), check
`phis instance list`, and run `phis site check --key acme` against each Site.

### Site

```sh
phis update acme --path /opt/phis/sources/acme
```

`update` runs `reconcile` first, which:

- rewrites the canonical scaffold files to the current scaffold (Site edits to them are lost);
- adds to `package.json` what the scaffold needs and the Site lacks, keeping every version, script
  and field the Site already has; only `engines.node` is set to `>=24.21.0`. To move to a newer
  `@phis/ui` or Next, raise the version in the Site (`npm install @phis/ui@<version>`) and then run `update`;
- keeps the Site-owned files (`PHI_SITE_OWNED_AFTER_INIT`: `config/site-runtime.json`, `.gitignore`,
  `src/generated/site-modules*.ts`) as they are;
- removes files an earlier scaffold wrote and the current one no longer does, if their content is
  unchanged, and reports edited ones as `kept`, which you move or delete by hand;
- uses the Site's own package manager and deletes no lockfile, unless `--package-manager` names a
  different one.

A Site scaffolded before `.phis/releases/` was part of the generated `.gitignore` needs that line
added by hand; `reconcile` does not rewrite `.gitignore`.

Review the changes (`phis reconcile acme --json` lists every file with its action, and `git diff`
shows them), then deploy the new release (step 7) and restart the Site service. To change the
server address or token of an existing Site, edit `config/site-runtime.json` yourself; `reconcile`
does not rewrite it.
