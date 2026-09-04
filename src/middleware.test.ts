import { readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PHIS_BROWSER_ROUTE_PREFIXES } from "./middleware";

/**
 * The list of browser routes against the pages that exist.
 *
 * The middleware refuses everything it does not name, which is how three shipped pages came to answer
 * `404` in production builds only. This is the check that was missing: a page added under `src/app`
 * either appears in the list or fails here, rather than in a package nobody has built yet.
 */

const APP_DIR = path.join(import.meta.dirname, "app");

function topLevelPageRoutes() {
  return readdirSync(APP_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "api")
    .filter((entry) =>
      readdirSync(path.join(APP_DIR, entry.name)).some((file) => file === "page.tsx"),
    )
    .map((entry) => `/${entry.name}`);
}

describe("browser routes", () => {
  it("names every page under src/app that is not an API route", () => {
    expect([...PHIS_BROWSER_ROUTE_PREFIXES].sort()).toEqual(topLevelPageRoutes().sort());
  });
});
