import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { describe, expect, it } from "vitest";

import {
  checkPhiConfiguredDirectory,
  describePhiConfiguredDirectoryProblems,
  ensurePhiConfiguredDirectories,
  listPhiConfiguredDirectories,
  PHI_MEDIA_ROOT_MODE,
  PHI_SITE_ROOT_MODE,
  readPhiAccountName,
  resolvePhiServiceAccount,
} from "./configured-directories.ts";
import {
  DEFAULT_CONFIG,
  PHIS_DEFAULT_MEDIA_ROOT,
  PHIS_DEFAULT_SITE_INSTANCE_ROOT,
  PHIS_DEFAULT_SITE_SOURCE_ROOT,
} from "./config-core.ts";
import staticConfig from "../../config/phis-config.json" with { type: "json" };

const self = { uid: process.getuid!(), gid: process.getgid!() };

function scratch() {
  return mkdtempSync(path.join(tmpdir(), "phis-directories-"));
}

function configFor(root: string) {
  return {
    media: { local: { rootDir: path.join(root, "media") } },
    sites: { sourcePathRoot: path.join(root, "sites"), instancePathRoot: path.join(root, "nested", "instances") },
  };
}

describe("the configured directories", () => {
  it("default to the host layout, in the code and in the shipped static file alike", () => {
    expect([PHIS_DEFAULT_MEDIA_ROOT, PHIS_DEFAULT_SITE_SOURCE_ROOT, PHIS_DEFAULT_SITE_INSTANCE_ROOT])
      .toEqual(["/srv/phis/media", "/srv/phis/sites", "/srv/phis/instances"]);
    expect(listPhiConfiguredDirectories(DEFAULT_CONFIG).map((entry) => entry.path))
      .toEqual(["/srv/phis/media", "/srv/phis/sites", "/srv/phis/instances"]);
    expect(staticConfig.media.local.rootDir).toBe(PHIS_DEFAULT_MEDIA_ROOT);
    expect(staticConfig.sites.sourcePathRoot).toBe(PHIS_DEFAULT_SITE_SOURCE_ROOT);
    expect(staticConfig.sites.instancePathRoot).toBe(PHIS_DEFAULT_SITE_INSTANCE_ROOT);
  });

  it("leaves out a path that is empty or relative", () => {
    const listed = listPhiConfiguredDirectories({
      media: { local: { rootDir: " " } },
      sites: { sourcePathRoot: "relative/sites", instancePathRoot: "/srv/x/../phis/instances/" },
    });
    expect(listed).toEqual([
      { key: "instances", setting: "sites.instancePathRoot", path: "/srv/phis/instances", mode: PHI_SITE_ROOT_MODE },
    ]);
  });

  it("are created with their modes when missing, and only checked the next time", () => {
    const root = scratch();
    const directories = listPhiConfiguredDirectories(configFor(root));
    const first = ensurePhiConfiguredDirectories(directories, self);
    expect(first.map((result) => [result.key, result.created, result.ok])).toEqual([
      ["media", true, true],
      ["sources", true, true],
      ["instances", true, true],
    ]);
    expect(statSync(path.join(root, "media")).mode & 0o777).toBe(PHI_MEDIA_ROOT_MODE);
    expect(statSync(path.join(root, "sites")).mode & 0o777).toBe(PHI_SITE_ROOT_MODE);
    expect(statSync(path.join(root, "nested", "instances")).isDirectory()).toBe(true);

    const second = ensurePhiConfiguredDirectories(directories, self);
    expect(second.every((result) => !result.created && result.ok)).toBe(true);
    expect(describePhiConfiguredDirectoryProblems(second)).toEqual([]);
  });

  it("are not created for another account by one that is not root", () => {
    if (self.uid === 0) return;
    const root = scratch();
    const other = { uid: self.uid + 1, gid: self.gid + 1 };
    const [media] = ensurePhiConfiguredDirectories(listPhiConfiguredDirectories(configFor(root)), other);
    expect(media!.created).toBe(false);
    expect(media!.exists).toBe(false);
    expect(media!.error).toMatch(/run phis install as root/u);
    expect(describePhiConfiguredDirectoryProblems([media!])).toEqual([media!.error]);
  });

  it("report what is wrong with one that exists", () => {
    const root = scratch();
    const [media, sources] = listPhiConfiguredDirectories(configFor(root));
    expect(checkPhiConfiguredDirectory(media!, self).detail).toMatch(/does not exist \(phis install/u);

    writeFileSync(media!.path, "");
    const file = checkPhiConfiguredDirectory(media!, self);
    expect([file.ok, file.exists, file.isDirectory]).toEqual([false, true, false]);
    expect(file.detail).toMatch(/is not a directory/u);

    mkdirSync(sources!.path, { mode: 0o555 });
    const readOnly = checkPhiConfiguredDirectory(sources!, self);
    if (self.uid !== 0) {
      expect(readOnly.ok).toBe(false);
      expect(readOnly.writable).toBe(false);
      expect(readOnly.detail).toMatch(/not writable by the service account/u);
    }

    const foreign = checkPhiConfiguredDirectory(sources!, { uid: self.uid + 1, gid: self.gid + 1 });
    expect(foreign.ok).toBe(false);
    expect(foreign.detail).toMatch(new RegExp(`owned by ${self.uid}:${self.gid}, not the service account`, "u"));
  });

  it("belong to the owner of the stage's config directory", () => {
    const root = scratch();
    mkdirSync(path.join(root, "config"));
    expect(resolvePhiServiceAccount(path.join(root, "config"))).toEqual(self);
  });
});

describe("readPhiAccountName", () => {
  const passwd = "root:x:0:0:root:/root:/bin/bash\nphis:x:126:134::/nonexistent:/usr/sbin/nologin\n";
  const read = (() => passwd) as unknown as typeof import("node:fs").readFileSync;

  it("names the account an id belongs to, so a hint reads -o phis", () => {
    expect(readPhiAccountName("/etc/passwd", 126, read)).toBe("phis");
  });

  it("keeps the number where the file names no such account, or cannot be read", () => {
    expect(readPhiAccountName("/etc/passwd", 999, read)).toBe("999");
    const missing = (() => {
      throw new Error("ENOENT");
    }) as unknown as typeof import("node:fs").readFileSync;
    expect(readPhiAccountName("/etc/group", 134, missing)).toBe("134");
  });
});
