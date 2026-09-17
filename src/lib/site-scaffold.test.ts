import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    expect(files["src/app/(site)/[root]/(root)/page.tsx"]).toContain("createPhiNextDynamicRootPage");
    expect(files["src/app/(site)/[root]/(pages)/[...path]/page.tsx"]).toContain("createPhiNextDynamicRootPage");
    expect(files["src/app/(site)/admin/(pages)/@drawer/[...path]/page.tsx"]).toContain("PhiCmsRegionType.Drawer");
    expect(files["src/app/(site)/admin/(root)/@drawer/page.tsx"]).toContain("PhiCmsRegionType.Drawer");
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

    expect(files["src/app/(site)/builder/(root)/layout.tsx"]).toContain('PHI_BUILDER_CMS_SITE_BRIDGE, "none"');
    expect(files["src/app/(site)/builder/(pages)/layout.tsx"]).toContain('PHI_BUILDER_CMS_SITE_BRIDGE, "shell"');
    expect(files["src/app/(site)/[root]/(root)/layout.tsx"]).toContain('PHI_PUBLIC_CMS_SITE_BRIDGE, "none"');
    expect(files["src/app/(site)/[root]/(pages)/layout.tsx"]).toContain('PHI_PUBLIC_CMS_SITE_BRIDGE, "shell"');

    // The Area's own Layout holds the guards and providers, and draws no Region of its own.
    expect(files["src/app/(site)/builder/layout.tsx"]).toContain("createPhiNextStaticAreaBoundary");
    expect(files["src/app/(site)/[root]/layout.tsx"]).toContain("createPhiNextDynamicRootBoundary");
  });

  /*
   * The root refusal routes are the fallback boundary of the whole app, so every module they can reach
   * joins every route's chunk group. A registry naming all six Areas here once put the Builder's
   * workspace Clients on the Public landing page and roughly doubled its script payload.
   */
  it("lets only the Public Area answer a root refusal, and loads even that", () => {
    const files = buildPhiSiteScaffoldFiles(context);
    const area = files["src/runtime-modules/root-error-area.tsx"];

    expect(area).toContain("PhiNextRootErrorArea");
    expect(area).toContain('import("@/runtime-modules/public")');
    expect(area).toContain('import("@/runtime-modules/public-client")');
    for (const other of ["accounting", "admin", "app", "builder", "editor"]) {
      expect(area).not.toContain(`@/runtime-modules/${other}`);
    }

    for (const route of ["not-found", "unauthorized", "forbidden"]) {
      expect(files[`src/app/(site)/${route}.tsx`]).toContain("PHI_CMS_ROOT_ERROR_AREA");
    }
  });

  /*
   * A crawler's two files are answered by the Public Area alone: the sitemap lists only what a visitor
   * may index, and robots.txt names no staff Area -- importing another Area's bridge here would be the
   * first step towards listing one.
   */
  it("answers sitemap.xml and robots.txt from the Public Area only", () => {
    const files = buildPhiSiteScaffoldFiles(context);

    expect(files["src/app/sitemap.xml/route.ts"]).toContain("buildPhiSitemapRouteHandler");
    expect(files["src/app/robots.txt/route.ts"]).toContain("buildPhiRobotsRouteHandler");
    for (const file of ["src/app/sitemap.xml/route.ts", "src/app/robots.txt/route.ts"]) {
      expect(files[file]).toContain("@/runtime-modules/public");
      for (const other of ["accounting", "admin", "app", "builder", "editor"]) {
        expect(files[file]).not.toContain(`@/runtime-modules/${other}`);
      }
    }
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

  it("hands the installed projection to the document shell as well", () => {
    // A Theme is site-wide: the root reads Theme blocks from the installed union, not from one Area.
    const files = buildPhiSiteScaffoldFiles(context);

    expect(files["src/runtime-modules/root.ts"]).toContain("createPhiNextRootLayout(PHI_SITE_MODULES)");
    expect(files["src/app/(site)/layout.tsx"]).toContain("@/runtime-modules/root");
  });

  it("repairs managed wrappers without overwriting runtime secrets or unknown files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "phis-scaffold-"));
    roots.push(root);
    await reconcilePhiSiteScaffold(root, context, "init");
    await writeFile(path.join(root, "src/app/(site)/page.tsx"), "broken\n", "utf8");
    await writeFile(path.join(root, "config/site-runtime.json"), "{\"secret\":true}\n", "utf8");
    await writeFile(path.join(root, "SITE_OWNED.txt"), "keep\n", "utf8");
    const result = await reconcilePhiSiteScaffold(root, context, "reconcile");
    expect(result.changes.find((entry) => entry.path === "src/app/(site)/page.tsx")?.action).toBe("repaired");
    expect(await readFile(path.join(root, "src/app/(site)/page.tsx"), "utf8")).toContain("PhiNextSiteIndexPage");
    expect(await readFile(path.join(root, "config/site-runtime.json"), "utf8")).toBe("{\"secret\":true}\n");
    expect(await readFile(path.join(root, "SITE_OWNED.txt"), "utf8")).toBe("keep\n");
  });

  /*
   * The Public Area twice: once reading the request, once for every anonymous visitor. Each tree needs
   * its own root Layout, which Next allows only inside route groups -- so no document shell may be left
   * at the top of `src/app`, where it would sit above both.
   */
  it("gives the static Public tree its own root and reads nothing of the request there", () => {
    const files = buildPhiSiteScaffoldFiles(context);
    const staticRoot = "src/app/(static)/static-render/[marker]/[mode]/[root]";

    expect(files["src/app/layout.tsx"]).toBeUndefined();
    expect(files["src/app/(site)/layout.tsx"]).toContain("PhiSiteRootLayout");
    expect(files[`${staticRoot}/layout.tsx`]).toContain("PhiSiteStaticRootLayout");
    expect(files["src/runtime-modules/root-static.ts"]).toContain("PhiPublicRuntimeModuleClientBoundary");
    expect(files["src/runtime-modules/root.ts"]).not.toContain("public-client");
    expect(files[`${staticRoot}/(root)/layout.tsx`]).toContain('PHI_PUBLIC_CMS_SITE_BRIDGE, "none"');
    expect(files[`${staticRoot}/(pages)/[...path]/layout.tsx`]).toContain('PHI_PUBLIC_CMS_SITE_BRIDGE, "shell"');
    expect(files[`${staticRoot}/(pages)/[...path]/@hero/page.tsx`]).toContain("PhiCmsRegionType.Hero");
    expect(files[`${staticRoot}/not-found.tsx`]).toContain('from "next/root-params"');

    const staticFiles = Object.entries(files).filter(([file]) => file.startsWith("src/app/(static)/"));
    for (const [file, content] of staticFiles) {
      expect(content, file).not.toContain("force-dynamic");
      if (!file.endsWith("not-found.tsx")) expect(content, file).toContain('dynamic = "force-static"');
    }
    expect(files["next.config.ts"]).toContain('require.resolve("@phis/ui/next/cache-handler")');
  });

  it("removes what an earlier scaffold wrote and this one no longer does, unless the Site changed it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "phis-scaffold-"));
    roots.push(root);
    await reconcilePhiSiteScaffold(root, context, "init");
    const manifestPath = path.join(root, ".phis/scaffold-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    // What an earlier scaffold would have left: the old root Layout and a route the Site since edited.
    const retired = "export default function OldLayout() { return null; }\n";
    await writeFile(path.join(root, "src/app/layout.tsx"), retired, "utf8");
    await mkdir(path.join(root, "src/app/[root]/(root)"), { recursive: true });
    await writeFile(path.join(root, "src/app/[root]/(root)/page.tsx"), "edited by the Site\n", "utf8");
    const { createHash } = await import("node:crypto");
    const hash = (content: string) => createHash("sha256").update(content).digest("hex");
    manifest.files["src/app/layout.tsx"] = hash(retired);
    manifest.files["src/app/[root]/(root)/page.tsx"] = hash("as the scaffold wrote it\n");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    const result = await reconcilePhiSiteScaffold(root, context, "reconcile");

    expect(result.changes.find((entry) => entry.path === "src/app/layout.tsx")?.action).toBe("removed");
    await expect(access(path.join(root, "src/app/layout.tsx"))).rejects.toThrow();
    expect(result.changes.find((entry) => entry.path === "src/app/[root]/(root)/page.tsx")?.action).toBe("kept");
    expect(await readFile(path.join(root, "src/app/[root]/(root)/page.tsx"), "utf8")).toBe("edited by the Site\n");
    const rewritten = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(rewritten.files["src/app/layout.tsx"]).toBeUndefined();
  });

  it("refuses init over a non-empty target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "phis-scaffold-"));
    roots.push(root);
    await writeFile(path.join(root, "existing"), "x", "utf8");
    await expect(reconcilePhiSiteScaffold(root, context, "init")).rejects.toThrow(/use phis reconcile/);
  });
});
