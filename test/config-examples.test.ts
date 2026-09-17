import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { readMergedPhiConfigSync, validatePhiConfig } from "../src/lib/config-core.ts";

const configDirectory = path.join(import.meta.dirname, "..", "config");

/*
 * An example is what an operator copies. One the validator refuses sends them to `phis config validate`
 * with an error the example itself put there -- `auth.secrets` did exactly that.
 */
describe("the example configuration files", () => {
  const examples = readdirSync(configDirectory).filter((name) => name.endsWith(".example.json"));

  it("exist", () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  // Read as `phis config validate` reads a root: defaults, the shipped static file, then the example.
  it.each(examples)("%s validates on top of the shipped phis-config.json", (name) => {
    const merged = readMergedPhiConfigSync({
      root: path.dirname(configDirectory),
      static: path.join(configDirectory, "phis-config.json"),
      runtime: path.join(configDirectory, name),
    });
    expect(validatePhiConfig(merged)).toEqual([]);
  });

  it("names the migration connection, which schema and Add-on commands refuse to run without", () => {
    const example = JSON.parse(readFileSync(path.join(configDirectory, "phis-runtime.example.json"), "utf8"));
    expect(example.database.migrationUri).toMatch(/^postgresql:\/\//);
  });
});
