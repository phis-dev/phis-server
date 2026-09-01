import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * That `phis` still starts.
 *
 * The CLI is a plain Node process and the application it belongs to is not: a module marked
 * `server-only` resolves inside Next and throws `ERR_MODULE_NOT_FOUND` here. TypeScript sees nothing
 * wrong with the import, so nothing but running it catches this -- and it fails at the first line, on
 * every command at once.
 */
describe("the phis CLI", () => {
  it("loads and prints its usage", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        "--experimental-strip-types",
        path.join(import.meta.dirname, "phis.mts"),
        "--help",
      ],
      { encoding: "utf8", timeout: 60_000 },
    );
    expect(output).toMatch(/phis addon role/);
    expect(output).toMatch(/phis module check/);
  });
});
