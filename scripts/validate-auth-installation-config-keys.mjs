import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

/**
 * Everything a provider installation's config is read for has exactly one writer.
 *
 * `config` is a free-form JSON document on the installation, and the provider flow reads settings out
 * of it on every login: the scope the authorize URL asks for, the restriction the callback checks, the
 * prompt it passes on, the trust that decides whether a verified address may join an existing account.
 * Four of those were read and written by nothing at all. The two admin routes each built a fresh config
 * carrying `tenant`, so the rest could be set only by editing the Site's Auth document in the database
 * by hand -- and a login restriction that cannot be entered is a door that looks closed and is open.
 *
 * Both directions, because both fail quietly. A key nobody writes is a setting that does not exist; a
 * key nobody reads is a setting that does nothing, and the operator who typed it believes otherwise.
 *
 * The writer is `buildAuthInstallationConfig` (src/lib/site-auth/installation-catalog.ts), which both
 * routes go through. A restriction is written under the name its provider is narrowed by, so the names
 * come out of the catalog's own `restrictionKey` entries rather than out of the assignment.
 */
const repositoryRoot = process.cwd();

const readDirectories = ["src/lib/site-auth", "src/app/api/v1/auth"];
const catalogFile = "src/lib/site-auth/installation-catalog.ts";
const writerName = "buildAuthInstallationConfig";

/** A read of the installation's config: `installation.config.<key>`, however the installation is held. */
const readPattern = /\binstallation\.config\.([A-Za-z_$][\w$]*)/gu;
/** A write inside the writer: `config.<key> = …` and `delete config.<key>`. */
const writePattern = /(?:delete\s+)?\bconfig\.([A-Za-z_$][\w$]*)\s*(?:=[^=]|;)/gu;
/** The provider catalog's restriction names, which are written through a computed key. */
const restrictionPattern = /restrictionKey:\s*"([^"]+)"/gu;

async function listSourceFiles(directory) {
  const entries = await readdir(path.join(repositoryRoot, directory), {
    withFileTypes: true,
    recursive: true,
  });
  return entries
    .filter((entry) => entry.isFile() && /\.ts$/u.test(entry.name) && !/\.test\.ts$/u.test(entry.name))
    .map((entry) => path.relative(repositoryRoot, path.join(entry.parentPath ?? entry.path, entry.name)));
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

const catalogSource = await readFile(path.join(repositoryRoot, catalogFile), "utf8");
if (!catalogSource.includes(`export function ${writerName}(`)) {
  console.error(`Auth installation config validation failed: ${writerName} is not exported from ${catalogFile}.`);
  process.exit(1);
}

const written = new Set([
  ...[...catalogSource.matchAll(writePattern)].map((match) => match[1]),
  ...[...catalogSource.matchAll(restrictionPattern)].map((match) => match[1]),
]);

const readBy = new Map();
const strayWriters = [];
for (const directory of readDirectories) {
  for (const file of await listSourceFiles(directory)) {
    const source = await readFile(path.join(repositoryRoot, file), "utf8");
    for (const match of source.matchAll(readPattern)) {
      if (!readBy.has(match[1])) {
        readBy.set(match[1], `${file}:${lineOf(source, match.index)}`);
      }
    }
    if (file === catalogFile) {
      continue;
    }
    for (const match of source.matchAll(writePattern)) {
      strayWriters.push(`${file}:${lineOf(source, match.index)} writes \`config.${match[1]}\``);
    }
  }
}

const failures = [
  ...[...readBy.entries()]
    .filter(([key]) => !written.has(key))
    .map(([key, where]) => `\`config.${key}\` is read at ${where} and written by nothing. `
      + `Every setting the provider flow reads is written by ${writerName} (${catalogFile}), so an `
      + "operator can set it; one that is not can only be entered by editing the Site's Auth document "
      + "by hand, which is how a login restriction ends up being a door that looks closed."),
  ...[...written]
    .filter((key) => !readBy.has(key))
    .map((key) => `\`config.${key}\` is written by ${writerName} and read by nothing. A setting that `
      + "changes no behaviour reads as a promise the installation does not keep. Either read it where "
      + "it belongs or stop offering it."),
  ...strayWriters.map((where) => `${where}, beside ${writerName}. The two admin routes each built their `
    + "own config once, and that is how four settings ended up readable and unwritable. One writer."),
];

if (failures.length > 0) {
  console.error(`Auth installation config validation failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}

console.log(
  `Auth installation config keys valid (${readBy.size} settings read, each written by ${writerName}).`,
);
