import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const sourceRoot = path.join(root, "src");
const databaseRoot = path.join(sourceRoot, "db");
/*
 * The operator tool executes directly, by the exemption in AGENTS.md: it holds the migration
 * connection, applies DDL, and reaches no Client bundle -- the opposite of what the boundary protects.
 * It also cannot import the database layer, because those modules are marked `server-only` and that
 * marker is the Client boundary nobody wants to give up.
 *
 * Exempt here rather than left to fail: a check that is permanently red is a check nobody reads, and
 * this one exists to catch a runtime query written outside `src/db/`.
 */
const cliRoot = path.join(sourceRoot, "cli");
const sourceExtensions = new Set([".ts", ".tsx", ".mts"]);
const violations = [];

function visit(directory) {
  for (const entry of readdirSync(directory)) {
    const filePath = path.join(directory, entry);
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      visit(filePath);
      continue;
    }
    if (
      !sourceExtensions.has(path.extname(filePath))
      || filePath.startsWith(databaseRoot)
      || filePath.startsWith(cliRoot)
    ) {
      continue;
    }
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/u);
    lines.forEach((line, index) => {
      // `[(<]`, not just `(`: a typed call writes its row shape between the two, as
      // `client.query<{ id: number }>(...)`, and looking only for the parenthesis let every such
      // call through -- which is most of them, because the rows have to be typed somewhere. The
      // boundary went unenforced for exactly the queries big enough to want a type.
      if (/\.(?:query|execute)\s*[(<]/u.test(line)) {
        violations.push(`${path.relative(root, filePath)}:${index + 1}`);
      }
    });
  }
}

visit(sourceRoot);
if (violations.length > 0) {
  process.stderr.write(
    `Direct database execution is only allowed under src/db:\n${violations.join("\n")}\n`,
  );
  process.exitCode = 1;
}
