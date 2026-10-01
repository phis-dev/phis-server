import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, cp, mkdir, readFile, readdir, rename, rmdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { PHI_CMS_AREA_KEYS } from "@phis/contracts/cms";

import { buildSiteModuleProjection, siteModuleClientProjectionFile } from "../cli/modules.mts";
import { toPhiRecord } from "./helpers/record.ts";

export const PHI_SITE_SCAFFOLD_VERSION = 3;

const AREAS = ["accounting", "admin", "app", "builder", "editor"] as const;

/**
 * The two route trees, each under its own root Layout.
 *
 * `(site)` holds every route that reads the request: the Areas, the Public Area for a signed-in visitor
 * or a request with a query, and the refusal routes. `(static)` holds the Public Area as one anonymous
 * render per page, locale and colour scheme, which Next keeps and serves to every visitor the proxy sends
 * there. Two trees need two root Layouts, and Next allows that only with each inside a route group --
 * the request-reading document shell would otherwise sit above the static tree too. The doors to Core and
 * the crawler files render no document, so they stay outside both.
 */
const SITE_APP = "src/app/(site)";
const STATIC_APP = "src/app/(static)/static-render/[marker]/[mode]/[root]";

/**
 * What every static route file declares. `force-static` rather than `error`: the static loaders read no
 * request at all, and every read from Core is `no-store`, which `error` refuses outright. The minute is
 * the ceiling for what the change marker in the address does not see, such as a replaced Asset.
 */
const STATIC_SEGMENT_CONFIG = `export const dynamic = "force-static";\nexport const revalidate = 60;\n`;

/**
 * The two branches every Area is routed through, and how much of the Area each one draws.
 *
 * `(root)` answers the Area root and draws no Shell; `(pages)` answers everything below it and draws
 * the Area's own Regions. Both are route groups, so neither appears in a URL.
 */
const AREA_BRANCHES = [
  ["(root)", '"none"'],
  ["(pages)", '"shell"'],
] as const;
const ROOT_SLOTS = [
  ["drawer", "Drawer"],
  ["footerTop", "FooterTop"],
  ["headerBottom", "HeaderBottom"],
  ["hero", "Hero"],
  ["siderRight", "SiderRight"],
] as const;
/**
 * What a Page-owned slot stands at while the address belongs to another branch.
 *
 * Next holds one active segment per parallel slot beside the children segment, and this is what it puts
 * there when a client navigation leaves the branch the slot belongs to -- the Area root to a Page below
 * it, or one Area to the next. Without it the leaving branch's segment stays and is asked to serve an
 * address it was never resolved for. The file draws nothing, which is the answer rather than a
 * placeholder: a slot draws one Region of one Page, and the Layout beside it has already answered with a
 * status line.
 *
 * Only the two branch trees get one. The static tree's slots sit inside its catch-all, where a
 * `default.tsx` resolves to a route with `[...path]` in the middle -- refused at startup with
 * "Catch-all must be the last part of the URL", which takes the whole route manifest with it. Nothing
 * client-navigates there in any case; the proxy reaches that tree with a document request.
 */
const SLOT_DEFAULT = `import { createPhiNextAreaSlotDefault } from "@phis/ui/next/area-route";\n\nexport default createPhiNextAreaSlotDefault();\n`;
const AREA_NAMES = {
  accounting: "Accounting",
  admin: "Admin",
  app: "App",
  builder: "Builder",
  editor: "Editor",
} as const;

export type PhiSiteScaffoldPackageManager = "pnpm" | "npm" | "yarn" | "bun";
export const PHI_SITE_SCAFFOLD_PACKAGE_MANAGERS: readonly PhiSiteScaffoldPackageManager[] = ["pnpm", "npm", "yarn", "bun"];

/**
 * What `init` writes into `config/site-runtime.json`, and nothing else does.
 *
 * Only `init` takes it. The file is per instance and the Site owns it from then on, so `reconcile` has no
 * business knowing Core's address or the token -- and a value it did not need is a value it could write
 * over the right one with.
 */
export type PhiSiteScaffoldRuntime = {
  publicBaseUrl: string;
  apiBaseUrl: string;
  internalToken: string;
};

export type PhiSiteScaffoldContext = {
  siteKey: string;
  /**
   * The package manager an operator named. Absent, the Site's own is used -- see
   * `resolvePhiSitePackageManager` -- and no lockfile is touched.
   */
  packageManager?: PhiSiteScaffoldPackageManager;
  packageVersions?: Partial<Record<string, string>>;
  runtime?: PhiSiteScaffoldRuntime;
};
/**
 * What reconcile did to one file. `removed` is a file an earlier scaffold wrote and this one no longer
 * does, deleted because it was still exactly as written; `kept` is such a file the Site had changed, left
 * in place for its owner to move or delete.
 */
export type PhiSiteScaffoldChange = {
  path: string;
  action: "created" | "repaired" | "unchanged" | "removed" | "kept";
};
export type PhiSiteScaffoldResult = {
  version: number;
  root: string;
  packageManager: PhiSiteScaffoldPackageManager;
  changes: PhiSiteScaffoldChange[];
};
export type PhiSiteReleaseArtifact = {
  releaseId: string;
  path: string;
  buildId: string;
  /** Where Next put the app inside the standalone output, relative to the release; `""` at its top. */
  appDirectory: string;
};

const DEFAULT_VERSIONS: Record<string, string> = {
  "@ant-design/icons": "6.3.4",
  "@ant-design/nextjs-registry": "1.3.0",
  "@phis/ui": "0.1.0",
  antd: "6.6.4",
  next: "16.3.5",
  react: "19.3.0",
  "react-dom": "19.3.0",
  "@types/node": "26.6.1",
  "@types/react": "19.3.0",
  "@types/react-dom": "19.3.0",
  typescript: "6.0.3",
};
const PACKAGE_MANAGER_VERSIONS: Record<PhiSiteScaffoldPackageManager, string> = {
  pnpm: "11.9.0",
  npm: "11.10.1",
  yarn: "4.9.4",
  bun: "1.2.23",
};
const LOCKFILES: Record<PhiSiteScaffoldPackageManager, readonly string[]> = {
  pnpm: ["pnpm-lock.yaml"],
  npm: ["package-lock.json"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"],
};

/**
 * The Node a Site runs on. Below 24.21 a React Flight render leaks through an Immediate that
 * `async_context` holds on to, and a Site under load runs out of memory; the server and its CLI declare
 * the same floor.
 */
const PHI_SITE_NODE_ENGINE = ">=24.21.0";

function hashContent(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * The Area hosts, and the projection they are given.
 *
 * Each host takes what this Site installed as an argument. A Site build cannot redirect an import that
 * happens inside `@phis/ui`, so the value has to arrive from here -- these thirteen files are the whole
 * of the Skeleton's part in it, they are written once, and installing a Module never touches them again.
 * The thirteenth is the document shell: a Theme is site-wide, so the root reads the Theme blocks the Site
 * can follow from the installed union rather than from one Area's catalog.
 */
function runtimeModuleFiles() {
  const areas: readonly ("public" | typeof AREAS[number])[] = ["public", ...AREAS];
  const root = {
    "src/runtime-modules/root.ts":
      `import { createPhiNextRootLayout } from "@phis/ui/next/root-route";\n\n`
      + `import { PHI_SITE_MODULES } from "@/generated/site-modules";\n`
      + `import { PHI_SITE_MODULE_FONTS } from "@/generated/site-modules-fonts";\n\n`
      + `/**\n`
      + ` * The document shell, given what this Site installed.\n`
      + ` *\n`
      + ` * The root reads the Theme blocks the Site can follow from the installed union -- a Theme is site-wide\n`
      + ` * -- and, like every Area host, takes the projection as an argument rather than reaching for it.\n`
      + ` */\n`
      + `export const PhiSiteRootLayout = createPhiNextRootLayout(PHI_SITE_MODULES, PHI_SITE_MODULE_FONTS);\n`,
    "src/runtime-modules/root-static.ts":
      `import { createPhiNextStaticRootLayout } from "@phis/ui/next/root-route";\n\n`
      + `import { PHI_SITE_MODULES } from "@/generated/site-modules";\n`
      + `import { PHI_SITE_MODULE_FONTS } from "@/generated/site-modules-fonts";\n`
      + `import { PhiPublicRuntimeModuleClientBoundary } from "@/runtime-modules/public-client";\n\n`
      + `/**\n`
      + ` * The document shell of the static tree. Only the Public Area renders there, so its Client boundary\n`
      + ` * is mounted here rather than in a \`[root]\` Layout, and the request-reading root never imports it.\n`
      + ` */\n`
      + `export const PhiSiteStaticRootLayout = createPhiNextStaticRootLayout(\n`
      + `  PHI_SITE_MODULES,\n`
      + `  PHI_SITE_MODULE_FONTS,\n`
      + `  PhiPublicRuntimeModuleClientBoundary,\n`
      + `);\n`,
  };
  const bridges = {
    "src/runtime-modules/area-bridges.ts":
      `import type { PhiSiteAreaBridgeLoader } from "@phis/ui/next/route-handlers";\n\n`
      + `/**\n`
      + ` * The Bridge of one Area, loaded rather than imported.\n`
      + ` *\n`
      + ` * A Bridge carries its Area's server catalog, and that catalog names the Area's Widget plugins, so a\n`
      + ` * static import of all six puts every Area's Builder and Admin Clients into whatever graph reaches\n`
      + ` * this file. The \`/api/site\` door answers every request and learns from the path whether a Bridge\n`
      + ` * is wanted at all.\n`
      + ` *\n`
      + ` * An Area this Site does not host answers null, and the caller refuses rather than guessing.\n`
      + ` */\n`
      + `export const loadPhiSiteAreaBridge: PhiSiteAreaBridgeLoader = async (area) => {\n`
      + `  switch (area) {\n`
      + areas.map((area) =>
        `    case "${area}":\n      return (await import("@/runtime-modules/${area}")).PHI_${area.toUpperCase()}_CMS_SITE_BRIDGE;\n`,
      ).join("")
      + `    default:\n      return null;\n  }\n};\n`,
  };
  return Object.assign(root, bridges, Object.fromEntries(areas.flatMap((area) => {
    const name = area === "public" ? "Public" : AREA_NAMES[area];
    const upper = area.toUpperCase();
    return [
      [
        `src/runtime-modules/${area}.ts`,
        `import { createPhi${name}CmsSiteBridge } from "@phis/ui/next/areas/${area}";\n\n`
        + `import { PHI_SITE_MODULES } from "@/generated/site-modules";\n\n`
        + `export const PHI_${upper}_CMS_SITE_BRIDGE = createPhi${name}CmsSiteBridge(PHI_SITE_MODULES);\n`,
      ],
      [
        `src/runtime-modules/${area}-client.tsx`,
        `"use client";\n\n`
        + `import { createPhi${name}RuntimeModuleClientBoundary } from "@phis/ui/next/areas/${area}-client";\n\n`
        + `import { PHI_SITE_MODULES_CLIENT } from "@/generated/site-modules-client-${area}";\n`
        // Only the Builder hosts authoring; every other Area must not reach that half of the projection.
        + (area === "builder"
          ? `import { PHI_SITE_MODULES_AUTHORING_CLIENT } from "@/generated/site-modules-authoring-client";\n\n`
            + `export const Phi${name}RuntimeModuleClientBoundary =\n`
            + `  createPhi${name}RuntimeModuleClientBoundary(PHI_SITE_MODULES_CLIENT, PHI_SITE_MODULES_AUTHORING_CLIENT);\n`
          : `\nexport const Phi${name}RuntimeModuleClientBoundary =\n`
            + `  createPhi${name}RuntimeModuleClientBoundary(PHI_SITE_MODULES_CLIENT);\n`),
      ],
    ];
  })));
}

/**
 * The projection itself, scaffolded empty and rewritten by `phis module`.
 *
 * Preserved on reconcile like `config/site-runtime.json`: it holds what an operator installed, and
 * regenerating the Skeleton must not silently uninstall a Site's Modules.
 */
export const PHI_SITE_MODULE_PROJECTION_FILES = [
  "src/generated/site-modules.ts",
  ...PHI_CMS_AREA_KEYS.map(siteModuleClientProjectionFile),
  "src/generated/site-modules-authoring-client.ts",
  "src/generated/site-modules-fonts.ts",
] as const;

/**
 * The ignore file a generated Site starts with.
 *
 * `config/site-runtime.json` is the reason it is scaffolded at all rather than left to the operator: it
 * carries the internal token, and a Site whose first commit includes it has published a credential
 * before anyone looked. The build outputs are the ordinary rest.
 *
 * It is written once and never repaired, on the same terms as the runtime config -- a Site that adds
 * its own entries owns the file from then on.
 */
const PHI_SITE_GITIGNORE = [
  "node_modules/",
  ".next/",
  "dist/",
  "build/",
  "tsconfig.tsbuildinfo",
  "config/site-runtime.json",
  // Build output of `phis update`, one directory per release; nothing in it belongs in the history.
  ".phis/releases/",
  /*
   * The Module projection. It is what an operator installed, rewritten by `phis module` from the desired
   * state in the phis root, so it is build state: committed, it would make every installation a commit
   * of the Site's source and put Module names into a tree that is meant to know none.
   */
  "src/generated/",
  "*.log",
  "",
].join("\n");

/** Written on `init`, left alone on `reconcile`: the Site owns these once they exist. */
const PHI_SITE_OWNED_AFTER_INIT: readonly string[] = [
  "config/site-runtime.json",
  ".gitignore",
  ...PHI_SITE_MODULE_PROJECTION_FILES,
];

/**
 * What the root error routes rebuild before they render.
 *
 * Both halves are loaded rather than imported outright. These routes are the fallback boundary for the
 * whole app, so whatever this value reaches joins every route's Client manifest and every page's chunk
 * group -- the Bridge as much as the Boundary, because a Bridge carries its Area's server catalog and
 * that catalog names the Widget plugins. Public answers for every Area, and no Area carries refusal
 * routes of its own -- see the generated comment below for why one there could never catch anything.
 */
function rootErrorAreaFile() {
  return {
    "src/runtime-modules/root-error-area.tsx":
      `import dynamic from "next/dynamic";\n\n`
      + `import type { PhiNextRootErrorArea } from "@phis/ui/next/area-route";\n\n`
      + `/**\n`
      + ` * What the root error routes rebuild before they render.\n`
      + ` *\n`
      + ` * Both halves are loaded rather than imported outright. These routes are the fallback boundary for the\n`
      + ` * whole app, so whatever this value reaches joins every route's Client manifest and every page's chunk\n`
      + ` * group -- the Bridge as much as the Boundary, because a Bridge carries its Area's server catalog and\n`
      + ` * that catalog names the Widget plugins.\n`
      + ` *\n`
      + ` * Public answers for every Area, and these are the only refusal routes the Site has. One placed\n`
      + ` * inside an Area could never catch anything: existence is decided by the Area's shell rather than\n`
      + ` * by the Page, because deciding it below the shell arrives after the flush and answers 200 instead\n`
      + ` * of 404. The shell is the thrower, so the refusal is always caught above it.\n`
      + ` *\n`
      + ` * The 500 is not among them and needs none of this. It is reached once rendering has already\n`
      + ` * failed, so it resolves nothing and rebuilds nothing: a fixed page at \`src/app/global-error.tsx\`.\n`
      + ` */\n`
      + `export const PHI_CMS_ROOT_ERROR_AREA: PhiNextRootErrorArea = {\n`
      + `  loadBridge: () =>\n`
      + `    import("@/runtime-modules/public").then((m) => m.PHI_PUBLIC_CMS_SITE_BRIDGE),\n`
      + `  Boundary: dynamic(() =>\n`
      + `    import("@/runtime-modules/public-client").then((m) => m.PhiPublicRuntimeModuleClientBoundary),\n`
      + `  ),\n`
      + `};\n`,
  };
}

function siteModuleProjectionFiles() {
  // Exactly what `phis module` writes for no Modules, so the first `module add` changes only the lists.
  const { server, clients, authoringClient, fonts } = buildSiteModuleProjection([], [], new Map());
  return {
    "src/generated/site-modules.ts": server,
    ...Object.fromEntries(PHI_CMS_AREA_KEYS.map((area) =>
      [siteModuleClientProjectionFile(area), clients[area]])),
    "src/generated/site-modules-authoring-client.ts": authoringClient,
    "src/generated/site-modules-fonts.ts": fonts,
  };
}

/**
 * One Area's routes, split into the branch that answers its root and the branch that answers every
 * page inside it.
 *
 * The root of an Area draws no Shell: it is either a landing page, whose point is to arrive without the
 * Area's chrome and its cost, or a redirect, which draws nothing at all. Making that two branches
 * rather than a condition inside one Layout is what lets Next mount and unmount the Shell on a client
 * navigation across the boundary -- a Layout that stayed would keep drawing chrome the branch no longer
 * has. The Area's own Layout keeps the guards, the providers and the Overlays, so crossing that
 * boundary rebuilds the Shell without rebuilding the Area.
 *
 * Both branches call the same factories; only `chrome` and the catch-all differ. The optional catch-all
 * cannot stay: it would match the Area root as well and collide with the root branch's own page.
 */
function staticAreaFiles(area: typeof AREAS[number]) {
  const name = AREA_NAMES[area];
  const upper = area.toUpperCase();
  const bridge = `PHI_${upper}_CMS_SITE_BRIDGE`;
  const areaPage = `import { ${bridge} } from "@/runtime-modules/${area}";\nimport { createPhiNextStaticAreaPage } from "@phis/ui/next/area-route";\n\nexport const dynamic = "force-dynamic";\n\nconst route = createPhiNextStaticAreaPage("${area}", ${bridge});\n\nexport const generateMetadata = route.generateMetadata;\nexport default route.Page;\n`;
  const files: Record<string, string> = {
    [`${SITE_APP}/${area}/layout.tsx`]: `import { ${bridge} } from "@/runtime-modules/${area}";\nimport { createPhiNextStaticAreaBoundary } from "@phis/ui/next/area-route";\nimport { Phi${name}RuntimeModuleClientBoundary } from "@/runtime-modules/${area}-client";\n\nexport const dynamic = "force-dynamic";\n\nexport default createPhiNextStaticAreaBoundary("${area}", ${bridge}, Phi${name}RuntimeModuleClientBoundary);\n`,
    [`${SITE_APP}/${area}/(root)/page.tsx`]: areaPage,
    [`${SITE_APP}/${area}/(pages)/[...path]/page.tsx`]: areaPage,
  };
  for (const [group, chrome] of AREA_BRANCHES) {
    files[`${SITE_APP}/${area}/${group}/layout.tsx`] = `import { ${bridge} } from "@/runtime-modules/${area}";\nimport { createPhiNextStaticAreaLayout } from "@phis/ui/next/area-route";\n\nexport const dynamic = "force-dynamic";\n\nexport default createPhiNextStaticAreaLayout("${area}", ${bridge}, ${chrome});\n`;
  }
  for (const [slot, regionType] of ROOT_SLOTS) {
    const slotPage = `import { PhiCmsRegionType } from "@phis/ui/cms/root-slot-page";\n\nimport { ${bridge} } from "@/runtime-modules/${area}";\nimport { createPhiNextStaticAreaSlotPage } from "@phis/ui/next/area-route";\n\nexport const dynamic = "force-dynamic";\n\nexport default createPhiNextStaticAreaSlotPage(\n  "${area}",\n  ${bridge},\n  PhiCmsRegionType.${regionType},\n);\n`;
    files[`${SITE_APP}/${area}/(root)/@${slot}/page.tsx`] = slotPage;
    files[`${SITE_APP}/${area}/(pages)/@${slot}/[...path]/page.tsx`] = slotPage;
    files[`${SITE_APP}/${area}/(root)/@${slot}/default.tsx`] = SLOT_DEFAULT;
    files[`${SITE_APP}/${area}/(pages)/@${slot}/default.tsx`] = SLOT_DEFAULT;
  }
  return files;
}

/**
 * The Public Area's routes. Same two branches as every other Area, addressed by locale rather than by
 * an Area segment -- so `/de` is its root and draws no Shell, exactly as `/builder` is the Builder's.
 */
function dynamicRootFiles() {
  const rootPage = `import { createPhiNextDynamicRootPage } from "@phis/ui/next/area-route";\nimport { PHI_PUBLIC_CMS_SITE_BRIDGE } from "@/runtime-modules/public";\n\nexport const dynamic = "force-dynamic";\n\nconst route = createPhiNextDynamicRootPage(PHI_PUBLIC_CMS_SITE_BRIDGE);\n\nexport const generateMetadata = route.generateMetadata;\nexport default route.Page;\n`;
  const files: Record<string, string> = {
    [`${SITE_APP}/[root]/layout.tsx`]: `import { createPhiNextDynamicRootBoundary } from "@phis/ui/next/area-route";\nimport { PhiPublicRuntimeModuleClientBoundary } from "@/runtime-modules/public-client";\nimport { PHI_PUBLIC_CMS_SITE_BRIDGE } from "@/runtime-modules/public";\n\nexport const dynamic = "force-dynamic";\n\nexport default createPhiNextDynamicRootBoundary(\n  PHI_PUBLIC_CMS_SITE_BRIDGE,\n  PhiPublicRuntimeModuleClientBoundary,\n);\n`,
    [`${SITE_APP}/[root]/(root)/page.tsx`]: rootPage,
    [`${SITE_APP}/[root]/(pages)/[...path]/page.tsx`]: rootPage,
  };
  for (const [group, chrome] of AREA_BRANCHES) {
    files[`${SITE_APP}/[root]/${group}/layout.tsx`] = `import { createPhiNextDynamicRootLayout } from "@phis/ui/next/area-route";\nimport { PHI_PUBLIC_CMS_SITE_BRIDGE } from "@/runtime-modules/public";\n\nexport const dynamic = "force-dynamic";\n\nexport default createPhiNextDynamicRootLayout(PHI_PUBLIC_CMS_SITE_BRIDGE, ${chrome});\n`;
  }
  for (const [slot, regionType] of ROOT_SLOTS) {
    const slotPage = `import { PhiCmsRegionType } from "@phis/ui/cms/root-slot-page";\nimport { createPhiNextDynamicRootSlotPage } from "@phis/ui/next/area-route";\nimport { PHI_PUBLIC_CMS_SITE_BRIDGE } from "@/runtime-modules/public";\n\nexport const dynamic = "force-dynamic";\n\nexport default createPhiNextDynamicRootSlotPage(\n  PHI_PUBLIC_CMS_SITE_BRIDGE,\n  PhiCmsRegionType.${regionType},\n);\n`;
    files[`${SITE_APP}/[root]/(root)/@${slot}/page.tsx`] = slotPage;
    files[`${SITE_APP}/[root]/(pages)/@${slot}/[...path]/page.tsx`] = slotPage;
    files[`${SITE_APP}/[root]/(root)/@${slot}/default.tsx`] = SLOT_DEFAULT;
    files[`${SITE_APP}/[root]/(pages)/@${slot}/default.tsx`] = SLOT_DEFAULT;
  }
  return files;
}

/**
 * The Public Area's static tree: the same two branches as `[root]`, reading nothing from the request.
 *
 * The proxy rewrites an anonymous read without a query to `/static-render/<marker>/<mode>/<locale>/...`
 * (`@phis/ui/next/site-proxy`). Its Layouts sit inside the catch-all, where they are given the page's
 * segments -- the dynamic tree's Layouts derive them from a request header this tree may not read. The
 * refusal route is given no params, so it reads the locale from \`next/root-params\`.
 */
function staticPublicFiles() {
  const bridgeImport = `import { PHI_PUBLIC_CMS_SITE_BRIDGE } from "@/runtime-modules/public";\n`;
  const noParams = `export async function generateStaticParams() {\n  return [];\n}\n`;
  const page = `import { createPhiNextStaticPublicPage } from "@phis/ui/next/area-route";\n${bridgeImport}\n${STATIC_SEGMENT_CONFIG}${noParams}\nconst route = createPhiNextStaticPublicPage(PHI_PUBLIC_CMS_SITE_BRIDGE);\n\nexport const generateMetadata = route.generateMetadata;\nexport default route.Page;\n`;
  const files: Record<string, string> = {
    [`${STATIC_APP}/layout.tsx`]: `import { generatePhiNextStaticRootMetadata } from "@phis/ui/next/root-route";\n\nimport { PhiSiteStaticRootLayout } from "@/runtime-modules/root-static";\n\nimport "@/app/globals.css";\n\n${STATIC_SEGMENT_CONFIG}${noParams}\nexport const generateMetadata = generatePhiNextStaticRootMetadata;\nexport default PhiSiteStaticRootLayout;\n`,
    [`${STATIC_APP}/not-found.tsx`]: `import { root } from "next/root-params";\nimport { createPhiNextStaticPublicNotFound } from "@phis/ui/next/area-route";\n${bridgeImport}\nconst PhiStaticPublicNotFound = createPhiNextStaticPublicNotFound(PHI_PUBLIC_CMS_SITE_BRIDGE);\n\nexport default async function StaticPublicNotFound() {\n  return <PhiStaticPublicNotFound locale={await root()} />;\n}\n`,
    [`${STATIC_APP}/(root)/page.tsx`]: page,
    [`${STATIC_APP}/(pages)/[...path]/page.tsx`]: page,
    [`${STATIC_APP}/(root)/layout.tsx`]: `import { createPhiNextStaticPublicLayout } from "@phis/ui/next/area-route";\n${bridgeImport}\n${STATIC_SEGMENT_CONFIG}\nexport default createPhiNextStaticPublicLayout(PHI_PUBLIC_CMS_SITE_BRIDGE, "none");\n`,
    [`${STATIC_APP}/(pages)/[...path]/layout.tsx`]: `import { createPhiNextStaticPublicLayout } from "@phis/ui/next/area-route";\n${bridgeImport}\n${STATIC_SEGMENT_CONFIG}\nexport default createPhiNextStaticPublicLayout(PHI_PUBLIC_CMS_SITE_BRIDGE, "shell");\n`,
  };
  for (const [slot, regionType] of ROOT_SLOTS) {
    const slotPage = `import { PhiCmsRegionType } from "@phis/ui/cms/root-slot-page";\nimport { createPhiNextStaticPublicSlotPage } from "@phis/ui/next/area-route";\n${bridgeImport}\n${STATIC_SEGMENT_CONFIG}\nexport default createPhiNextStaticPublicSlotPage(\n  PHI_PUBLIC_CMS_SITE_BRIDGE,\n  PhiCmsRegionType.${regionType},\n);\n`;
    files[`${STATIC_APP}/(root)/@${slot}/page.tsx`] = slotPage;
    files[`${STATIC_APP}/(pages)/[...path]/@${slot}/page.tsx`] = slotPage;
  }
  return files;
}

/**
 * The doors a Site opens to Core, each forwarding and deciding nothing.
 *
 * `addons` is how a Module half reaches the Add-on half it ships with: the Add-on API lives on Core at
 * `/api/v1/addons/*`, and a Site that proxied only `/api/site` and `/api/auth` left every such call at
 * its own 404 page. Short outside and versioned upstream, exactly as `auth` already is.
 */
function proxyRoute(kind: "auth" | "site" | "addons" | "hooks") {
  const factory = kind === "auth"
    ? "buildPhiAuthProxyHandlers"
    : kind === "addons"
      ? "buildPhiAddonProxyHandlers"
      : kind === "hooks"
        ? "buildPhiHookProxyHandlers"
        : "buildPhiSiteProxyHandlers";
  // The hooks door faces outward: what arrives on it came from the open internet and must not pick up
  // a claim to have come from inside on the way through.
  const headerOptions = kind === "hooks" ? ", { internalToken: false }" : "";
  // The Site door hands over its Bridges, because a few paths under `/api/site` are answered from this
  // Site's own Modules rather than upstream. Which ones is @phis/ui's to decide and to revise; a Site's
  // route files are written once and then belong to the installation.
  const bridgeImport = kind === "site"
    ? `import { loadPhiSiteAreaBridge } from "@/runtime-modules/area-bridges";\n`
    : "";
  const bridgeOption = kind === "site" ? `  loadAreaBridge: loadPhiSiteAreaBridge,\n` : "";
  return `import { ${factory} } from "@phis/ui/next/route-handlers";\n\nimport {\n  buildPhiNextProxyHeaders,\n  getPhiNextUpstreamBaseUrl,\n  getPhiNextProxyTimeoutMs,\n} from "@phis/ui/next/proxy-runtime";\n${bridgeImport}\nexport const dynamic = "force-dynamic";\nexport const runtime = "nodejs";\n\nconst handlers = ${factory}({\n  upstreamBaseUrl: getPhiNextUpstreamBaseUrl(),\n  timeoutMs: getPhiNextProxyTimeoutMs(),\n  logLabel: "[phi-site][/api/${kind} proxy]",\n  missingBaseUrlMessage: "Missing phis.apiBaseUrl for /api/${kind} proxy.",\n  buildHeaders: (request) => buildPhiNextProxyHeaders(request, "phi-site-${kind}-proxy/1.0"${headerOptions}),\n${bridgeOption}});\n\nexport const GET = handlers.GET;\nexport const POST = handlers.POST;\nexport const PUT = handlers.PUT;\nexport const PATCH = handlers.PATCH;\nexport const DELETE = handlers.DELETE;\nexport const OPTIONS = handlers.OPTIONS;\n`;
}

function packageJson(context: PhiSiteScaffoldContext, manager: PhiSiteScaffoldPackageManager) {
  const versions = { ...DEFAULT_VERSIONS, ...(context.packageVersions ?? {}) };
  return `${JSON.stringify({
    name: context.siteKey,
    version: "0.1.0",
    type: "module",
    private: true,
    scripts: {
      dev: "NEXT_TELEMETRY_DISABLED=1 next dev --hostname 0.0.0.0",
      build: "NEXT_TELEMETRY_DISABLED=1 next build",
      start: "NEXT_TELEMETRY_DISABLED=1 next start",
      typecheck: "tsc --noEmit",
    },
    dependencies: Object.fromEntries(Object.entries(versions).filter(([key]) => !key.startsWith("@types/") && key !== "typescript")),
    devDependencies: Object.fromEntries(Object.entries(versions).filter(([key]) => key.startsWith("@types/") || key === "typescript")),
    engines: { node: PHI_SITE_NODE_ENGINE },
    packageManager: `${manager}@${PACKAGE_MANAGER_VERSIONS[manager]}`,
  }, null, 2)}\n`;
}

/**
 * The files the scaffold writes.
 *
 * `config/site-runtime.json` is among them only when the context carries the runtime values, which only
 * `init` passes.
 */
export function buildPhiSiteScaffoldFiles(
  context: PhiSiteScaffoldContext,
  manager: PhiSiteScaffoldPackageManager = context.packageManager ?? "pnpm",
) {
  const files: Record<string, string> = {
    ...runtimeModuleFiles(),
    ...siteModuleProjectionFiles(),
    ...rootErrorAreaFile(),
    ...dynamicRootFiles(),
    ...staticPublicFiles(),
    ...Object.assign({}, ...AREAS.map(staticAreaFiles)),
    [`${SITE_APP}/layout.tsx`]: `import { generatePhiNextRootMetadata } from "@phis/ui/next/root-route";\n\nimport { PhiSiteRootLayout } from "@/runtime-modules/root";\n\nimport "@/app/globals.css";\n\nexport const dynamic = "force-dynamic";\n\nexport const generateMetadata = generatePhiNextRootMetadata;\nexport default PhiSiteRootLayout;\n`,
    [`${SITE_APP}/page.tsx`]: `import { PhiNextSiteIndexPage } from "@phis/ui/next/root-route";\n\nexport const dynamic = "force-dynamic";\nexport default PhiNextSiteIndexPage;\n`,
    "src/app/globals.css": "/* Site-specific global overrides may be added here. */\n",
    ".gitignore": PHI_SITE_GITIGNORE,
    [`${SITE_APP}/not-found.tsx`]: `import { createPhiNextRootErrorPage } from "@phis/ui/next/area-route";\nimport { PHI_CMS_ROOT_ERROR_AREA } from "@/runtime-modules/root-error-area";\n\nexport default createPhiNextRootErrorPage(404, PHI_CMS_ROOT_ERROR_AREA);\n`,
    [`${SITE_APP}/forbidden.tsx`]: `import { createPhiNextRootErrorPage } from "@phis/ui/next/area-route";\nimport { PHI_CMS_ROOT_ERROR_AREA } from "@/runtime-modules/root-error-area";\n\nexport default createPhiNextRootErrorPage(403, PHI_CMS_ROOT_ERROR_AREA);\n`,
    [`${SITE_APP}/unauthorized.tsx`]: `import { createPhiNextRootErrorPage } from "@phis/ui/next/area-route";\nimport { PHI_CMS_ROOT_ERROR_AREA } from "@/runtime-modules/root-error-area";\n\nexport default createPhiNextRootErrorPage(401, PHI_CMS_ROOT_ERROR_AREA);\n`,
    /*
     * The 500, and the only refusal route that is not a Page.
     *
     * It sits outside both route groups because it is the boundary of last resort: the root Layouts
     * are plausible throwers themselves, and a boundary below a Layout does not catch that Layout.
     * Being outermost, it replaces the document -- so it renders its own `<html>`, asks the CMS for
     * nothing, and there is no `/error/500` preset for a Site to edit in its stead.
     */
    "src/app/global-error.tsx": `"use client";\n\nexport { PhiNextGlobalErrorPage as default } from "@phis/ui/next/global-error";\n`,
    "src/proxy.ts": `import type { NextRequest } from "next/server";\nimport { proxyPhiNextSiteRequest } from "@phis/ui/next/site-proxy";\n\nexport function proxy(request: NextRequest) {\n  return proxyPhiNextSiteRequest(request);\n}\n\nexport const config = { matcher: "/:path*" };\n`,
    "src/app/api/auth/[[...path]]/route.ts": proxyRoute("auth"),
    "src/app/api/site/[[...path]]/route.ts": proxyRoute("site"),
    "src/app/api/addons/[[...path]]/route.ts": proxyRoute("addons"),
    "src/app/api/hooks/[[...path]]/route.ts": proxyRoute("hooks"),
    [`${SITE_APP}/builder/api/[[...path]]/route.ts`]: `export { POST } from "@phis/ui/builder-api-route";\n\nexport const dynamic = "force-dynamic";\nexport const runtime = "nodejs";\n`,
    "src/app/sitemap.xml/route.ts": `import { buildPhiSitemapRouteHandler } from "@phis/ui/next/seo-routes";\nimport { PHI_PUBLIC_CMS_SITE_BRIDGE } from "@/runtime-modules/public";\n\nexport const dynamic = "force-dynamic";\nexport const runtime = "nodejs";\nexport const GET = buildPhiSitemapRouteHandler({ bridge: PHI_PUBLIC_CMS_SITE_BRIDGE });\n`,
    "src/app/robots.txt/route.ts": `import { buildPhiRobotsRouteHandler } from "@phis/ui/next/seo-routes";\nimport { PHI_PUBLIC_CMS_SITE_BRIDGE } from "@/runtime-modules/public";\n\nexport const dynamic = "force-dynamic";\nexport const runtime = "nodejs";\nexport const GET = buildPhiRobotsRouteHandler({ bridge: PHI_PUBLIC_CMS_SITE_BRIDGE });\n`,
    "next.config.ts": `import type { NextConfig } from "next";\n\nconst nextConfig: NextConfig = {\n  output: "standalone",\n  reactStrictMode: true,\n  images: { localPatterns: [{ pathname: "/api/site/media/**" }] },\n  // Rendered Public pages live in this process's memory, addressed by the Site's change marker.\n  cacheHandler: require.resolve("@phis/ui/next/cache-handler"),\n  cacheMaxMemorySize: 0,\n  experimental: {\n    authInterrupts: true,\n    // A cached page the browser already holds is asked for again after this long, so a publish reaches an open tab.\n    staleTimes: { static: 30 },\n  },\n  transpilePackages: ["@phis/ui"],\n};\nexport default nextConfig;\n`,
    "tsconfig.json": `${JSON.stringify({ compilerOptions: { target: "ES2022", lib: ["dom", "dom.iterable", "esnext"], allowJs: false, skipLibCheck: true, strict: true, noEmit: true, esModuleInterop: true, module: "esnext", moduleResolution: "bundler", resolveJsonModule: true, isolatedModules: true, jsx: "react-jsx", incremental: true, plugins: [{ name: "next" }], paths: { "@/*": ["./src/*"] } }, include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", ".next/dev/types/**/*.ts"], exclude: ["node_modules"] }, null, 2)}\n`,
    "package.json": packageJson(context, manager),
    // Canonical, so it holds nothing that differs per instance: the address and the token are filled in
    // where the Site runs.
    "config/site-runtime.example.json": `${JSON.stringify({ site: { key: context.siteKey, publicUrl: "" }, phis: { apiBaseUrl: "", internalToken: "" }, network: { internalApiTimeoutMs: 8000 } }, null, 2)}\n`,
  };
  if (context.runtime) {
    files["config/site-runtime.json"] = `${JSON.stringify({ site: { key: context.siteKey, publicUrl: context.runtime.publicBaseUrl }, phis: { apiBaseUrl: context.runtime.apiBaseUrl, internalToken: context.runtime.internalToken }, network: { internalApiTimeoutMs: 8000 } }, null, 2)}\n`;
  }
  return files;
}

async function exists(target: string) {
  try { await access(target); return true; } catch { return false; }
}

async function writeAtomic(target: string, content: string) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.phis-tmp-${process.pid}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, target);
}

async function readJsonRecord(target: string) {
  try {
    const value = JSON.parse(await readFile(target, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

/**
 * The Site's `package.json` with what the scaffold needs added to it.
 *
 * Adds, and does not reset. A dependency, script or field the Site already has keeps the Site's value:
 * the scaffold's versions are what a new Site starts from, not a floor an existing one is pulled back to
 * -- a Site that moved `@phis/ui` on would otherwise lose it on every `update`. A dependency counts as
 * present in either section, so moving one to `devDependencies` is not undone either.
 *
 * Two values are the scaffold's rather than the Site's. `engines.node` is a runtime requirement, and a
 * Site declaring an older floor would install on a Node that leaks under rendering. `packageManager`
 * follows a manager the operator named explicitly; otherwise the Site's own field stays.
 */
function mergePackageJson(
  current: Record<string, unknown>,
  canonicalText: string,
  explicitManager: PhiSiteScaffoldPackageManager | undefined,
) {
  const canonical = JSON.parse(canonicalText) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(canonical)) {
    if (!(key in merged)) merged[key] = value;
  }
  merged.scripts = { ...toPhiRecord(current.scripts) };
  for (const [name, command] of Object.entries(toPhiRecord(canonical.scripts))) {
    if (!(name in (merged.scripts as Record<string, unknown>))) (merged.scripts as Record<string, unknown>)[name] = command;
  }
  const installed = new Set([
    ...Object.keys(toPhiRecord(current.dependencies)),
    ...Object.keys(toPhiRecord(current.devDependencies)),
  ]);
  for (const section of ["dependencies", "devDependencies"] as const) {
    const next = { ...toPhiRecord(current[section]) };
    for (const [name, range] of Object.entries(toPhiRecord(canonical[section]))) {
      if (!installed.has(name)) next[name] = range;
    }
    merged[section] = next;
  }
  merged.engines = { ...toPhiRecord(current.engines), node: toPhiRecord(canonical.engines).node };
  if (explicitManager && readDeclaredManagerName(current.packageManager) !== explicitManager) {
    merged.packageManager = canonical.packageManager;
  }
  return `${JSON.stringify(merged, null, 2)}\n`;
}

function readDeclaredManagerName(value: unknown) {
  return typeof value === "string" ? value.trim().split("@")[0] : undefined;
}

/**
 * Which package manager a Site uses.
 *
 * The one an operator named, else the one the Site declares in `package.json`, else the one whose
 * lockfile it has. A new Site starts on pnpm. An existing Site that says nothing is refused rather than
 * assumed to be pnpm: the guess used to decide which lockfiles were deleted.
 */
export async function resolvePhiSitePackageManager(
  root: string,
  explicit: PhiSiteScaffoldPackageManager | undefined,
  mode: "init" | "reconcile",
): Promise<PhiSiteScaffoldPackageManager> {
  if (explicit) return explicit;
  if (mode === "init") return "pnpm";
  const declared = readDeclaredManagerName((await readJsonRecord(path.join(root, "package.json"))).packageManager);
  if (declared) {
    if ((PHI_SITE_SCAFFOLD_PACKAGE_MANAGERS as readonly string[]).includes(declared)) {
      return declared as PhiSiteScaffoldPackageManager;
    }
    throw new Error(`The Site at ${root} declares packageManager "${declared}", which phis does not run. Pass --package-manager.`);
  }
  const found: PhiSiteScaffoldPackageManager[] = [];
  for (const manager of PHI_SITE_SCAFFOLD_PACKAGE_MANAGERS) {
    for (const lockfile of LOCKFILES[manager]) {
      if (await exists(path.join(root, lockfile))) {
        found.push(manager);
        break;
      }
    }
  }
  if (found.length === 1) return found[0];
  if (found.length > 1) {
    throw new Error(`The Site at ${root} has lockfiles of ${found.join(" and ")}. Pass --package-manager to say which one it uses.`);
  }
  throw new Error(
    `The Site at ${root} names no package manager: package.json has no packageManager field and there is no lockfile. ` +
    "Pass --package-manager.",
  );
}

async function readPreviousManifestFiles(root: string): Promise<Record<string, string>> {
  const manifest = await readJsonRecord(path.join(root, ".phis/scaffold-manifest.json"));
  const files = manifest.files;
  return files && typeof files === "object" && !Array.isArray(files) ? files as Record<string, string> : {};
}

/** Removes the directories a removed file leaves empty, up to the Site root and no further. */
async function removeEmptyParents(root: string, target: string) {
  let directory = path.dirname(target);
  while (directory.startsWith(`${root}${path.sep}`)) {
    if ((await readdir(directory)).length > 0) return;
    await rmdir(directory);
    directory = path.dirname(directory);
  }
}

/**
 * The files an earlier scaffold wrote that this one does not, as the manifest of that run lists them.
 *
 * A route that moved -- every Area into `(site)` when the static tree arrived -- would otherwise stay at
 * its old address beside the new one, and Next refuses two routes for one path. Only a file still exactly
 * as it was written is deleted: one the Site edited is its owner's, and is reported instead.
 */
async function removeRetiredScaffoldFiles(
  root: string,
  previous: Record<string, string>,
  current: Record<string, string>,
  changes: PhiSiteScaffoldChange[],
) {
  for (const [relativePath, hash] of Object.entries(previous)) {
    if (relativePath in current) continue;
    // The Site's own files are never retired. `config/site-runtime.json` is written by `init` alone, so a
    // reconcile does not list it -- and unchanged since `init` is exactly what a token file usually is.
    if (PHI_SITE_OWNED_AFTER_INIT.includes(relativePath)) continue;
    const target = path.join(root, relativePath);
    if (!await exists(target)) continue;
    if (hashContent(await readFile(target, "utf8")) !== hash) {
      changes.push({ path: relativePath, action: "kept" });
      continue;
    }
    await unlink(target);
    await removeEmptyParents(root, target);
    changes.push({ path: relativePath, action: "removed" });
  }
}

export async function reconcilePhiSiteScaffold(root: string, context: PhiSiteScaffoldContext, mode: "init" | "reconcile") {
  const resolvedRoot = path.resolve(root);
  if (mode === "init") {
    if (!context.runtime?.apiBaseUrl.trim() || !context.runtime.internalToken.trim()) {
      throw new Error("phis init writes config/site-runtime.json and needs Core's address and the internal token.");
    }
    if (await exists(resolvedRoot)) {
      const info = await stat(resolvedRoot);
      if (!info.isDirectory()) throw new Error(`Site target ${resolvedRoot} is not a directory.`);
      const entries = await readdir(resolvedRoot);
      if (entries.length > 0) throw new Error(`Site target ${resolvedRoot} already exists; use phis reconcile.`);
    }
  } else if (!await exists(path.join(resolvedRoot, "package.json"))) {
    throw new Error(`No Site at ${resolvedRoot} (no package.json); phis init creates one.`);
  }
  await mkdir(resolvedRoot, { recursive: true });
  const manager = await resolvePhiSitePackageManager(resolvedRoot, context.packageManager, mode);
  // Only a manager the operator named replaces another one's lockfile; a Site's own choice is never undone.
  if (context.packageManager) {
    for (const other of PHI_SITE_SCAFFOLD_PACKAGE_MANAGERS) {
      if (other === manager) continue;
      for (const lockfile of LOCKFILES[other]) {
        if (await exists(path.join(resolvedRoot, lockfile))) await unlink(path.join(resolvedRoot, lockfile));
      }
    }
  }
  const files = buildPhiSiteScaffoldFiles(mode === "init" ? context : { ...context, runtime: undefined }, manager);
  const previousFiles = mode === "reconcile" ? await readPreviousManifestFiles(resolvedRoot) : {};
  const changes: PhiSiteScaffoldChange[] = [];
  for (const [relativePath, canonical] of Object.entries(files)) {
    const target = path.join(resolvedRoot, relativePath);
    const alreadyExists = await exists(target);
    const preservedOnReconcile = PHI_SITE_OWNED_AFTER_INIT.includes(relativePath);
    if (preservedOnReconcile && alreadyExists && mode === "reconcile") {
      changes.push({ path: relativePath, action: "unchanged" });
      continue;
    }
    const desired = relativePath === "package.json" && alreadyExists
      ? mergePackageJson(await readJsonRecord(target), canonical, context.packageManager)
      : canonical;
    const current = alreadyExists ? await readFile(target, "utf8") : null;
    if (current === desired) {
      changes.push({ path: relativePath, action: "unchanged" });
      continue;
    }
    await writeAtomic(target, desired);
    changes.push({ path: relativePath, action: alreadyExists ? "repaired" : "created" });
  }
  await removeRetiredScaffoldFiles(resolvedRoot, previousFiles, files, changes);
  const manifest = {
    version: PHI_SITE_SCAFFOLD_VERSION,
    siteKey: context.siteKey,
    files: Object.fromEntries(Object.entries(files).map(([key, value]) => [key, hashContent(value)])),
  };
  await writeAtomic(path.join(resolvedRoot, ".phis/scaffold-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { version: PHI_SITE_SCAFFOLD_VERSION, root: resolvedRoot, packageManager: manager, changes } satisfies PhiSiteScaffoldResult;
}

export function runPhiSitePackageCommand(root: string, manager: PhiSiteScaffoldPackageManager, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(manager, args, { cwd: root, stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${manager} ${args.join(" ")} failed with exit code ${code ?? "unknown"}.`)));
  });
}

export function resolvePhiSiteInstallArgs(manager: PhiSiteScaffoldPackageManager, frozen: boolean) {
  if (manager === "pnpm") return ["install", frozen ? "--frozen-lockfile" : "--no-frozen-lockfile"];
  if (manager === "npm") return frozen ? ["ci"] : ["install", "--package-lock-only=false"];
  if (manager === "yarn") return ["install", ...(frozen ? ["--immutable"] : [])];
  return ["install", ...(frozen ? ["--frozen-lockfile"] : [])];
}

/**
 * Where Next put `server.js` inside `.next/standalone`.
 *
 * At the top only when the Site is its own tracing root. Inside a workspace Next traces from the
 * workspace root and nests the app under its path from there -- `.next/standalone/<site dir>/server.js`,
 * with `node_modules` at the top. The nesting is the Site's path relative to one of its ancestors, so the
 * ancestors are tried nearest first rather than the output searched.
 */
async function findStandaloneAppDirectory(siteRoot: string, standaloneRoot: string) {
  let ancestor = siteRoot;
  while (true) {
    const relative = path.relative(ancestor, siteRoot);
    if (await exists(path.join(standaloneRoot, relative, "server.js"))) return relative;
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  throw new Error("Production build did not emit server.js under .next/standalone.");
}

const SITE_RUNTIME_CONFIG = "site-runtime.json";

/**
 * Copies the build into `.phis/releases/<release id>/`.
 *
 * The release holds no `config/site-runtime.json`. That file carries the internal token and is per
 * instance, and Next's file tracer copies it into the standalone output all the same -- so it is left out
 * of the copy by name, wherever the tracer put it. The standalone server changes into its own directory
 * before it reads anything, so the release answers for the file with a relative link to the Site root's
 * copy instead: a release run from where `phis update` built it reads the Site's current file, and one
 * moved to another host is given that host's file at the link's place.
 *
 * Links inside the standalone output are copied as they are. Resolved, they would point back into
 * `.next/standalone`, which the next build replaces underneath a release that is still running.
 */
export async function buildPhiSiteReleaseArtifact(root: string): Promise<PhiSiteReleaseArtifact> {
  const resolvedRoot = path.resolve(root);
  const standaloneRoot = path.join(resolvedRoot, ".next/standalone");
  const appDirectory = await findStandaloneAppDirectory(resolvedRoot, standaloneRoot);
  const buildId = (await readFile(path.join(resolvedRoot, ".next/BUILD_ID"), "utf8")).trim();
  if (!buildId) throw new Error("Production build did not emit a BUILD_ID.");
  const packageText = await readFile(path.join(resolvedRoot, "package.json"), "utf8");
  const scaffoldText = await readFile(path.join(resolvedRoot, ".phis/scaffold-manifest.json"), "utf8");
  const releaseId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${hashContent(`${buildId}\n${packageText}\n${scaffoldText}`).slice(0, 12)}`;
  const releasesRoot = path.join(resolvedRoot, ".phis/releases");
  const target = path.join(releasesRoot, releaseId);
  const staging = path.join(releasesRoot, `.staging-${releaseId}`);
  const stagingApp = path.join(staging, appDirectory);
  await mkdir(staging, { recursive: true });
  await cp(standaloneRoot, staging, {
    recursive: true,
    force: false,
    verbatimSymlinks: true,
    filter: (source) => path.basename(source) !== SITE_RUNTIME_CONFIG,
  });
  await mkdir(path.join(stagingApp, ".next"), { recursive: true });
  await cp(path.join(resolvedRoot, ".next/static"), path.join(stagingApp, ".next/static"), { recursive: true, force: false });
  const publicDirectory = path.join(resolvedRoot, "public");
  if (await exists(publicDirectory)) {
    await cp(publicDirectory, path.join(stagingApp, "public"), { recursive: true, force: false, verbatimSymlinks: true });
  }
  await mkdir(path.join(stagingApp, "config"), { recursive: true });
  await symlink(
    path.relative(path.join(target, appDirectory, "config"), path.join(resolvedRoot, "config", SITE_RUNTIME_CONFIG)),
    path.join(stagingApp, "config", SITE_RUNTIME_CONFIG),
  );
  if (appDirectory) {
    // One command starts every release, nested or not: `node server.js` in the release directory. The
    // nested server changes into its own directory, so nothing else about it moves.
    await writeAtomic(
      path.join(staging, "server.js"),
      `// Written by phis update: Next nested this Site's server under ${appDirectory}/.\nimport(${JSON.stringify(`./${appDirectory.split(path.sep).join("/")}/server.js`)});\n`,
    );
  }
  await writeAtomic(path.join(staging, "release.json"), `${JSON.stringify({
    releaseId,
    scaffoldVersion: PHI_SITE_SCAFFOLD_VERSION,
    buildId,
    appDirectory,
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`);
  await rename(staging, target);
  return { releaseId, path: target, buildId, appDirectory };
}
