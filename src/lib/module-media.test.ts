import { describe, expect, it } from "vitest";

import { orderPhisModuleMediaFolders, parsePhisModuleMediaManifest } from "./module-media";

const PKG = "@acme/pictures";

function parse(media: unknown) {
  return parsePhisModuleMediaManifest(PKG, { media });
}

const valid = {
  folders: [
    { key: "shots", name: "Screenshots", parent: "root" },
    { key: "root", name: "Acme" },
  ],
  files: [{ key: "icon", file: "dist/media/icon.png", folder: "root", alt: "Acme icon", title: "Icon" }],
};

describe("the Module media declaration", () => {
  it("reads a valid declaration, and nothing at all where there is none", () => {
    expect(parse(valid)).toEqual({
      manifest: {
        folders: [
          { key: "shots", name: "Screenshots", parent: "root" },
          { key: "root", name: "Acme", parent: null },
        ],
        files: [{ key: "icon", file: "dist/media/icon.png", folder: "root", alt: "Acme icon", title: "Icon" }],
      },
      issues: [],
    });
    expect(parsePhisModuleMediaManifest(PKG, undefined)).toEqual({ manifest: null, issues: [] });
    expect(parsePhisModuleMediaManifest(PKG, { modules: [] })).toEqual({ manifest: null, issues: [] });
  });

  it("names the package and the key of every violation, and reports all of them", () => {
    const { manifest, issues } = parse({
      folders: [{ key: "Bad_Key", name: "x" }, { key: "a", name: "A", parent: "missing" }],
      files: [
        { key: "f", file: "../outside.png", alt: "x" },
        { key: "g", file: "/etc/passwd", alt: "x" },
        { key: "h", file: "ok.png" },
      ],
    });
    expect(manifest).toBeNull();
    expect(issues.length).toBeGreaterThanOrEqual(5);
    expect(issues.every((line) => line.startsWith(`${PKG}: `))).toBe(true);
    expect(issues.join("\n")).toMatch(/Bad_Key/);
    expect(issues.join("\n")).toMatch(/folder "a".*parent "missing"/);
    expect(issues.join("\n")).toMatch(/\(key "f"\).*\.\./);
    expect(issues.join("\n")).toMatch(/\(key "g"\).*absolute/);
    expect(issues.join("\n")).toMatch(/\(key "h"\).*`alt`/);
  });

  it("keeps keys unique across folders and files", () => {
    const { issues } = parse({
      folders: [{ key: "dup", name: "D" }, { key: "dup", name: "E" }],
      files: [{ key: "dup", file: "a.png", alt: "a" }],
    });
    expect(issues.filter((line) => /already used/.test(line))).toHaveLength(2);
    expect(issues.join("\n")).toMatch(/a folder of this package/);
  });

  it("refuses keys outside lowercase letters, digits and hyphens", () => {
    for (const key of ["UPPER", "with space", "under_score", "-lead", "", "x".repeat(65)]) {
      expect(parse({ files: [{ key, file: "a.png", alt: "a" }] }).manifest, key).toBeNull();
    }
    expect(parse({ files: [{ key: "a-b-9", file: "a.png", alt: "a" }] }).manifest).not.toBeNull();
  });

  it("refuses a parent or folder that is not a declared folder key, and parent cycles", () => {
    expect(parse({ files: [{ key: "a", file: "a.png", alt: "a", folder: "nope" }] }).issues.join()).toMatch(/folder "nope"/);
    // A file's key is not a folder key.
    expect(parse({
      folders: [{ key: "f", name: "F", parent: "a" }],
      files: [{ key: "a", file: "a.png", alt: "a" }],
    }).issues.join()).toMatch(/parent "a" is not a declared folder key/);
    const cycle = parse({ folders: [{ key: "a", name: "A", parent: "b" }, { key: "b", name: "B", parent: "a" }] });
    expect(cycle.issues.join()).toMatch(/cycle/);
    expect(parse({ folders: [{ key: "a", name: "A", parent: "a" }] }).issues.join()).toMatch(/cycle/);
  });

  it("is strict about shape: unknown properties, wrong types", () => {
    expect(parse("x").issues.join()).toMatch(/must be an object/);
    expect(parse({ fonts: [] }).issues.join()).toMatch(/unknown property "fonts"/);
    expect(parse({ files: {} }).issues.join()).toMatch(/must be an array/);
    expect(parse({ files: [{ key: "a", file: "a.png", alt: "a", extra: 1 }] }).issues.join()).toMatch(/unknown property "extra"/);
    expect(parse({ files: ["a"] }).issues.join()).toMatch(/must be an object/);
  });

  it("puts every parent before its children", () => {
    const ordered = orderPhisModuleMediaFolders(parse(valid).manifest!.folders).map((folder) => folder.key);
    expect(ordered).toEqual(["root", "shots"]);
  });
});
