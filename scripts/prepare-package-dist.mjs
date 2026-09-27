import { access, chmod, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Assembles the tarball this package is published from, out of artifacts built beforehand.
 *
 * The published package is not this checkout. A checkout carries the sources, the tests, the working
 * documents and `config/` with whatever an operator put there -- the runtime configuration of a real
 * installation, database URI and internal token included. So the artifact is composed by naming what
 * belongs in it, never by excluding what does not: a list of what to drop misses the next file that
 * appears, a list of what to keep cannot.
 *
 * Two distributions come out of the same three inputs. The Debian package assembles them in
 * `debian/rules` with the traced `node_modules` alongside, because a `.deb` may read no registry at
 * install time. The npm tarball leaves `node_modules` out and names its `dependencies`, because that is
 * the one thing npm does for whoever installs it. Both ship the same server, the same CLI and the same
 * schema file.
 */

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = path.join(packageRoot, "package");
const sourceManifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));

/*
 * The inputs, checked by hand rather than built here.
 *
 * `next build` and `build:cli` run in the workspace, where the lockfile and `@phis/contracts` are.
 * Building from inside this script would hide which step actually produced what is about to be
 * published -- and would build a second time in the release, which already built.
 */
const requiredInputs = [
  [".next/standalone", "pnpm build"],
  [".next/static", "pnpm build"],
  ["dist/phis.mjs", "pnpm build:cli"],
];
for (const [relativePath, command] of requiredInputs) {
  try {
    await access(path.join(packageRoot, relativePath));
  } catch {
    throw new Error(`Missing ${relativePath} -- run \`${command}\` first.`);
  }
}

/*
 * The application directory inside the standalone output carries the name of the checkout it was built
 * from, which is not ours to depend on. It is found by its entry point, the way `debian/rules` finds it,
 * and what comes out of it is taken by name.
 */
async function findStandaloneApplicationDirectory() {
  const standalone = path.join(packageRoot, ".next", "standalone");
  // Two levels, the depth `debian/rules` searches. Deeper would descend into the traced `node_modules`,
  // where tens of thousands of files include more than one `server.js` belonging to somebody else.
  const candidates = [standalone];
  for (const entry of await readdir(standalone, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== "node_modules") {
      candidates.push(path.join(standalone, entry.name));
    }
  }
  for (const candidate of candidates) {
    try {
      await access(path.join(candidate, "server.js"));
      return candidate;
    } catch {
      // Not the application directory.
    }
  }
  throw new Error("No server.js in .next/standalone -- the build produced no standalone server.");
}

const applicationDirectory = await findStandaloneApplicationDirectory();

await rm(distDirectory, { recursive: true, force: true });
await mkdir(distDirectory, { recursive: true });

// The server Next built, and the client assets it serves. `static` is not part of the standalone output.
for (const entry of ["server.js", ".next", "public"]) {
  await cp(path.join(applicationDirectory, entry), path.join(distDirectory, entry), {
    recursive: true,
  });
}
await cp(path.join(packageRoot, ".next", "static"), path.join(distDirectory, ".next", "static"), {
  recursive: true,
});
// Rendered pages and fetch results from the build machine. They are not part of the release, and one of
// them is a page as some other installation's database answered it.
await rm(path.join(distDirectory, ".next", "cache"), { recursive: true, force: true });

// The operator CLI, and the wrapper that gives it the application root. The wrapper is `bin`, not the
// bundle: the bundle sits one directory below the root it has to name, and cannot derive it alone.
await cp(path.join(packageRoot, "dist", "phis.mjs"), path.join(distDirectory, "dist", "phis.mjs"));
await cp(path.join(packageRoot, "phis"), path.join(distDirectory, "phis"));
await chmod(path.join(distDirectory, "phis"), 0o755);
await chmod(path.join(distDirectory, "dist", "phis.mjs"), 0o755);

// Read at run time through the application root, by setup and by `phis schema apply`.
await cp(path.join(packageRoot, "scripts", "sql"), path.join(distDirectory, "scripts", "sql"), {
  recursive: true,
});

/*
 * The shape a fresh installation starts from, and nothing beside it.
 *
 * `config/` in a checkout holds the real files next to the examples -- deployment state the CLI writes,
 * with the database URI and the internal token in it. They are named here one by one, from the manifest
 * of examples the directory itself declares, so that a new state file added later ships nothing.
 */
const configurationExamples = (await readdir(path.join(packageRoot, "config")))
  .filter((name) => name.endsWith(".example.json"));
for (const example of configurationExamples) {
  await cp(
    path.join(packageRoot, "config", example),
    path.join(distDirectory, "config", example),
  );
}

/*
 * The terms travel with the artifact or they do not apply to it: whoever installs this from npm has the
 * tarball and nothing else, and the repository they would otherwise have to go looking in is not part of
 * what they received.
 */
for (const documentFile of ["README.md", "LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.md"]) {
  await cp(path.join(packageRoot, documentFile), path.join(distDirectory, documentFile));
}

const distManifest = {
  name: sourceManifest.name,
  version: sourceManifest.version,
  license: sourceManifest.license,
  description: sourceManifest.description,
  // A scoped package is restricted unless it says otherwise, and the tarball is what npm reads: the
  // workspace manifest never reaches the registry, so the answer has to travel with the artifact.
  publishConfig: sourceManifest.publishConfig,
  // npm resolves the README's relative links against the repository; without it every link on the
  // package page points nowhere.
  repository: sourceManifest.repository,
  homepage: sourceManifest.homepage,
  bugs: sourceManifest.bugs,
  /*
   * `private` is deliberately not carried over. The workspace manifest keeps it, and keeps it for this
   * script's sake: a publish from the checkout would upload `config/` with a real installation's secrets
   * in it, and `private: true` is what makes that impossible rather than merely unintended. This
   * directory is the only thing here that can be published, and it is the only thing that may be.
   */
  // The standalone server Next emits is CommonJS. In a checkout the bundler decides what a module is; in
  // a tarball Node does, from this field.
  type: "commonjs",
  bin: { phis: "./phis" },
  files: ["**/*"],
  engines: sourceManifest.engines,
  dependencies: await resolveWorkspaceDependencies(sourceManifest.dependencies),
};

/*
 * A `workspace:` range cannot be resolved outside the workspace, and a published manifest must not carry
 * one. The sibling is named by the released version this build was made against -- what `pnpm publish`
 * would have written -- which is also why the workspace manifest names it by a released range rather than
 * by `workspace:*`.
 */
async function resolveWorkspaceDependencies(dependencies) {
  const resolved = {};
  for (const [name, range] of Object.entries(dependencies ?? {})) {
    if (!range.startsWith("workspace:")) {
      resolved[name] = range;
      continue;
    }
    const installed = JSON.parse(
      await readFile(path.join(packageRoot, "node_modules", name, "package.json"), "utf8"),
    );
    resolved[name] = installed.version;
  }
  return resolved;
}

await writeFile(
  path.join(distDirectory, "package.json"),
  `${JSON.stringify(distManifest, null, 2)}\n`,
);

console.log(
  `Package dist assembled from ${path.relative(packageRoot, applicationDirectory)}: ` +
    `${configurationExamples.length} configuration examples, CLI and schema included.`,
);
