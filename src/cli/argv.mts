/**
 * Reading a `phis` command line.
 *
 * A flag is read by what the command it belongs to says it is. Without that the parser has to guess
 * from the next word: a value that begins with `-` -- a password, a negative number -- reads as the
 * start of the next flag, the flag silently turns into `true`, and a command that treats `true` as
 * "not given" does something other than what was typed. Knowing each command's flags settles that, and
 * it lets a mistyped flag stop the command instead of being ignored while the command runs without it.
 */

export type FlagMap = Map<string, string | boolean>;
export type ParsedArgv = {
  flags: FlagMap;
  positionals: string[];
};

type FlagKind = "string" | "boolean";
type FlagSpec = Record<string, FlagKind>;

export const SHORT_FLAG_ALIASES = new Map<string, string>([
  ["e", "email"],
  ["u", "public-base-url"],
  ["h", "hostname"],
  ["k", "key"],
  ["l", "locale"],
  ["p", "password"],
  ["n", "name"],
  ["d", "disabled"],
  ["j", "json"],
  ["r", "root"],
]);

const GLOBAL_FLAGS: FlagSpec = { json: "boolean", root: "string" };

const S = "string" as const;
const B = "boolean" as const;

/**
 * Every command and the flags it reads, keyed by the words that name it.
 *
 * `src/cli/argv.test.ts` checks this against the flags the dispatcher and its helpers actually read, so
 * a new flag cannot be read without being listed here.
 */
export const PHIS_COMMAND_FLAGS: Record<string, FlagSpec> = {
  "config": {},
  "config paths": {},
  "config validate": {},

  "schema check": {},
  "schema apply": {},
  "schema drop": { force: B },

  "db bootstrap": {
    "admin-uri": S, name: S, database: S, role: S, "migration-role": S,
    password: S, "migration-password": S, force: B,
  },

  "site list": { key: S },
  "site add": {
    key: S, name: S, hostname: S, "public-base-url": S, "source-locale": S, "default-locale": S,
    "available-locales": S, "support-email": S, email: S,
  },
  "site set": { key: S, name: S, hostname: S, "public-base-url": S, "support-email": S, email: S },
  "site enable": { key: S },
  "site disable": { key: S },
  "site del": { key: S },
  "site locale add": { key: S, locale: S },
  "site admin": { site: S, email: S, password: S, "first-name": S, "last-name": S, list: B, revoke: B },
  "site user": { site: S, email: S, password: S, overwrite: B },
  "site check": { key: S, url: S },
  "site config set source": { key: S, "source-host": S, "source-port": S, "source-path": S },
  "site config add": { key: S, "instance-host": S, "instance-port": S, "instance-path": S },
  "site config del": { key: S, "instance-host": S },
  "site config nginx": { key: S, source: B },
  "site config apache": { key: S },
  "site config systemd": { key: S, instance: S },
  "site config docker-compose": { key: S },
  "site config runtime": { key: S },

  "init": { path: S, "package-manager": S, "api-base-url": S, install: B },
  "reconcile": { path: S, "package-manager": S, install: B },
  "update": { path: S, "package-manager": S },

  "module list": { site: S },
  "module add": { site: S, package: S, spec: S, path: S },
  "module del": { site: S, package: S, force: B, path: S },
  "module sync": { site: S, path: S },
  "module check": { site: S, package: S, path: S },

  "addon list": {},
  "addon check": {},
  "addon install": { artifact: S },
  "addon upgrade": { addon: S, artifact: S, repackage: B },
  "addon migrate": { addon: S },
  "addon enable": { addon: S },
  "addon disable": { addon: S },
  "addon reconcile": {},
  "addon remove": { addon: S },
  "addon purge": { addon: S },
  "addon forget": { addon: S },
  "addon site": { addon: S, site: S, enable: B, disable: B, "without-module": B },
  "addon config": { addon: S, site: S, name: S, value: S },
  // `--revoke` names a role here, where `site admin --revoke` is a switch: the reason this table is per
  // command rather than one list of names.
  "addon role": { site: S, addon: S, user: S, grant: S, revoke: S },
  "addon owner": { addon: S, site: S, from: S, to: S },
  "addon storage": {
    addon: S, site: S, "quota-bytes": S, "max-objects": S, unlimited: B, sweep: B, recount: B,
  },
  "addon job": { addon: S, job: S, site: S, "api-base-url": S, pause: B, resume: B },
  "addon jobs": { addon: S, site: S, limit: S },

  "mail drain": { limit: S, "api-base-url": S },

  "storage list": { site: S },
  "storage add": { site: S, key: S, provider: S, config: S, "secret-name": S, "secret-reference": S },
  "storage set": { site: S, key: S, config: S, replace: B, "secret-name": S, "secret-reference": S },
  "storage use": { site: S, key: S },
  "storage del": { site: S, key: S },
  "storage cors": {},
  "storage probe": { site: S, key: S },

  "secret init-key": {},
  "secret set": { name: S, site: S, addon: S, value: S },
  "secret check": { name: S, site: S, addon: S },
  "secret list": { site: S, addon: S },
  "secret del": { name: S, site: S, addon: S },

  "auth restore-preset": { site: S },
  "auth import-secrets": {},

  "operator list": { email: S },
  "operator add": { email: S, password: S, name: S, disabled: B },
  "operator passwd": { email: S, password: S },
  "operator enable": { email: S },
  "operator disable": { email: S },
  "operator del": { email: S },

  "media check": { fix: B },
  "maintain": { list: B, task: S, "dry-run": B },
  "licenses check": { package: S },

  "instance list": { "stale-after": S },
  "instance drain": { id: S },
  "instance prune": { "forget-after": S },
};

type Token =
  | { kind: "positional"; value: string }
  | { kind: "flag"; raw: string; name: string | undefined; inline: string | undefined };

function readToken(current: string): Token {
  if (!current.startsWith("-") || current === "-") {
    return { kind: "positional", value: current };
  }
  const isLongFlag = current.startsWith("--");
  const body = current.slice(isLongFlag ? 2 : 1);
  const equals = isLongFlag ? body.indexOf("=") : -1;
  const rawName = equals >= 0 ? body.slice(0, equals) : body;
  return {
    kind: "flag",
    raw: isLongFlag ? `--${rawName}` : current,
    name: isLongFlag ? rawName : SHORT_FLAG_ALIASES.get(rawName),
    inline: equals >= 0 ? body.slice(equals + 1) : undefined,
  };
}

/**
 * The words that name the command, found before the command's own flags are known.
 *
 * Only the global flags have a known kind at this point; any other flag is assumed to take the next word
 * unless that word looks like a flag. Every usage line puts the command's words first, so this can only
 * go wrong for a line that also puts a flag before them, and then the second pass reports it.
 */
function findCommandPositionals(argv: readonly string[]) {
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = readToken(argv[index]);
    if (token.kind === "positional") {
      positionals.push(token.value);
      continue;
    }
    if (token.inline !== undefined) continue;
    const kind = token.name ? GLOBAL_FLAGS[token.name] : undefined;
    if (kind === "boolean") continue;
    const next = argv[index + 1];
    if (next !== undefined && (kind === "string" || !next.startsWith("-"))) {
      index += 1;
    }
  }
  return positionals;
}

/** The longest run of leading words that names a command, or null for a line no command matches. */
export function resolvePhisCommand(positionals: readonly string[]) {
  for (let length = Math.min(positionals.length, 4); length > 0; length -= 1) {
    const key = positionals.slice(0, length).join(" ");
    if (key in PHIS_COMMAND_FLAGS) {
      return key;
    }
  }
  return null;
}

/**
 * Parses a command line against the flags its command reads.
 *
 * - `--flag value` and `--flag=value` set a string; the value is taken as it is, so `--password -x`,
 *   `--password=-x` and `--value ""` all arrive.
 * - A switch takes no value, and `--force=yes` is refused rather than read as anything.
 * - A flag the command does not read is refused.
 *
 * A line that names no command is parsed by the global flags alone and handed on, so the dispatcher can
 * say which command it did not recognise.
 */
export function parsePhisArgv(argv: readonly string[]): ParsedArgv & { command: string | null } {
  const command = resolvePhisCommand(findCommandPositionals(argv));
  const spec: FlagSpec | null = command === null ? null : { ...GLOBAL_FLAGS, ...PHIS_COMMAND_FLAGS[command] };
  const flags: FlagMap = new Map();
  const positionals: string[] = [];
  const label = command === null ? "phis" : `phis ${command}`;

  for (let index = 0; index < argv.length; index += 1) {
    const token = readToken(argv[index]);
    if (token.kind === "positional") {
      positionals.push(token.value);
      continue;
    }
    if (!token.name) {
      throw new Error(`Unknown flag: ${token.raw}`);
    }
    const kind = spec ? spec[token.name] : GLOBAL_FLAGS[token.name];
    if (!kind) {
      if (spec) {
        throw new Error(`${label} does not take ${token.raw}. See phis --help.`);
      }
      // No command matched: keep what can be kept, and let the dispatcher name the command it refuses.
      const next = argv[index + 1];
      if (token.inline !== undefined) {
        flags.set(token.name, token.inline);
      } else if (next !== undefined && !next.startsWith("-")) {
        flags.set(token.name, next);
        index += 1;
      } else {
        flags.set(token.name, true);
      }
      continue;
    }
    if (kind === "boolean") {
      if (token.inline !== undefined) {
        throw new Error(`${token.raw} is a switch and takes no value.`);
      }
      flags.set(token.name, true);
      continue;
    }
    if (token.inline !== undefined) {
      flags.set(token.name, token.inline);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined) {
      throw new Error(`${token.raw} needs a value.`);
    }
    flags.set(token.name, next);
    index += 1;
  }

  return { command, flags, positionals };
}
