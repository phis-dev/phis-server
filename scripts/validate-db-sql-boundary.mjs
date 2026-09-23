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

/*
 * An integration test reaches the database because that is what it is for.
 *
 * `*.pg.test.ts` exists to decide what only PostgreSQL can decide -- a referential action, a row lock,
 * a rollback -- and a fixture that sets one up through the typed layer would be testing that layer
 * instead of the database under it. The boundary protects runtime code from carrying SQL; a test is
 * not runtime code and ships in no bundle.
 */
const TEST_FILE_SUFFIX = ".pg.test.ts";

/*
 * Transaction control is not a query, whatever the driver calls it.
 *
 * `BEGIN`, `COMMIT` and `ROLLBACK` read and write nothing; they frame the statements that do. They went
 * through this check as violations only because the driver spells every one of them `client.query(...)`,
 * and reporting them buried the three real findings under a dozen lines of ceremony. What the boundary
 * is about is a statement that touches a table outside `src/db/`, and none of these touches one.
 */
const TRANSACTION_CONTROL = /\.\s*query\s*\(\s*["'`](?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/iu;

/*
 * A line that says why it has to execute directly, and is believed.
 *
 * The Add-on data plane is the case: it runs SQL an Add-on brought with it, against tables an Add-on
 * owns, so there is no typed function in `src/db/` for it to call and there never can be. That is the
 * same argument the CLI is exempt on, but it holds per statement rather than per directory -- the same
 * file also touches Core tables, and those must keep failing this check.
 *
 * The marker carries a reason because an exemption without one is a silent hole, and the reason sits
 * next to the statement it excuses rather than in a list somebody has to go and find.
 */
const EXEMPTION_MARKER = /\bdb-boundary-exempt:\s*\S/u;

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
      || filePath.endsWith(TEST_FILE_SUFFIX)
    ) {
      continue;
    }
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (TRANSACTION_CONTROL.test(line) || EXEMPTION_MARKER.test(lines[index - 1] ?? "")) {
        return;
      }
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
