import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
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
  allowedDevOrigins: ["phi-systems.ch", "phi-systems.ch:3000", "*.phi-systems.ch"],
  experimental: {
    externalDir: true,
  },
};

export default nextConfig;
