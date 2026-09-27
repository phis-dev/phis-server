import { access, constants, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What the tarball must contain, and what it must never contain.
 *
 * `prepare-package-dist.mjs` composes the artifact by naming what belongs in it, which is the only way
 * that stays right as the checkout grows. This is the second half of that bargain: the composition is
 * checked against what it produced, because everything that can go wrong here is invisible afterwards. A
 * published tarball cannot be recalled, and the two mistakes worth a script are exactly the silent ones
 * -- a release that is missing the schema file, and a release that carries an installation's secrets.
 */

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = path.join(packageRoot, "package");
const sourceManifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
const distManifest = JSON.parse(await readFile(path.join(distDirectory, "package.json"), "utf8"));

const failures = [];
function refuse(reason) {
  failures.push(reason);
}

if (distManifest.name !== sourceManifest.name || distManifest.version !== sourceManifest.version) {
  refuse("The built package identity does not match the workspace package.");
}
if (distManifest.license !== sourceManifest.license) {
  refuse("The built package must carry the workspace licence.");
}
if (typeof distManifest.description !== "string" || distManifest.description.length === 0) {
  refuse("The built package must describe itself, because the registry page is all a reader gets.");
}

/*
 * The workspace manifest is private and stays private, so that no publish can be run from the checkout --
 * where `config/` holds a real installation's runtime configuration. This directory is the one publishable
 * thing in the repository, so it is the one place the flag must be absent.
 */
if (distManifest.private) {
  refuse("The built package must not be private, or the release cannot publish it.");
}
// Publishing a scoped package without this is a 402 at best and a private package at worst, and either
// way it is found out at release time rather than here.
if (distManifest.publishConfig?.access !== "public") {
  refuse("The built package must be published publicly.");
}
if (
  typeof distManifest.repository?.url !== "string"
  || !distManifest.repository.url.includes("github.com/")
) {
  refuse("The built package must name its GitHub repository, or the README's links break on npm.");
}
// The server and the CLI both refuse to start on an older runtime, and saying so here is what turns that
// into an install-time message instead of a stack trace.
if (typeof distManifest.engines?.node !== "string") {
  refuse("The built package must state the Node version it runs on.");
}
if (distManifest.type !== "commonjs") {
  refuse("The standalone server Next emits is CommonJS, and the manifest has to say so.");
}
for (const [name, range] of Object.entries(distManifest.dependencies ?? {})) {
  if (String(range).startsWith("workspace:")) {
    refuse(`The built package dependency "${name}" still names the workspace: ${range}.`);
  }
}
for (const name of Object.keys(sourceManifest.dependencies ?? {})) {
  if (distManifest.dependencies?.[name] == null) {
    refuse(`The built package drops the runtime dependency "${name}".`);
  }
}

/*
 * Everything that has to be there, named for the reason it has to be there. The server without the schema
 * file installs and then cannot set up a database; the CLI without its wrapper runs with the wrong
 * application root; the terms without the tarball do not apply to what was received.
 */
const requiredEntries = [
  "package.json",
  "server.js",
  ".next/BUILD_ID",
  ".next/static",
  "public",
  "dist/phis.mjs",
  "phis",
  "scripts/sql/001_create_phis.pgsql",
  "config/phis-runtime.example.json",
  "README.md",
  "LICENSE",
  "NOTICE",
  "THIRD-PARTY-NOTICES.md",
];
for (const entry of requiredEntries) {
  try {
    await access(path.join(distDirectory, entry));
  } catch {
    refuse(`The built package is missing ${entry}.`);
  }
}

const binTarget = distManifest.bin?.phis;
if (binTarget !== "./phis") {
  refuse("The built package must run the CLI through its wrapper, which is what names the app root.");
} else {
  try {
    await access(path.join(distDirectory, binTarget), constants.X_OK);
  } catch {
    refuse("The CLI wrapper in the built package is not executable.");
  }
}

/*
 * What must not be there.
 *
 * Read as a list of mistakes rather than a list of files: deployment state and secrets first, because a
 * published tarball cannot be recalled and `config/` in a checkout holds the database URI and the internal
 * token; then the build machine's own leftovers; then everything that only exists to develop this package,
 * which makes the artifact larger and tells a reader nothing.
 */
const forbidden = [
  {
    matches: (relativePath, name) =>
      relativePath.startsWith("config/") && !name.endsWith(".example.json"),
    reason: "deployment state: an installation's own configuration, secrets included",
  },
  {
    matches: (relativePath, name) => name.startsWith(".env"),
    reason: "an environment file",
  },
  {
    matches: (relativePath) => relativePath.split("/").includes("node_modules"),
    reason: "installed dependencies, which npm resolves from the manifest instead",
  },
  {
    matches: (relativePath) => relativePath.startsWith(".next/cache/"),
    reason: "the build machine's render and fetch cache",
  },
  {
    matches: (relativePath) =>
      ["src/", "test/", "addons/", "debian/", "docs/", "design/"]
        .some((directory) => relativePath.startsWith(directory)),
    reason: "sources, tests or working material that no installation reads",
  },
  {
    matches: (relativePath, name) => name.includes(".test.") || /^vitest.*\.config\./.test(name),
    reason: "a test or its configuration",
  },
  {
    matches: (relativePath, name) =>
      name.endsWith(".md")
      && !["README.md", "NOTICE", "THIRD-PARTY-NOTICES.md"].includes(relativePath),
    reason: "a working document: the repository's prose is not part of the release",
  },
];

let fileCount = 0;
let totalBytes = 0;
for (const entry of await readdir(distDirectory, { withFileTypes: true, recursive: true })) {
  if (!entry.isFile()) {
    continue;
  }
  const absolutePath = path.join(entry.parentPath, entry.name);
  const relativePath = path.relative(distDirectory, absolutePath);
  fileCount += 1;
  totalBytes += (await stat(absolutePath)).size;

  for (const rule of forbidden) {
    if (rule.matches(relativePath, entry.name)) {
      refuse(`The built package must not ship ${relativePath} -- ${rule.reason}.`);
    }
  }
}

if (failures.length > 0) {
  throw new Error(
    `The built package is not publishable:\n  ${failures.join("\n  ")}`,
  );
}

console.log(
  `Package dist valid: ${fileCount} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MiB, `
    + `${Object.keys(distManifest.dependencies ?? {}).length} runtime dependencies.`,
);
