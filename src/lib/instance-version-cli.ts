import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * A phis CLI belongs to exactly one server instance. Running an older one against a newer
 * root writes formats the instance has moved past, so every root records which phis last
 * operated on it.
 */
export type PhiInstanceStamp = {
  formatVersion: 1;
  phisVersion: string;
};

export type PhiInstanceVersionCheck =
  | { status: "unstamped" }
  | { status: "match"; version: string }
  | { status: "ahead"; rootVersion: string }
  | { status: "behind"; rootVersion: string };

export function resolvePhiInstanceStampPath(root: string) {
  return path.join(path.resolve(root), "config", "phis-instance.json");
}

/** A directory only counts as a root once it carries a phis configuration. */
function isPhiRoot(root: string) {
  const configDirectory = path.join(path.resolve(root), "config");
  return (
    existsSync(path.join(configDirectory, "phis-config.json")) ||
    existsSync(path.join(configDirectory, "phis-runtime.json"))
  );
}

export function readPhiInstanceStamp(root: string): PhiInstanceStamp | null {
  const stampPath = resolvePhiInstanceStampPath(root);
  if (!existsSync(stampPath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(stampPath, "utf8")) as Partial<PhiInstanceStamp>;
    if (parsed.formatVersion !== 1) return null;
    if (typeof parsed.phisVersion !== "string" || !parsed.phisVersion) return null;
    return { formatVersion: 1, phisVersion: parsed.phisVersion };
  } catch {
    return null;
  }
}

/** Best effort: a read-only root must not turn a working command into a failure. */
export function writePhiInstanceStamp(root: string, phisVersion: string) {
  if (!isPhiRoot(root)) return;

  const stampPath = resolvePhiInstanceStampPath(root);
  try {
    mkdirSync(path.dirname(stampPath), { recursive: true });
    const stamp: PhiInstanceStamp = { formatVersion: 1, phisVersion };
    writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`, "utf8");
  } catch {
    // ignored
  }
}

function versionCore(version: string) {
  const [core = ""] = version.split("-");
  const parts = core.split(".").map((part) => Number.parseInt(part, 10));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0] as const;
}

/** Negative when a precedes b, positive when a follows b, zero when the cores match. */
export function comparePhiVersions(a: string, b: string) {
  const left = versionCore(a);
  const right = versionCore(b);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function checkPhiInstanceVersion(
  root: string,
  cliVersion: string,
): PhiInstanceVersionCheck {
  const stamp = readPhiInstanceStamp(root);
  if (!stamp) return { status: "unstamped" };

  const ordering = comparePhiVersions(cliVersion, stamp.phisVersion);
  if (ordering < 0) return { status: "behind", rootVersion: stamp.phisVersion };
  if (ordering > 0) return { status: "ahead", rootVersion: stamp.phisVersion };
  if (stamp.phisVersion !== cliVersion) return { status: "ahead", rootVersion: stamp.phisVersion };
  return { status: "match", version: stamp.phisVersion };
}
