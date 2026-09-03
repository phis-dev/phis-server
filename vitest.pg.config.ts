import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * The integration suite. It runs against the development database, so it runs single-file and
 * single-threaded: the fixtures share one database, and a second worker would contend with them for
 * the very rows a locking test is holding on purpose.
 */
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
    include: ["**/*.pg.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
    fileParallelism: false,
    pool: "threads",
    poolOptions: { threads: { singleThread: true } },
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
