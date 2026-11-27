import { chmodSync, readFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const outfile = path.join(root, "dist", "phis.mjs");

// Runtime dependencies stay external -- some are native (argon2, sharp) and none of them
// can be inlined safely. The `@phis` siblings are the exception: `@phis/contracts` is constants,
// validators and types, and the bundle must resolve them wherever it is put down -- a Debian install
// root, a global npm prefix, a checkout -- none of which is obliged to have a node_modules entry beside
// it. Recognised by the scope and not by a `workspace:` range: the range became a released version when the
// package started naming its sibling the way a published package must, which said nothing about the bundle.
//
// What stays external must also be there at run time, and in the Debian package that is only what the
// server's own trace left in `node_modules`. A package the Next build inlines into its chunks leaves nothing
// there: `nodemailer` is one, so in 0.3.1 every CLI command failed on its import while the server ran. Such a
// package is inlined here too. `debian/rules` loads the installed bundle once, so the next one fails the
// package build rather than the operator's first command.
const inlined = new Set(["nodemailer"]);
const external = Object.entries(packageJson.dependencies ?? {})
  .filter(([name]) => !name.startsWith("@phis/") && !inlined.has(name))
  .map(([name]) => name);

await build({
  entryPoints: [path.join(root, "src", "cli", "phis.mts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external,
  // esbuild keeps the entry point's own hashbang -- a hashbang in the banner duplicates it. The banner gives
  // the inlined CommonJS (`nodemailer`) the `require` an ES module lacks, for its `require("events")` and
  // the other Node built-ins.
  banner: {
    js: 'import { createRequire as __phisCreateRequire } from "node:module"; const require = __phisCreateRequire(import.meta.url);',
  },
  logLevel: "info",
});

chmodSync(outfile, 0o755);
