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
const external = Object.entries(packageJson.dependencies ?? {})
  .filter(([name]) => !name.startsWith("@phis/"))
  .map(([name]) => name);

await build({
  entryPoints: [path.join(root, "src", "cli", "phis.mts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external,
  // esbuild keeps the entry point's own hashbang -- adding a banner duplicates it.
  logLevel: "info",
});

chmodSync(outfile, 0o755);
