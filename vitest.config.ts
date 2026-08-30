import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": `${root}src`,
      "server-only": `${root}test/server-only.ts`,
    },
  },
  test: {
    environment: "node",
    clearMocks: true,
    // The integration suite needs a live database and its own single-threaded config.
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.pg.test.ts"],
  },
});
