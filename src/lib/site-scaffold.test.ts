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
    expect(files["src/app/[root]/(root)/page.tsx"]).toContain("createPhiNextDynamicRootPage");
    expect(files["src/app/[root]/(pages)/[...path]/page.tsx"]).toContain("createPhiNextDynamicRootPage");
    expect(files["src/app/admin/(pages)/@drawer/[...path]/page.tsx"]).toContain("PhiCmsRegionType.Drawer");
    expect(files["src/app/admin/(root)/@drawer/page.tsx"]).toContain("PhiCmsRegionType.Drawer");
    expect(files["src/app/api/site/forms/route.ts"]).toContain("buildPhiSiteFormRouteHandlers");
    /*
     * The door a Module half reaches its own Add-on half through. Without it a Site proxies `/api/site`
     * and `/api/auth` and nothing else, so every call an Add-on's surface makes ends at the Site's 404
     * page -- which is where the first one did.
     */
    expect(files["src/app/api/addons/[[...path]]/route.ts"]).toContain("buildPhiAddonProxyHandlers");
    /*
     * And the door an outside caller uses. Core is reachable on its own host, so this is not about
     * reachability but about which Site a request is for: a payment provider, an OAuth callback or
     * another Core fetching a listing cannot state one, and here the Site states itself.
     */
    const hooks = files["src/app/api/hooks/[[...path]]/route.ts"]!;
    expect(hooks).toContain("buildPhiHookProxyHandlers");
    // What arrives from the open internet must not pick up a claim to have come from inside.
    expect(hooks).toContain("{ internalToken: false }");
    expect(JSON.parse(files["package.json"]!).dependencies["@phis/ui"]).toBe("0.1.0");
  });

  it("draws the Shell below an Area root and nothing around the root itself", () => {
    const files = buildPhiSiteScaffoldFiles(context);

    expect(files["src/app/builder/(root)/layout.tsx"]).toContain('PHI_BUILDER_CMS_SITE_BRIDGE, "none"');
    expect(files["src/app/builder/(pages)/layout.tsx"]).toContain('PHI_BUILDER_CMS_SITE_BRIDGE, "shell"');
    expect(files["src/app/[root]/(root)/layout.tsx"]).toContain('PHI_PUBLIC_CMS_SITE_BRIDGE, "none"');
    expect(files["src/app/[root]/(pages)/layout.tsx"]).toContain('PHI_PUBLIC_CMS_SITE_BRIDGE, "shell"');

    // The Area's own Layout holds the guards and providers, and draws no Region of its own.
    expect(files["src/app/builder/layout.tsx"]).toContain("createPhiNextStaticAreaBoundary");
    expect(files["src/app/[root]/layout.tsx"]).toContain("createPhiNextDynamicRootBoundary");
  });

  it("leaves no optional catch-all that would swallow an Area root", () => {
    // An optional catch-all matches the Area root too, so it would collide with the root branch's page
    // -- and Next refuses both catch-all kinds at one level outright.
    const routes = Object.keys(buildPhiSiteScaffoldFiles(context)).filter((file) =>
      file.startsWith("src/app/") && file.endsWith("/page.tsx"),
    );

    expect(routes.some((file) => file.includes("[[...path]]"))).toBe(false);
    expect(routes.length).toBeGreaterThan(0);
  });

  it("ignores the runtime config, so a first commit cannot publish the internal token", async () => {
    const files = buildPhiSiteScaffoldFiles(context);
    const ignored = files[".gitignore"]!.split("\n");

    expect(ignored).toContain("config/site-runtime.json");
    expect(ignored).toContain("node_modules/");
    expect(ignored).toContain(".next/");
  });

  it("writes the ignore file once and leaves a Site's own entries alone", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "phis-scaffold-"));
    roots.push(root);
    await reconcilePhiSiteScaffold(root, context, "init");
    await writeFile(path.join(root, ".gitignore"), "node_modules/\n.env.local\n", "utf8");

    const result = await reconcilePhiSiteScaffold(root, context, "reconcile");

    expect(result.changes.find((entry) => entry.path === ".gitignore")?.action).toBe("unchanged");
    expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe("node_modules/\n.env.local\n");
  });

  it("ships the Markdown the code-owned Public presets fetch", () => {
    // Without these the welcome and terms pages render "fetch failed" on a brand new Site.
    const files = buildPhiSiteScaffoldFiles(context);

    expect(files["public/welcome.md"]).toContain("#");
    expect(files["public/terms-and-conditions.md"]).toContain("#");
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
