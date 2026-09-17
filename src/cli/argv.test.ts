import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parsePhisArgv, PHIS_COMMAND_FLAGS, SHORT_FLAG_ALIASES } from "./argv.mts";

describe("the phis command line", () => {
  it("takes a value that starts with a dash as the value", () => {
    const parsed = parsePhisArgv(["operator", "add", "--email", "ops@example.test", "--password", "-x1"]);
    expect(parsed.flags.get("password")).toBe("-x1");

    const short = parsePhisArgv(["operator", "passwd", "-e", "ops@example.test", "-p", "--not-a-flag"]);
    expect(short.flags.get("password")).toBe("--not-a-flag");
  });

  it("reads --flag=value, including an empty value and one that starts with a dash", () => {
    const parsed = parsePhisArgv(["operator", "add", "--email=ops@example.test", "--password=-x=y"]);
    expect(parsed.flags.get("email")).toBe("ops@example.test");
    expect(parsed.flags.get("password")).toBe("-x=y");

    // An empty string is a value: `addon config` must not read it as "clear the setting".
    expect(parsePhisArgv(["addon", "config", "--addon", "@a/b", "--site", "s", "--name", "n", "--value="])
      .flags.get("value")).toBe("");
    expect(parsePhisArgv(["addon", "config", "--addon", "@a/b", "--site", "s", "--name", "n", "--value", ""])
      .flags.get("value")).toBe("");
  });

  it("refuses a flag the command does not read", () => {
    expect(() => parsePhisArgv(["site", "add", "--key", "acme", "--hostnmae", "x"]))
      .toThrow(/phis site add does not take --hostnmae/);
    // `reconcile` never writes the Site's runtime config, so it has no use for Core's address.
    expect(() => parsePhisArgv(["reconcile", "acme", "--api-base-url", "http://127.0.0.1:5301"]))
      .toThrow(/does not take --api-base-url/);
    expect(() => parsePhisArgv(["site", "list", "-x"])).toThrow(/Unknown flag: -x/);
  });

  it("reads a flag by its command, where one name is a switch in one place and a value in another", () => {
    expect(parsePhisArgv(["site", "admin", "--site", "s", "--email", "a@b.test", "--revoke"]).flags.get("revoke"))
      .toBe(true);
    expect(parsePhisArgv(["addon", "role", "--site", "s", "--revoke", "editor"]).flags.get("revoke"))
      .toBe("editor");
  });

  it("keeps a word after a switch as a positional, and refuses a value on a switch", () => {
    const parsed = parsePhisArgv(["init", "--install", "acme", "--api-base-url", "http://127.0.0.1:5301"]);
    expect(parsed.positionals).toEqual(["init", "acme"]);
    expect(parsed.flags.get("install")).toBe(true);
    expect(() => parsePhisArgv(["schema", "drop", "--force=yes"])).toThrow(/switch and takes no value/);
  });

  it("refuses a value flag with nothing after it", () => {
    expect(() => parsePhisArgv(["site", "list", "--key"])).toThrow(/--key needs a value/);
  });

  it("accepts the global flags before the command", () => {
    const parsed = parsePhisArgv(["-j", "--root", "/srv/phis/stages/prod", "site", "list"]);
    expect(parsed.command).toBe("site list");
    expect(parsed.flags.get("json")).toBe(true);
    expect(parsed.flags.get("root")).toBe("/srv/phis/stages/prod");
  });

  it("hands a line no command matches on to the dispatcher", () => {
    const parsed = parsePhisArgv(["nonsense", "--whatever", "x"]);
    expect(parsed.command).toBeNull();
    expect(parsed.positionals).toEqual(["nonsense"]);
  });

  /*
   * The table is only as good as its agreement with the code. Every flag the dispatcher and its helpers
   * read has to be listed for some command, or that command refuses a flag it needs.
   */
  it("lists every flag the CLI reads", () => {
    const listed = new Set([
      "json",
      "root",
      ...Object.values(PHIS_COMMAND_FLAGS).flatMap((spec) => Object.keys(spec)),
    ]);
    const read = new Set<string>();
    for (const file of ["phis.mts", "addons.mts", "storage.mts"]) {
      const source = readFileSync(path.join(import.meta.dirname, file), "utf8");
      for (const match of source.matchAll(
        /(?:flags\.(?:get|has)|get(?:Optional|Required)Flag|require(?:Flag)?|readSecondsFlag|getSiteSupportEmailFlag)\((?:flags, )?"([a-z][a-z-]*)"/g,
      )) {
        read.add(match[1]);
      }
    }
    expect(read.size).toBeGreaterThan(40);
    expect([...read].filter((name) => !listed.has(name))).toEqual([]);
    for (const alias of SHORT_FLAG_ALIASES.values()) {
      expect(listed.has(alias), alias).toBe(true);
    }
  });
});
