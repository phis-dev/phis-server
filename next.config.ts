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
  outputFileTracingExcludes: {
    "/*": [
      // The install root is deployment state, not build output. An Add-on that travelled inside the
      // image would be back to being compiled in, which is the one thing this must never be.
      "./addons/**/*",
      "./debian/**/*",
      "./docs/**/*",
      "./AGENTS.md",
      "./DB.md",
      "./Roadmap.md",
    ],
  },
  reactCompiler: true,
  experimental: {
    externalDir: true,
  },
};

export default nextConfig;
