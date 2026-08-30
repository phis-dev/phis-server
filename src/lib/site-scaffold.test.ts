import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildPhiSiteScaffoldFiles,
  reconcilePhiSiteScaffold,
} from "./site-scaffold.mts";

const roots: string[] = [];
const context = {
  siteKey: "example-site",
  publicBaseUrl: "https://example.test",
  apiBaseUrl: "https://api.example.test",
  internalToken: "server-secret",
  packageManager: "pnpm" as const,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("site scaffold", () => {
  it("generates every canonical route family and exact dependencies", () => {
    const files = buildPhiSiteScaffoldFiles(context);
    expect(files["src/app/[root]/[[...path]]/page.tsx"]).toContain("createPhiNextDynamicRootPage");
    expect(files["src/app/admin/@drawer/[[...path]]/page.tsx"]).toContain("PhiCmsRegionType.Drawer");
    expect(files["src/app/api/site/forms/route.ts"]).toContain("buildPhiSiteFormRouteHandlers");
    expect(JSON.parse(files["package.json"]!).dependencies["@phis/ui"]).toBe("0.1.0");
  });

  it("repairs managed wrappers without overwriting runtime secrets or unknown files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "phis-scaffold-"));
    roots.push(root);
    await reconcilePhiSiteScaffold(root, context, "init");
    await writeFile(path.join(root, "src/app/page.tsx"), "broken\n", "utf8");
    await writeFile(path.join(root, "config/site-runtime.json"), "{\"secret\":true}\n", "utf8");
    await writeFile(path.join(root, "SITE_OWNED.txt"), "keep\n", "utf8");
    const result = await reconcilePhiSiteScaffold(root, context, "reconcile");
    expect(result.changes.find((entry) => entry.path === "src/app/page.tsx")?.action).toBe("repaired");
    expect(await readFile(path.join(root, "src/app/page.tsx"), "utf8")).toContain("PhiNextSiteIndexPage");
    expect(await readFile(path.join(root, "config/site-runtime.json"), "utf8")).toBe("{\"secret\":true}\n");
    expect(await readFile(path.join(root, "SITE_OWNED.txt"), "utf8")).toBe("keep\n");
  });

  it("refuses init over a non-empty target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "phis-scaffold-"));
    roots.push(root);
    await writeFile(path.join(root, "existing"), "x", "utf8");
    await expect(reconcilePhiSiteScaffold(root, context, "init")).rejects.toThrow(/use phis reconcile/);
  });
});
