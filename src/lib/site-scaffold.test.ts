import { access, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildPhiSiteReleaseArtifact,
  buildPhiSiteScaffoldFiles,
  reconcilePhiSiteScaffold,
} from "./site-scaffold.mts";

const roots: string[] = [];
const context = {
  siteKey: "example-site",
  packageManager: "pnpm" as const,
  runtime: {
    publicBaseUrl: "https://example.test",
    apiBaseUrl: "https://api.example.test",
    internalToken: "server-secret",
  },
};
/** What `reconcile` and `update` pass: no manager named, no runtime values. */
const reconcileContext = { siteKey: "example-site" };

async function scaffoldRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "phis-scaffold-"));
  roots.push(root);
  return root;
}

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
    /*
     * Forms, Module diagnostics and navigation targets are answered from the Site rather than upstream,
     * and none of them is a route file: a Site's routes are written once and belong to the installation
     * from then on, so an address spelled here could never be revised. The `/api/site` door takes them.
     */
    expect(files["src/app/api/site/forms/route.ts"]).toBeUndefined();
    expect(files["src/app/api/site/module-diagnostics/route.ts"]).toBeUndefined();
    expect(files["src/app/api/site/navigation-target/route.ts"]).toBeUndefined();
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
    expect(JSON.parse(files["package.json"]!).dependencies["@phis/ui"]).toBe("0.4.0");
  });

  it("compiles the installed Module packages the projection lists", () => {
    const files = buildPhiSiteScaffoldFiles(context);

    // A Module from a tarball is compiled only when named, and only then are its typefaces loaded.
    expect(files["src/generated/site-module-packages.json"]).toBe("[]\n");
    expect(files["next.config.ts"]).toContain('require("./src/generated/site-module-packages.json")');
    expect(files["next.config.ts"]).toContain('transpilePackages: ["@phis/ui", ...siteModulePackages]');
  });

  it("generates Ant Design's structure from the Site's own Ant Design", () => {
    const files = buildPhiSiteScaffoldFiles(context);

    expect(files["next.config.ts"]).toContain('import { withPhiNextConfig } from "@phis/ui/next/config";');
    expect(files["next.config.ts"]).toContain("export default withPhiNextConfig(nextConfig, { dir: __dirname });");
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

    /*
     * The Site's only refusal routes, and the reason the Areas carry none is pinned further down. They
     * hand the Action to a placeholder rather than resolving the error page: Next renders every refusal
     * boundary into every response, and resolved there it cost each page view six server calls.
     */
    for (const route of ["not-found", "unauthorized", "forbidden"]) {
      expect(files[`src/app/(site)/${route}.tsx`]).toContain("createPhiNextRootErrorPage(");
      expect(files[`src/app/(site)/${route}.tsx`]).toContain(", loadPhiSiteRootErrorPage)");
    }
    expect(files["src/runtime-modules/root-error-page.ts"]?.startsWith('"use server";')).toBe(true);
    expect(files["src/runtime-modules/root-error-page.ts"]).toContain(
      "renderPhiCmsRootErrorPage(PHI_CMS_ROOT_ERROR_AREA, code)",
    );

    /*
     * The 500 is the one refusal that resolves nothing. It is reached only once rendering has failed,
     * so a CMS tree is exactly what it cannot ask for -- and it belongs outside the route groups,
     * because a boundary inside one does not catch that group's own root Layout.
     */
    expect(files["src/app/global-error.tsx"]).toContain("PhiNextGlobalErrorPage");
    expect(files["src/app/(site)/global-error.tsx"]).toBeUndefined();
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

  it("gives every Page-owned slot the file Next asks for, and the static tree none", () => {
    /*
     * Next holds one active segment per parallel slot, and a client navigation that leaves the slot's
     * branch has nothing to move it to: without this file the leaving branch's segment stays and is asked
     * to serve an address it was never resolved for. The static tree must not have one -- its slots sit
     * inside the catch-all, where `default.tsx` resolves to a route with `[...path]` in the middle, which
     * Next refuses at startup and with it the whole route manifest.
     */
    const files = buildPhiSiteScaffoldFiles(context);
    const slotPages = Object.keys(files).filter((file) => /\/@[^/]+\//.test(file) && file.endsWith("/page.tsx"));

    expect(slotPages.length).toBeGreaterThan(0);
    for (const page of slotPages) {
      const slotDirectory = page.slice(0, page.lastIndexOf("/@") + 1) + page.slice(page.lastIndexOf("/@") + 1).split("/")[0];
      const expected = `${slotDirectory}/default.tsx`;
      if (page.startsWith("src/app/(static)/")) {
        expect(files[expected], expected).toBeUndefined();
      } else {
        expect(files[expected], expected).toContain("createPhiNextAreaSlotDefault()");
      }
    }
    expect(files["src/app/(site)/[root]/(pages)/@hero/default.tsx"]).toBeDefined();
    expect(files["src/app/(site)/builder/(root)/@drawer/default.tsx"]).toBeDefined();
    expect(Object.keys(files).filter((file) => file.endsWith("/default.tsx"))).toHaveLength(60);
  });

  it("ignores the runtime config, so a first commit cannot publish the internal token", async () => {
    const files = buildPhiSiteScaffoldFiles(context);
    const ignored = files[".gitignore"]!.split("\n");

    expect(ignored).toContain("config/site-runtime.json");
    expect(ignored).toContain(".phis/releases/");
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

    expect(files["src/runtime-modules/root.ts"]).toContain(
      "createPhiNextRootLayout(\n  PHI_SITE_MODULES,\n  PHI_SITE_MODULE_FONTS,\n  PhiSiteOverlayZonesProvider,\n)",
    );
    expect(files["src/app/(site)/layout.tsx"]).toContain("@/runtime-modules/root");
  });

  /*
   * A closed Overlay asks for its zones when it first opens. Only the Site holds its Area bridges, so the
   * Server Action is the Site's -- and only a Client file may import it: imported by a root layout, the
   * Action brought every Area's bridge into that layout's server graph and every Area's Widget clients,
   * the Builder's among them, onto every page.
   */
  it("imports the Site's Overlay zones Action from a Client file only", () => {
    const files = buildPhiSiteScaffoldFiles(context);

    expect(files["src/runtime-modules/overlay-zones.ts"]?.startsWith('"use server";')).toBe(true);
    expect(files["src/runtime-modules/overlay-zones.ts"]).toContain(
      "loadPhiCmsOverlayZones(loadPhiSiteAreaBridge, request)",
    );
    expect(files["src/runtime-modules/overlay-zones-client.tsx"]?.startsWith('"use client";')).toBe(true);
    const importers = Object.entries(files)
      .filter(([, content]) => content.includes('from "@/runtime-modules/overlay-zones";'))
      .map(([file]) => file);
    expect(importers).toEqual(["src/runtime-modules/overlay-zones-client.tsx"]);
    for (const file of ["src/runtime-modules/root.ts", "src/runtime-modules/root-static.ts"]) {
      expect(files[file]).toContain(
        'import { PhiSiteOverlayZonesProvider } from "@/runtime-modules/overlay-zones-client";',
      );
    }
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

  /*
   * What the canonical Skeleton needs to compile and to answer a Form: a generated Site that differed
   * here built nothing -- a Site door without the Bridge loader the paths it answers itself require, a
   * Builder host without the authoring half of the projection. What it must not carry is here too.
   */
  it("wires what the Skeleton's routes require", () => {
    const files = buildPhiSiteScaffoldFiles(context);

    /*
     * No Area carries a refusal route. One there could never catch anything: existence is decided by
     * the Area's shell rather than by the Page, so that the status line can still say 404, and Next
     * catches a shell's refusal above the shell. Generating them cost a resolution per request each
     * and answered exactly what the root route answers.
     */
    for (const area of ["[root]", "accounting", "admin", "app", "builder", "editor"]) {
      expect(files[`src/app/(site)/${area}/not-found.tsx`]).toBeUndefined();
    }
    expect(files["src/app/api/site/[[...path]]/route.ts"]).toContain("loadAreaBridge: loadPhiSiteAreaBridge");
    expect(files["src/runtime-modules/area-bridges.ts"]).toContain('case "accounting"');
    // Only the Site door takes them; the other three proxies have no Site knowledge to hand over.
    expect(files["src/app/api/auth/[[...path]]/route.ts"]).not.toContain("loadAreaBridge");
    expect(files["src/runtime-modules/builder-client.tsx"]).toContain("PHI_SITE_MODULES_AUTHORING_CLIENT");
    expect(files["src/runtime-modules/public-client.tsx"]).not.toContain("AUTHORING");
    expect(files["src/generated/site-modules-authoring-client.ts"]).toContain("PHI_SITE_MODULES_AUTHORING_CLIENT");
    expect(files["src/generated/site-modules-fonts.ts"]).toContain("PHI_SITE_MODULE_FONTS");
  });

  it("refuses init over a non-empty target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "phis-scaffold-"));
    roots.push(root);
    await writeFile(path.join(root, "existing"), "x", "utf8");
    await expect(reconcilePhiSiteScaffold(root, context, "init")).rejects.toThrow(/use phis reconcile/);
  });

  it("refuses init without Core's address and the internal token", async () => {
    const root = await scaffoldRoot();
    await expect(reconcilePhiSiteScaffold(root, { siteKey: "example-site" }, "init")).rejects.toThrow(/internal token/);
    await expect(reconcilePhiSiteScaffold(root, {
      ...context,
      runtime: { ...context.runtime, internalToken: " " },
    }, "init")).rejects.toThrow(/internal token/);
  });

  it("writes the runtime config on init only, and keeps no instance value in the example", async () => {
    const root = await scaffoldRoot();
    await reconcilePhiSiteScaffold(root, context, "init");
    const written = JSON.parse(await readFile(path.join(root, "config/site-runtime.json"), "utf8"));
    expect(written.phis).toEqual({ apiBaseUrl: "https://api.example.test", internalToken: "server-secret" });
    const example = JSON.parse(await readFile(path.join(root, "config/site-runtime.example.json"), "utf8"));
    expect(example.phis).toEqual({ apiBaseUrl: "", internalToken: "" });

    // A clone has no runtime config (it is ignored); reconcile does not invent one.
    await rm(path.join(root, "config/site-runtime.json"));
    const result = await reconcilePhiSiteScaffold(root, reconcileContext, "reconcile");
    await expect(access(path.join(root, "config/site-runtime.json"))).rejects.toThrow();
    expect(result.changes.some((entry) => entry.path === "config/site-runtime.json")).toBe(false);
  });

  it("never retires the runtime config an earlier manifest listed", async () => {
    const root = await scaffoldRoot();
    await reconcilePhiSiteScaffold(root, context, "init");
    const before = await readFile(path.join(root, "config/site-runtime.json"), "utf8");
    await reconcilePhiSiteScaffold(root, reconcileContext, "reconcile");
    await reconcilePhiSiteScaffold(root, reconcileContext, "reconcile");
    expect(await readFile(path.join(root, "config/site-runtime.json"), "utf8")).toBe(before);
  });

  it("starts a new Site on npm when no manager is named", async () => {
    const root = await scaffoldRoot();
    const { packageManager: _named, ...unnamed } = context;
    const result = await reconcilePhiSiteScaffold(root, unnamed, "init");

    expect(result.packageManager).toBe("npm");
    expect(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).packageManager).toMatch(/^npm@/);
  });

  it("uses the Site's own package manager and leaves its lockfile alone", async () => {
    const root = await scaffoldRoot();
    await reconcilePhiSiteScaffold(root, { ...context, packageManager: "npm" }, "init");
    await writeFile(path.join(root, "package-lock.json"), "{}\n", "utf8");

    const result = await reconcilePhiSiteScaffold(root, reconcileContext, "reconcile");

    expect(result.packageManager).toBe("npm");
    expect(await readFile(path.join(root, "package-lock.json"), "utf8")).toBe("{}\n");
    expect(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).packageManager).toMatch(/^npm@/);
  });

  it("reads the manager from the lockfile when package.json names none, and refuses to guess otherwise", async () => {
    const root = await scaffoldRoot();
    await reconcilePhiSiteScaffold(root, context, "init");
    const packagePath = path.join(root, "package.json");
    const manifest = JSON.parse(await readFile(packagePath, "utf8"));
    delete manifest.packageManager;
    await writeFile(packagePath, JSON.stringify(manifest), "utf8");

    await expect(reconcilePhiSiteScaffold(root, reconcileContext, "reconcile")).rejects.toThrow(/--package-manager/);

    await writeFile(path.join(root, "yarn.lock"), "", "utf8");
    expect((await reconcilePhiSiteScaffold(root, reconcileContext, "reconcile")).packageManager).toBe("yarn");
    await access(path.join(root, "yarn.lock"));
  });

  it("replaces another manager's lockfile only when the operator names a different manager", async () => {
    const root = await scaffoldRoot();
    await reconcilePhiSiteScaffold(root, context, "init");
    await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf8");

    await reconcilePhiSiteScaffold(root, { ...reconcileContext, packageManager: "npm" }, "reconcile");

    await expect(access(path.join(root, "pnpm-lock.yaml"))).rejects.toThrow();
    expect(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).packageManager).toMatch(/^npm@/);
  });

  it("adds what the scaffold needs to package.json and keeps the Site's versions and scripts", async () => {
    const root = await scaffoldRoot();
    await reconcilePhiSiteScaffold(root, context, "init");
    const packagePath = path.join(root, "package.json");
    const manifest = JSON.parse(await readFile(packagePath, "utf8"));
    manifest.dependencies["@phis/ui"] = "^0.4.2";
    manifest.dependencies["@acme/extra"] = "1.0.0";
    manifest.dependencies.typescript = manifest.devDependencies.typescript;
    delete manifest.devDependencies.typescript;
    delete manifest.dependencies.antd;
    manifest.scripts.build = "next build --debug";
    delete manifest.scripts.typecheck;
    manifest.packageManager = "pnpm@10.0.0";
    manifest.engines = { node: ">=24", pnpm: ">=10" };
    await writeFile(packagePath, JSON.stringify(manifest, null, 2), "utf8");

    await reconcilePhiSiteScaffold(root, reconcileContext, "reconcile");
    const merged = JSON.parse(await readFile(packagePath, "utf8"));

    expect(merged.dependencies["@phis/ui"]).toBe("^0.4.2");
    expect(merged.dependencies["@acme/extra"]).toBe("1.0.0");
    expect(merged.dependencies.antd).toBe("6.6.7");
    expect(merged.devDependencies.typescript).toBeUndefined();
    expect(merged.scripts.build).toBe("next build --debug");
    expect(merged.scripts.typecheck).toBe("tsc --noEmit");
    expect(merged.packageManager).toBe("pnpm@10.0.0");
    expect(merged.engines).toEqual({ node: ">=24.21.0", pnpm: ">=10" });
  });

  /*
   * A release is build output next to the Site's repository. The token belongs to the instance, and a
   * release that carried it was one `git add .` or one copied directory away from publishing it.
   */
  it("builds a release that holds no runtime config and still reads the Site's", async () => {
    const root = await scaffoldRoot();
    await reconcilePhiSiteScaffold(root, context, "init");
    await fakeStandaloneBuild(root, "");

    const release = await buildPhiSiteReleaseArtifact(root);

    expect(release.appDirectory).toBe("");
    expect(await listFiles(release.path)).not.toContain("server-secret");
    const link = path.join(release.path, "config/site-runtime.json");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe("../../../../config/site-runtime.json");
    expect(JSON.parse(await readFile(link, "utf8")).phis.internalToken).toBe("server-secret");
    await access(path.join(release.path, ".next/static/chunk.js"));
    // A link in the build stays relative, so the next build cannot pull a release out from under itself.
    expect(await readlink(path.join(release.path, "node_modules/next"))).toBe(".pnpm/next/node_modules/next");
  });

  it("finds server.js where Next nests it inside a workspace, and starts it from the release root", async () => {
    const workspace = await scaffoldRoot();
    const root = path.join(workspace, "sites", "acme");
    await reconcilePhiSiteScaffold(root, context, "init");
    await fakeStandaloneBuild(root, "sites/acme");

    const release = await buildPhiSiteReleaseArtifact(root);

    expect(release.appDirectory).toBe(path.join("sites", "acme"));
    expect(await readFile(path.join(release.path, "server.js"), "utf8")).toContain('import("./sites/acme/server.js")');
    await access(path.join(release.path, "sites/acme/.next/static/chunk.js"));
    const link = path.join(release.path, "sites/acme/config/site-runtime.json");
    expect(JSON.parse(await readFile(link, "utf8")).site.key).toBe("example-site");
    expect(await listFiles(release.path)).not.toContain("server-secret");
  });
});

/** What `next build` leaves for the release step, with the runtime config the file tracer copies in. */
async function fakeStandaloneBuild(root: string, appDirectory: string) {
  const app = path.join(root, ".next/standalone", appDirectory);
  await mkdir(path.join(app, "config"), { recursive: true });
  await writeFile(path.join(app, "server.js"), "// next\n", "utf8");
  await writeFile(path.join(app, "config/site-runtime.json"), await readFile(path.join(root, "config/site-runtime.json")));
  const modules = path.join(root, ".next/standalone/node_modules");
  await mkdir(path.join(modules, ".pnpm/next/node_modules/next"), { recursive: true });
  const { symlink } = await import("node:fs/promises");
  await symlink(".pnpm/next/node_modules/next", path.join(modules, "next"));
  await mkdir(path.join(root, ".next/static"), { recursive: true });
  await writeFile(path.join(root, ".next/static/chunk.js"), "", "utf8");
  await writeFile(path.join(root, ".next/BUILD_ID"), "build-1\n", "utf8");
}

/** Every regular file's content under a directory, without following links. */
async function listFiles(directory: string): Promise<string> {
  const parts: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    expect(entry.name, file).not.toBe("site-runtime.json");
    parts.push(await readFile(file, "utf8"));
  }
  return parts.join("\n");
}
