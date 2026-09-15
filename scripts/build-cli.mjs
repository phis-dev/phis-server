import { chmodSync, readFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const outfile = path.join(root, "dist", "phis.mjs");

// Runtime dependencies stay external -- some are native (argon2, sharp) and none of them
// can be inlined safely. Workspace packages are the exception: `@phis/contracts` is constants,
// validators and types, and the package has no node_modules entry that could resolve it.
const external = Object.entries(packageJson.dependencies ?? {})
  .filter(([, version]) => !String(version).startsWith("workspace:"))
  .map(([name]) => name);

await build({
  entryPoints: [path.join(root, "src", "cli", "phis.mts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external,
  // esbuild keeps the entry point's own hashbang -- adding a banner duplicates it.
  logLevel: "info",
});

chmodSync(outfile, 0o755);
