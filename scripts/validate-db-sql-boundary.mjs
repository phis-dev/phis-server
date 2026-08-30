import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const sourceRoot = path.join(root, "src");
const databaseRoot = path.join(sourceRoot, "db");
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
    if (!sourceExtensions.has(path.extname(filePath)) || filePath.startsWith(databaseRoot)) {
      continue;
    }
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (/\.(?:query|execute)\s*\(/u.test(line)) {
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
