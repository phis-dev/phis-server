#!/usr/bin/env node
/**
 * Writes docs/API.md from the route handlers under src/app.
 *
 * The reference is derived, never written by hand: the two hand-written API references this repository
 * had described routes that no longer existed and missed most that did. Every entry here comes from a
 * `route.ts` -- its address from the folder, its methods from the handler exports, who may call it from
 * the guards the handler calls, and its description from the doc comment on the handler, when it has one.
 *
 * usage: node scripts/generate-api-reference.mjs           write docs/API.md
 *        node scripts/generate-api-reference.mjs --check   fail when docs/API.md is not what the code says
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = path.join(repositoryRoot, "src/app");
const guardsRoot = path.join(repositoryRoot, "src/lib");
const outputPath = path.join(repositoryRoot, "docs/API.md");
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

async function collectFiles(directory, predicate) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await collectFiles(full, predicate));
    else if (predicate(entry.name)) found.push(full);
  }
  return found;
}

/** `src/app/api/site/media/[id]/variants/[variantKey]/route.ts` -> `/api/site/media/{id}/variants/{variantKey}` */
function addressOf(routeFile) {
  const segments = path.relative(appRoot, path.dirname(routeFile)).split(path.sep).filter(Boolean);
  const address = segments
    .filter((segment) => !/^\(.*\)$/.test(segment))
    .map((segment) => segment
      .replace(/^\[\[\.\.\.(.+)\]\]$/, "{...$1?}")
      .replace(/^\[\.\.\.(.+)\]$/, "{...$1}")
      .replace(/^\[(.+)\]$/, "{$1}"))
    .join("/");
  return `/${address}`;
}

/** The doc comment directly above an export, as plain text, first paragraph only. */
function docCommentBefore(source, index) {
  const before = source.slice(0, index).trimEnd();
  if (!before.endsWith("*/")) return null;
  const start = before.lastIndexOf("/**");
  if (start < 0) return null;
  const text = before
    .slice(start + 3, -2)
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .join("\n")
    .trim();
  const paragraph = text.split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").trim();
  return paragraph || null;
}

/** Each exported method with the part of the file that belongs to it. */
function handlersOf(source) {
  const exports = [];
  const pattern = new RegExp(
    `export\\s+(?:async\\s+)?(?:function\\s+(${METHODS.join("|")})\\b|const\\s+(${METHODS.join("|")})\\s*=)`,
    "g",
  );
  for (const match of source.matchAll(pattern)) {
    exports.push({ method: match[1] ?? match[2], index: match.index });
  }
  return exports
    .sort((left, right) => left.index - right.index)
    .map((entry, position, all) => ({
      method: entry.method,
      body: source.slice(entry.index, all[position + 1]?.index ?? source.length),
      description: docCommentBefore(source, entry.index),
    }));
}

/**
 * What each `require...Context` guard admits, read from the guard files themselves: the access policy it
 * passes, as the constant or literal written there. A guard whose policy cannot be read is listed by name.
 */
async function readGuardPolicies() {
  const policies = new Map();
  const files = await collectFiles(guardsRoot, (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const pattern = /export async function (require[A-Za-z]+)\s*\(/g;
    const matches = [...source.matchAll(pattern)];
    matches.forEach((match, position) => {
      const body = source.slice(match.index, matches[position + 1]?.index ?? source.length);
      const constant = /policy:\s*(PHI_ACCESS_[A-Z_]+)/.exec(body)?.[1];
      const literal = /policy:\s*\{\s*access:\s*"([a-z-]+)"/.exec(body)?.[1];
      const policy = constant
        ? constant.replace(/^PHI_ACCESS_/, "").toLowerCase().replace(/_/g, "-")
        : literal ?? null;
      policies.set(match[1], policy);
    });
  }
  return policies;
}

/** Checks a handler makes by other means than a guard. Their names are the whole claim, so keep them exact. */
const OWN_CHECKS = [
  [/\bgetOperatorSessionFromRequest\(/, "operator session"],
  [/\bisBootstrapEnabled\(/, "setup mode (`bootstrap.enabled`)"],
  [/\bverifyCsrfRequest\(/, "CSRF token"],
  [/\bgetSessionFromRequest\(/, "Site session, checked in the handler"],
  [/\bcanDeliverMediaAsset\(/, "Asset delivery policy (public Assets need no session)"],
  [/\bdispatchPhisAddonRequest\(/, "decided per route by the Add-on dispatcher (SERVER_ADDONS.md)"],
];

function accessOf(code, guardPolicies) {
  const access = [];
  for (const [pattern, label] of OWN_CHECKS) {
    if (pattern.test(code)) access.push(label);
  }
  for (const match of code.matchAll(/guardApiV1\(\s*[a-zA-Z]+\s*(?:,\s*(\{[^}]*\}))?\s*\)/g)) {
    const options = match[1] ?? "";
    if (/requireInternalToken:\s*true/.test(options)) access.push("internal token");
    else if (/allowMissingToken:\s*true/.test(options)) access.push("API token optional");
    else access.push("API token (public or internal)");
  }
  for (const match of code.matchAll(/\b(require[A-Z][A-Za-z]*(?:Context|ApiContext))\(/g)) {
    const policy = guardPolicies.get(match[1]);
    access.push(policy ? `session, \`${policy}\` (${match[1]})` : `session (${match[1]})`);
  }
  return [...new Set(access)];
}

function groupOf(address) {
  const segments = address.split("/").filter(Boolean);
  if (segments[0] !== "api") return "Other routes";
  if (segments[1] === "v1") return `/api/v1/${segments[2] ?? ""}`.replace(/\/$/, "");
  return `/api/${segments[1] ?? ""}`.replace(/\/$/, "");
}

const GROUP_INTRO = {
  "/api/v1": "Versioned API a Site calls server-to-server with its token (`x-phis-token`), and the public endpoints under it.",
  "/api/site": "Site administration, CMS, media and support API. A Site's `/api/site` proxy forwards the visitor's session.",
  "/api/auth": "Session-based account endpoints a Site's `/api/auth` proxy forwards.",
  "/api/operator": "Operator console authentication.",
};

/**
 * Many handlers only call a shared implementation (`return handleSiteCmsAreaWrite(request)`), so the guard
 * sits one module away. Follow each function a handler imports from `@/lib` or `@/db` one level and read the
 * guards in its body.
 */
async function delegatedCode(handlerBody, source) {
  const imports = new Map();
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*"@\/((?:lib|db)\/[^"]+)"/g)) {
    for (const name of match[1].split(",").map((part) => part.replace(/^type\s+/, "").split(/\s+as\s+/).pop().trim())) {
      if (name) imports.set(name, match[2]);
    }
  }
  let code = "";
  for (const [name, modulePath] of imports) {
    if (!new RegExp(`\\b${name}\\(`).test(handlerBody)) continue;
    const candidates = [`${modulePath}.ts`, `${modulePath}/index.ts`, `${modulePath}.tsx`];
    for (const candidate of candidates) {
      const moduleSource = await readFile(path.join(repositoryRoot, "src", candidate), "utf8").catch(() => null);
      if (!moduleSource) continue;
      const start = moduleSource.search(new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`));
      if (start < 0) break;
      const next = moduleSource.slice(start + 1).search(/\nexport\s/);
      const body = moduleSource.slice(start, next < 0 ? moduleSource.length : start + 1 + next);
      code += body;
      // And the module's own functions that body calls, one level: `handleX` is often `return doX(request)`.
      for (const call of body.matchAll(/\b([a-zA-Z_][A-Za-z0-9_]*)\(/g)) {
        const local = moduleSource.search(new RegExp(`\\n(?:export\\s+)?(?:async\\s+)?function\\s+${call[1]}\\b`));
        if (local < 0 || call[1] === name) continue;
        const localNext = moduleSource.slice(local + 1).search(/\n(?:export\s+)?(?:async\s+)?function\s/);
        code += moduleSource.slice(local, localNext < 0 ? moduleSource.length : local + 1 + localNext);
      }
      break;
    }
  }
  return code;
}

async function render() {
  const guardPolicies = await readGuardPolicies();
  const routeFiles = await collectFiles(appRoot, (name) => name === "route.ts");
  const routes = [];
  for (const file of routeFiles) {
    const source = await readFile(file, "utf8");
    const handlers = handlersOf(source);
    if (handlers.length === 0) continue;
    const fileAccess = accessOf(source, guardPolicies);
    const fileDescription = /^\s*\/\*\*/.test(source) ? docCommentBefore(`${source.slice(0, source.indexOf("*/") + 2)}`, source.indexOf("*/") + 2) : null;
    routes.push({
      address: addressOf(file),
      source: path.relative(repositoryRoot, file).split(path.sep).join("/"),
      description: fileDescription,
      handlers: await Promise.all(handlers.map(async (handler) => {
        const own = accessOf(handler.body, guardPolicies);
        const delegated = own.length > 0 ? [] : accessOf(await delegatedCode(handler.body, source), guardPolicies);
        return {
          method: handler.method,
          description: handler.description,
          // A handler that delegates to a helper in the same file carries no guard call of its own.
          access: own.length > 0 ? own : delegated.length > 0 ? delegated : fileAccess,
        };
      })),
    });
  }
  routes.sort((left, right) => left.address.localeCompare(right.address));

  const groups = new Map();
  for (const route of routes) {
    const group = groupOf(route.address);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(route);
  }

  const lines = [
    "# HTTP API reference",
    "",
    "<!-- Generated by scripts/generate-api-reference.mjs from src/app/**/route.ts. Do not edit by hand. -->",
    "",
    "Every route handler of phis, derived from the code. **Access** names what the handler checks before it",
    "answers: `internal token` is the Site token (`x-phis-token`) with internal scope, `API token` accepts a",
    "public or internal token, and `session` is the visitor's Site session with the access policy the guard",
    "passes (see [AUTHORIZATION.md](../AUTHORIZATION.md)). A route with no access entry performs its own checks",
    "or none; read its source. Request and response shapes are not listed; the source is linked per route.",
    "",
    `${routes.length} routes.`,
    "",
    "## Contents",
    "",
    ...[...groups.keys()].map((group) => `- [\`${group}\`](#${group.replace(/[^a-z0-9]+/gi, "").toLowerCase()}) (${groups.get(group).length})`),
    "",
  ];
  for (const [group, groupRoutes] of groups) {
    lines.push(`## \`${group}\``, "");
    const intro = GROUP_INTRO[group] ?? GROUP_INTRO[group.split("/").slice(0, 3).join("/")];
    if (intro) lines.push(intro, "");
    lines.push("| Method | Address | Access | Description |", "|---|---|---|---|");
    for (const route of groupRoutes) {
      for (const handler of route.handlers) {
        const description = handler.description ?? route.description ?? "";
        const access = handler.access.length > 0 ? handler.access.join("; ") : "--";
        lines.push(
          `| ${handler.method} | [\`${route.address}\`](../${route.source}) | ${access} | ${description.replace(/\|/g, "\\|")} |`,
        );
      }
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

const output = await render();
if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== output) {
    console.error("docs/API.md is out of date; run `pnpm docs:api`.");
    process.exit(1);
  }
  console.log("docs/API.md matches the route handlers.");
} else {
  await writeFile(outputPath, output);
  console.log(`Wrote docs/API.md.`);
}
