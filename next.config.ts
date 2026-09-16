import type { NextConfig } from "next";

import { version } from "./package.json";

const nextConfig: NextConfig = {
  output: "standalone",
  /*
   * What this build reports as its release.
   *
   * A capability response carries it so that when one instance answers for an Add-on its neighbours
   * do not have, the answer says which build that was. The package version is what identifies the
   * code that was shipped -- it is what `dpkg -l phis` shows and what every host serving the same
   * release has in common -- so it is taken here rather than passed in at start-up, where it would be
   * one more thing to keep true by hand.
   */
  env: {
    PHIS_RELEASE_ID: version,
  },
  // What ships from the standalone output is chosen by name in `debian/rules`, not excluded here: the
  // tracer copies the whole checkout through the instrumentation trace, which these excludes never
  // reached -- the install root, sources, tests and config all travelled with them in place.
  reactCompiler: true,
  /*
   * The font cutter's two WebAssembly packages run from `node_modules` rather than from the bundle: a
   * bundler that inlines them loses the files they load at run time. The subset module is read by path,
   * which file tracing cannot see through, so the one route that cuts names it for the standalone output.
   */
  serverExternalPackages: ["harfbuzzjs", "wawoff2"],
  outputFileTracingIncludes: {
    // A glob against the route path, where `[id]` would be a character class: the segments are wildcards.
    "/api/site/media/*/subsets/*": ["./node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm"],
  },
  experimental: {
    externalDir: true,
  },
};

export default nextConfig;
