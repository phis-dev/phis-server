import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PHIS_OPERATOR_SURFACES } from "./operator-surfaces";

/**
 * The declaration against the file system.
 *
 * A page reachable in a browser is a decision, and this is what makes it one. Both halves have to
 * hold: a page outside `(operator)` never passes a gate, and a surface inside it without a layout that
 * calls the guard has a gate its pages walk around. The predecessor of this table was a middleware
 * that ran on every request and still refused three shipped pages for months, because the decision
 * lived nowhere near what it decided and nothing compared the two.
 */

const APP_DIR = path.join(import.meta.dirname, "..", "app");
const GROUP_DIR = path.join(APP_DIR, "(operator)");

/** Route groups and private folders do not become URL segments; anything else does. */
function isRouteSegment(name: string) {
  return !name.startsWith("(") && !name.startsWith("_") && !name.startsWith("@");
}

function pagesUnder(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === "page.tsx") {
      found.push(prefix || "/");
      continue;
    }
    if (!entry.isDirectory()) {
      continue;
    }
    const next = isRouteSegment(entry.name) ? `${prefix}/${entry.name}` : prefix;
    found.push(...pagesUnder(path.join(dir, entry.name), next));
  }
  return found;
}

describe("operator surfaces", () => {
  it("routes every page except the landing page through the gated group", () => {
    const outside = readdirSync(APP_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isRouteSegment(entry.name) && entry.name !== "api")
      .flatMap((entry) => pagesUnder(path.join(APP_DIR, entry.name), `/${entry.name}`));

    expect(outside).toEqual([]);
  });

  it("declares exactly the surfaces the group holds", () => {
    const directories = readdirSync(GROUP_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(directories.sort()).toEqual(Object.keys(PHIS_OPERATOR_SURFACES).sort());
  });

  it("gates each surface from its own layout, which its pages cannot skip", () => {
    for (const surface of Object.keys(PHIS_OPERATOR_SURFACES)) {
      const layout = path.join(GROUP_DIR, surface, "layout.tsx");
      expect(readFileSync(layout, "utf8")).toContain(
        `requirePhisOperatorSurface("${surface}")`,
      );
    }
  });
});
