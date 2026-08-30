import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Whether anything in a distributed dependency closure carries obligations we have not accepted.
 *
 * The licence question is not answered once. It is answered on the day someone adds a dependency, and
 * the answer is only visible if something looks. A single copyleft package that reaches a built
 * artifact changes what the whole product may be licensed as -- and it arrives silently, as a
 * transitive dependency of something entirely reasonable.
 *
 * Two decisions shape this check.
 *
 * It walks the *production* closure only. Build tooling is neither linked nor distributed, so its
 * terms do not reach an artifact: `cfonts` is GPL-3.0 and sits under `@ant-design/cli`, and that is
 * fine forever. Development findings are reported, never fatal.
 *
 * Accepted exceptions are listed here in the source, not in a data file, so that accepting one is a
 * diff someone reviews. Today there is exactly one: libvips, which `sharp` loads and which Next.js
 * pulls in on its own. Everything else that is not permissive fails the check.
 */

export type PhiLicenseClass = "permissive" | "weak-copyleft" | "strong-copyleft" | "unknown";

export type PhiLicenseScope = "production" | "development";

export type PhiLicenseFinding = {
  name: string;
  version: string;
  license: string;
  licenseClass: PhiLicenseClass;
  scope: PhiLicenseScope;
  acknowledged: string | null;
};

export type PhiLicenseReport = {
  packageName: string;
  packageDir: string;
  scannedProduction: number;
  scannedDevelopment: number;
  findings: PhiLicenseFinding[];
  blocking: PhiLicenseFinding[];
};

/**
 * Obligations we have looked at and accepted. The value is the reason, and it is printed, so it has to
 * hold up on its own. A prefix ending in `-` matches a family of platform packages.
 */
const ACKNOWLEDGED: readonly { prefix: string; reason: string }[] = [
  {
    prefix: "@img/sharp-libvips-",
    reason:
      "libvips under LGPLv3, shipped prebuilt and loaded dynamically by sharp, unmodified and replaceable. " +
      "Next.js declares sharp as an optionalDependency, so it is in the tree either way. " +
      "See THIRD-PARTY-NOTICES.md.",
  },
  {
    prefix: "caniuse-lite",
    reason:
      "Browser support data under CC-BY-4.0, a production dependency of next and browserslist. " +
      "Attribution is the whole of the obligation and it is given in THIRD-PARTY-NOTICES.md.",
  },
];

const PERMISSIVE = new Set(
  [
    "0BSD", "APACHE-2.0", "ARTISTIC-2.0", "BLUEOAK-1.0.0", "BSD", "BSD-2-CLAUSE", "BSD-3-CLAUSE",
    "BSL-1.0", "CC0-1.0", "ISC", "MIT", "MIT-0", "POSTGRESQL", "PYTHON-2.0", "UNLICENSE", "WTFPL",
    "ZLIB",
  ],
);

const WEAK_COPYLEFT = /^(LGPL|MPL-|CDDL|EPL-|MS-PL|OSL-)/;
const STRONG_COPYLEFT = /^(GPL-|AGPL|SSPL|EUPL|CPAL|BUSL|ELASTIC-|POLYFORM|CC-BY-NC|CC-BY-SA)/;

/** Attribution-only data licences. Not copyleft, but they do carry a duty, so they are not silent. */
const ATTRIBUTION = /^CC-BY-(?!NC|SA)/;

function classifyAtom(atom: string): PhiLicenseClass {
  const value = atom.trim().replace(/^\(|\)$/g, "").replace(/\+$/, "").toUpperCase();
  if (!value) return "unknown";
  if (PERMISSIVE.has(value)) return "permissive";
  if (STRONG_COPYLEFT.test(value)) return "strong-copyleft";
  if (WEAK_COPYLEFT.test(value)) return "weak-copyleft";
  if (ATTRIBUTION.test(value)) return "weak-copyleft";
  return "unknown";
}

const ORDER: Record<PhiLicenseClass, number> = {
  permissive: 0,
  unknown: 1,
  "weak-copyleft": 2,
  "strong-copyleft": 3,
};

/**
 * Classify an SPDX expression. `OR` is a choice we get to make, so the mildest branch wins -- a package
 * offered as "MIT OR GPL-3.0" may be taken as MIT. `AND` is cumulative, so the strictest branch wins.
 */
export function classifyPhiLicenseExpression(expression: string | null): PhiLicenseClass {
  if (!expression) return "unknown";
  const orBranches = expression.split(/\s+OR\s+/i);
  let best: PhiLicenseClass = "strong-copyleft";
  for (const branch of orBranches) {
    let worst: PhiLicenseClass = "permissive";
    for (const atom of branch.split(/\s+AND\s+/i)) {
      const klass = classifyAtom(atom);
      if (ORDER[klass] > ORDER[worst]) worst = klass;
    }
    if (ORDER[worst] < ORDER[best]) best = worst;
  }
  return best;
}

type PackageJson = {
  name?: string;
  version?: string;
  license?: unknown;
  licenses?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function readPackageJson(directory: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

function licenseOf(pkg: PackageJson): string | null {
  let value: unknown = pkg.license ?? pkg.licenses;
  if (Array.isArray(value)) {
    value = value
      .map((entry) => (typeof entry === "string" ? entry : (entry as { type?: string })?.type))
      .filter(Boolean)
      .join(" OR ");
  }
  if (value && typeof value === "object") value = (value as { type?: string }).type;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Resolve a dependency the way Node does: look in the importer's own `node_modules`, then walk up. In a
 * pnpm tree the first hit is the right one, because each package's `node_modules` holds symlinks to
 * exactly what it declared. The real path is what identifies a package -- two importers reaching the
 * same version must not be counted twice.
 */
function resolveDependencyDir(fromDir: string, name: string): string | null {
  let directory = fromDir;
  for (;;) {
    const candidate = path.join(directory, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) {
      try {
        return realpathSync(candidate);
      } catch {
        return candidate;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function acknowledgementFor(name: string): string | null {
  for (const entry of ACKNOWLEDGED) {
    if (name === entry.prefix || name.startsWith(entry.prefix)) return entry.reason;
  }
  return null;
}

function collect(rootDir: string, names: readonly string[], seen: Map<string, string>) {
  const queue = [...names.map((name) => ({ name, from: rootDir }))];
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    const directory = resolveDependencyDir(item.from, item.name);
    if (!directory || seen.has(directory)) continue;
    const pkg = readPackageJson(directory);
    if (!pkg?.name || !pkg.version) continue;
    seen.set(directory, `${pkg.name}@${pkg.version}`);
    const next = { ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) };
    for (const name of Object.keys(next)) queue.push({ name, from: directory });
  }
}

/** The repository this CLI belongs to: the nearest ancestor that is itself a named package. */
function ownPackageDir(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (readPackageJson(directory)?.name) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return process.cwd();
    directory = parent;
  }
}

export function checkPhiDependencyLicenses(options?: { packageDir?: string }): PhiLicenseReport {
  const packageDir = path.resolve(options?.packageDir ?? ownPackageDir());
  const pkg = readPackageJson(packageDir);
  if (!pkg?.name) throw new Error(`No package.json with a name at ${packageDir}.`);

  const production = new Map<string, string>();
  collect(packageDir, Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) }), production);

  const development = new Map<string, string>();
  collect(packageDir, Object.keys(pkg.devDependencies ?? {}), development);
  for (const directory of production.keys()) development.delete(directory);

  const findings: PhiLicenseFinding[] = [];
  for (const [scope, tree] of [["production", production], ["development", development]] as const) {
    for (const directory of tree.keys()) {
      const dependency = readPackageJson(directory);
      if (!dependency?.name || !dependency.version) continue;
      const license = licenseOf(dependency);
      const licenseClass = classifyPhiLicenseExpression(license);
      if (licenseClass === "permissive") continue;
      findings.push({
        name: dependency.name,
        version: dependency.version,
        license: license ?? "(none declared)",
        licenseClass,
        scope,
        acknowledged: acknowledgementFor(dependency.name),
      });
    }
  }

  findings.sort(
    (a, b) =>
      ORDER[b.licenseClass] - ORDER[a.licenseClass] ||
      a.scope.localeCompare(b.scope) ||
      a.name.localeCompare(b.name),
  );

  return {
    packageName: pkg.name,
    packageDir,
    scannedProduction: production.size,
    scannedDevelopment: development.size,
    findings,
    blocking: findings.filter((finding) => finding.scope === "production" && !finding.acknowledged),
  };
}
