# CDN: Planned

**Status: design, awaiting approval.** Nothing in this document is implemented. What runs today is the
interim CDN inside `@phis/releases` 0.1.8: the Add-on keeps its own bucket settings and secrets, and a
daily job lists the bucket and catalogues what an S3 tool put there. This design moves the bucket and
the catalogue into Core and leaves the Add-on what only it knows: counting, redirecting and showing.

## 1. What a CDN is here

A Site's CDN is one bucket of files that are published once and never change, which are served from a host
of their own (`cdn.phis.dev`) and never pass through a serving process. Model weights, installers and
archives are what it is for. It is not media. There is no Space, no Asset and no audience, nobody uploads
from a browser, and every file is public the moment it is published.

Each file has a key, `<name>/<version>/<file>`, and the key is its whole identity. A published key is never
written again, so a URL that once worked keeps delivering the same bytes, and the public host may cache
it for good (`immutable`).

**One CDN per Site.** A Site that wants none has none, and two Sites never share a bucket. Sharing would
make one Site's catalogue list another's files.

## 2. Why Core, not the Add-on

The interim design gives the Add-on its own S3 settings, its own SigV4 client and a sync job that
polls the bucket. Three things make that the wrong owner:

- **Publishing is an operator act on the host**, and `phis` is the operator's tool. It already writes
  reverse-proxy configuration and certificates (`phis proxy`, `phis site config nginx`), and it already
  builds Storage Provider adapters with their credentials (`phis storage probe`).
- **Core already has the S3 client**, through the Storage Provider contract: multipart plans, per-part
  checksums, resumable assembly and listing. The Add-on reimplements a slice of that.
- **A catalogue written at publish time needs no sync.** When the tool that uploads also records the
  file, Core knows what the bucket holds without polling it. A scheduler that looks every few minutes
  for an event is exactly what SERVER_ADDONS.md rules out.

Core does not learn anything about `@phis/releases`. It offers a CDN capability, and any Add-on may
read it: the releases package today, and later a shop that delivers digital goods.

## 3. Storage

### The bucket is a Storage Profile

The bucket is a Storage Profile like any other (`phis storage add`), with the Provider it needs
(`@phis/storage-s3/s3`, configuration and secret as today). One new profile flag sets it apart:

| Flag | Meaning |
| --- | --- |
| `PhiMediaStorageProfileFlags.Cdn = 1 << 1` | The profile holds a Site's CDN. No Media Space may use it: `storage use` refuses it, the Admin Media settings neither offer nor list it, and Core writes no CORS or lifecycle rule for it. |

`publicEndpoint` is set to the address the CLI reaches the storage at, which on a single host equals
`endpoint`. With it set, the Provider issues presigned (multipart) plans, and those are the CLI's upload
path (§5). The bucket's public website is not a field of the profile. How the bytes reach a visitor is
the CDN's `publicBaseUrl`.

**One key, held by Core.** The profile's secret is a key that can list, read and write this one bucket.
The interim design needed a second, read-only key in the Add-on, because the Add-on listed the bucket
itself. Under this design no Add-on reads the bucket: it reads the catalogue through `cdn:v1`, and the
visitor reads the public host. So nothing outside Core holds a credential for it.

### Two new tables

```sql
CREATE TABLE IF NOT EXISTS phis.site_cdns (
  site_id SMALLINT PRIMARY KEY REFERENCES phis.sites(id) ON DELETE CASCADE,
  storage_profile_id INT NOT NULL,
  public_base_url VARCHAR(512) NOT NULL,          -- https://cdn.phis.dev, no trailing slash
  flags INT NOT NULL DEFAULT 0,                   -- reserved
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_cdns_profile_fk FOREIGN KEY (storage_profile_id, site_id)
    REFERENCES phis.media_storage_profiles(id, site_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS phis.site_cdn_files (
  id BIGSERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.site_cdns(site_id) ON DELETE CASCADE,
  object_key VARCHAR(620) NOT NULL,               -- <name>/<version>/<file>
  name VARCHAR(200) NOT NULL,
  version VARCHAR(200) NOT NULL,
  file_name VARCHAR(200) NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  sha256 CHAR(64) NOT NULL,                       -- of the whole file, computed by the CLI
  content_type VARCHAR(255) NOT NULL,
  flags INT NOT NULL DEFAULT 0,                   -- PhisCdnFileFlags
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_cdn_files_key_unique UNIQUE (site_id, object_key)
);
CREATE INDEX IF NOT EXISTS site_cdn_files_name_idx ON phis.site_cdn_files (site_id, name, version);
```

`PhisCdnFileFlags.Withdrawn = 1 << 0` marks a file that is still in the bucket but no longer offered (§5,
`withdraw`). A key stays taken once it has been used, and that is what keeps "a URL never changes its
bytes" true.

Each segment of a key matches `^[A-Za-z0-9_+-][A-Za-z0-9._+-]{0,199}$`. The rule is the Add-on's today
and moves to `@phis/contracts`. The keys `api/…` are refused: the public host may share its name with a
translation mirror (`cdn.phis.dev` does), and its two exact paths live under `/api/v1/`.

## 4. The capability: `@phis/server/cdn:v1`

It is delivered to Add-ons, read-only and bound to the Site of the call:

```ts
export type PhisCdnFileV1 = {
  key: string;            // <name>/<version>/<file>
  name: string;
  version: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;         // lowercase hex
  contentType: string;
  publishedAt: string;    // ISO instant
  url: string;            // publicBaseUrl + "/" + encoded key
};

export interface PhisCdnCapabilityV1 {
  /** Whether the Site has a CDN at all; false means every other call answers empty. */
  configured(): Promise<boolean>;
  /** One file by key, or null; a withdrawn file is null. */
  file(key: string): Promise<PhisCdnFileV1 | null>;
  /** The Site's offered files, optionally of one name, newest version first; at most `limit` (≤ 500). */
  files(query?: { name?: string; limit?: number }): Promise<PhisCdnFileV1[]>;
}
```

There is no writer. Publishing is the operator's, as with secrets. An Add-on that could publish
could put bytes on a public host under the Site's name.

There is no event in v1. `cdn:v1 file-published` is the obvious successor once something has to react
to a publish, for example a release note or a cache warm-up.

## 5. The CLI: `phis cdn`

```text
phis cdn attach   --site <key> --profile <profile key> --public-base-url <https://host>
phis cdn detach   --site <key>                                   (refuses while files are offered)
phis cdn publish  --site <key> --name <name> --version <version> <file> [--as <file name>] [--content-type <type>]
phis cdn list     --site <key> [--name <name>] [--json]
phis cdn withdraw --site <key> --key <name/version/file>
phis cdn check    --site <key>                                   (bucket against catalogue)
phis cdn config   nginx --site <key> [--upstream <origin>] [--write]
```

- **`attach`** checks that the profile belongs to the Site, carries the `Cdn` flag (it sets the flag
  where the profile is not used by a Space yet) and is writable (probe), and that the URL is `https`
  and has no path. It writes `site_cdns`.
- **`publish`** does the following, in order:
  1. Reads the file once to get its size and SHA-256.
  2. Refuses a key that is already taken (catalogue row or object in the bucket).
  3. Asks the Provider for an upload plan with `mayAssembleFromParts`.
  4. Sends the body, or its parts, to the presigned addresses itself, with per-part checksums. An
     interrupted multipart upload resumes on the next run through `resumeUploadPlan`, as it does in the
     browser.
  5. Completes the upload, heads the object and compares the size.
  6. Writes the catalogue row, with the whole-file SHA-256 also kept as object metadata `sha256`.
  7. Prints the public URL and the Site's counted download address.

  No serving process is involved, and the bytes go from the file straight to the storage. The CLI needs
  the database and the storage endpoint, which is the case wherever `phis` runs today.
- **`withdraw`** sets `Withdrawn`. It does not delete the object by default: a link already handed out
  keeps working, but the file is no longer listed or offered, and its counted address answers 404.
  `--delete` also removes the object, for a file that has to disappear (a licence problem, a leaked
  build). A public cache in front of the host may keep serving it until its own expiry, and the command
  says so. In both cases the row stays `Withdrawn` and the key stays taken.
- **`check`** lists the bucket and compares: an object without a row (something uploaded with another
  tool), a row without an object (bytes deleted), and a size that disagrees. `--adopt` catalogues the
  objects without a row: it reads the `sha256` metadata where present and hashes otherwise. It is a
  command, not a job, for the reason `addon storage --recount` is one.
- **Content type.** It is taken from `--content-type`, otherwise from the file extension (a fixed table
  in `@phis/contracts`: archives, packages, executables, disk images, models such as `.safetensors`,
  `.gguf` and `.onnx`, audio, video, images, PDF, text), and otherwise it is
  `application/octet-stream`. There is no sniffing of the first bytes. The publisher is the operator, not
  an anonymous uploader, and the formats this is for (model weights, installers) are ones a sniffer does
  not recognise, so it would end at octet-stream anyway. What sniffing guards against in media, a file
  that turns out to be a page, is refused outright instead: `text/html`, `application/xhtml+xml`,
  `image/svg+xml`, XML and JavaScript types are not published, under any extension or `--content-type`.
  The host shares a site with the Site (`cdn.phis.dev` beside `phis.dev`), and a page served from it
  could set cookies for the Site.
- **`config nginx`** writes the public host's server block: `GET` only, `immutable`,
  `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment` (a `<video>` or `<img>` still
  plays, since the disposition only affects navigation), and a proxy to
  `--upstream` (for Garage the bucket's website endpoint, which serves the bucket named after the host).
  `phis proxy tls --domain <host>` gets the certificate, as it does for the server's own name. A CDN
  service in front of the bucket replaces this step and needs no Core change.

**Creating the bucket** is a step of the Provider, not of Core: `@phis/storage-s3` offers it to
`phis storage add --create-bucket [--website]`. It uses only the S3 API, so it is the same for every
endpoint the Add-on supports, Garage, MinIO, Ceph RGW, AWS and others:

- `CreateBucket`, where the profile's key is allowed to (Garage: `key allow --create-bucket`; AWS: an
  IAM policy). A bucket that already exists and belongs to this key is accepted.
- `PutBucketWebsite` with `--website`, for endpoints that serve a bucket as a website: Garage, AWS and
  Ceph do. An endpoint that answers `NotImplemented` is reported, not failed, because a CDN service in
  front of the bucket does not need it.
- Afterwards a probe: a small object is written, fetched through `--public-base-url` and removed, so
  `attach` knows that the public host actually delivers the bucket.

Public read beyond the website switch (an AWS bucket policy, an R2 public bucket) is not in the S3
API's common core. The Provider names it as a finding and leaves it to the operator.

**Creating keys** is not part of the S3 API on any of these endpoints. Garage, MinIO and AWS each have
their own admin interface for it. It stays with the operator: one key per CDN bucket, with read, write
and create-bucket rights on that bucket, stored with `phis secret set`. The operator guide lists the
Garage commands (`garage key create`, `garage key allow --create-bucket`), as it does for Postgres.

### Publishing from another machine

Not in v1. The CLI publishes from a host that reaches the database, and a file built elsewhere is first
copied there. Publishing from elsewhere would need an operator route that hands out the upload plan,
and a storage endpoint reachable from outside (`publicEndpoint` on a public name), which is the same plan
the CLI uses today, signed for a different address. That is a later step and does not change anything
above.

## 6. What `@phis/releases` keeps and loses

| Keeps | Loses |
| --- | --- |
| `cdn_downloads` (one row per counted click) and the dashboard card (downloads only) | the `cdn-*` settings and secrets |
| the hook `cdn-files`, now answered from `cdn:v1` | `cdn_files` and `cdn_sync_runs` |
| the route `download/:name/:version/:file`: looks the file up with `cdn:v1.file`, counts, `302` to its `url` | the job `cdn-sync`, `s3.ts` and the sync code |
| the record and options providers and the File download Widget, unchanged in shape | the card's "synced at" and sync errors (the CLI reports those now) |

The hook's payload stays the same, except that `directUrl` is `url` from Core. Removing the two tables is
not additive, so `phis addon migrate` refuses it. Before v1 they are dropped by hand on dev and prod,
where they are empty, and the checksum is recorded again, as was done for 0.1.8.

## 7. Order of work

1. `@phis/contracts`: `PhisCdnFileV1`, `PhisCdnCapabilityV1`, the capability id in
   `PHIS_CORE_CAPABILITIES` (delivered), the key rule, `PhisCdnFileFlags`.
2. `phis-server`: the profile flag and its refusals, the two tables (CREATE in `001_create_phis.pgsql`;
   added by hand to existing DBs), the capability binding, `phis cdn` with tests against the dev Garage,
   and a section in GROUPS_AND_STORAGE.md and CLI.md. At that point this document leaves `design/`.
3. `@phis/releases`: switch to `cdn:v1` and remove the interim parts (§6).
4. Prod: make the existing profile on `cdn.phis.dev` a `Cdn` profile, then `phis cdn attach`; after DNS,
   the same for `cdn.phisys.com`; then release Core and the Add-on.

## 8. Decided

- **Deleting** (19.11.): `withdraw --delete` removes the object as well (§5).
- **Creating the bucket** (19.11.): in `@phis/storage-s3`, through the S3 API only, therefore the same for
  every endpoint. Keys stay with the operator (§5).
- **Content type**: from flag or extension, no sniffing, active types refused, `nosniff` and
  `attachment` on the host (§5). This is the proposal and awaits confirmation.
