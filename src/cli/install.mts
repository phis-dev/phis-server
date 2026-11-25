import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import process from "node:process";
import { createInterface } from "node:readline/promises";

import { readMergedPhiConfigSync, readPhiRuntimeConfigSync } from "../lib/config-files-cli.ts";
import { describePhiConfiguredDirectoryProblems } from "../lib/configured-directories.ts";
import {
  closePhiSetupWindow,
  ensurePhiStageDirectories,
  formatPhiDuration,
  initPhiRuntimeKeys,
  openPhiSetupWindow,
  writePhiEmailFrom,
} from "./setup.mts";
import {
  applyAndRecordPhiServerProxyConfig,
  assertPhiProxyDomain,
  commandExists,
  detectPhiProxyKind,
  isPhiProxyInstalled,
  readPhiServerProxyRecord,
  readPhiStagePorts,
  renderPhiServerProxyConfig,
  requiredApacheModules,
  resolvePhiStageUnit,
  runPhiSystemCommand,
  type PhiProxyKind,
  type PhiServerProxyRecord,
} from "./proxy.mts";
import { printPhiEmailTestResult, runPhiEmailTest } from "./email-test.mts";
import type { FlagMap } from "./argv.mts";

/**
 * `phis install`: one command from a fresh package to a serving installation, in one of two ways.
 *
 * - `browser`: only what the browser cannot do -- the keys, the configured directories, with `--local-db`
 *   or `--admin-uri` the database, and with `--email-from` the sender -- then the setup window is opened,
 *   the service started, and the setup's address printed.
 * - `full`: everything on the command line, asked for interactively where a flag is missing: database,
 *   keys, the configured directories, the sender, schema, first operator, optionally a first Site and its
 *   administrator, optionally the web server for a domain; the setup stays closed, the service runs, and
 *   `/operator/login` is checked through the proxy.
 *
 * Every step looks first and skips what is there, so the command can be run again on an installation that
 * exists -- it then only fills gaps. Certificates are not a step: `phis proxy tls` is run by the operator,
 * on purpose, once DNS points here, and a proxy it put on HTTPS stays on HTTPS when install runs again.
 *
 * The steps that need the rest of the CLI (schema, operators, Sites) come in as `operations`, so this file
 * holds the order and the questions, not a second copy of those commands.
 */
export type PhiInstallOperations = {
  bootstrapDatabase(input: { local: boolean; adminUri: string | null; name: string | null }): Promise<void>;
  applySchema(): Promise<void>;
  addOperator(input: { email: string; password: string; name: string | null }): Promise<void>;
  countSites(): Promise<number>;
  createSite(flags: FlagMap): Promise<void>;
  grantSiteAdmin(flags: FlagMap): Promise<void>;
};

type Prompter = {
  interactive: boolean;
  ask(question: string, fallback?: string): Promise<string>;
  confirm(question: string, fallback: boolean): Promise<boolean>;
  close(): void;
};

function createPrompter(): Prompter {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  return {
    interactive,
    async ask(question, fallback) {
      if (!rl) {
        if (fallback !== undefined) return fallback;
        throw new Error(`${question} -- not given, and there is no terminal to ask on. Pass it as a flag.`);
      }
      const answer = (await rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `)).trim();
      return answer || fallback || "";
    },
    async confirm(question, fallback) {
      if (!rl) return fallback;
      const answer = (await rl.question(`${question} [${fallback ? "Y/n" : "y/N"}]: `)).trim().toLowerCase();
      return answer ? answer.startsWith("y") || answer.startsWith("j") : fallback;
    },
    close() {
      rl?.close();
    },
  };
}

function flag(flags: FlagMap, key: string) {
  const value = flags.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function step(title: string) {
  console.log(`\n== ${title}`);
}

function skip(reason: string) {
  console.log(`   skipped: ${reason}`);
}

function generatePassword() {
  return randomBytes(18).toString("base64url");
}

async function chooseMode(flags: FlagMap, prompter: Prompter): Promise<"browser" | "full"> {
  const given = flag(flags, "mode");
  if (given === "browser" || given === "full") return given;
  if (given) throw new Error(`--mode is browser or full, not "${given}".`);
  console.log("How should this installation be set up?");
  console.log("  1) in the browser: the CLI prepares what the browser cannot, then opens the setup window");
  console.log("  2) here, completely: database, keys, schema, operator, optional Site and web server");
  const answer = await prompter.ask("Choose 1 or 2");
  if (answer === "1" || answer === "browser") return "browser";
  if (answer === "2" || answer === "full") return "full";
  throw new Error(`"${answer}" is neither 1 nor 2.`);
}

async function databaseStep(
  configRoot: string,
  flags: FlagMap,
  prompter: Prompter,
  operations: PhiInstallOperations,
  required: boolean,
) {
  step("Database");
  if (readPhiRuntimeConfigSync(configRoot).database?.uri?.trim()) {
    skip("database.uri is already set");
    return true;
  }
  let adminUri = flag(flags, "admin-uri");
  let local = flags.get("local-db") === true;
  if (!adminUri && !local) {
    const localCluster = commandExists("psql") && commandExists("runuser");
    if (prompter.interactive) {
      local = localCluster && await prompter.confirm("PostgreSQL runs on this host: create the database there, as postgres?", true);
      if (!local) {
        adminUri = (await prompter.ask(required
          ? "Administrative connection (postgres://user:password@host:5432/postgres)"
          : "Administrative connection, or empty to leave the database to the browser", required ? undefined : "")) || null;
      }
    } else if (required) {
      throw new Error("No database: pass --local-db (PostgreSQL on this host) or --admin-uri <uri>.");
    }
  }
  if (!adminUri && !local) {
    skip("the setup pages ask for the database");
    return false;
  }
  await operations.bootstrapDatabase({ local, adminUri, name: flag(flags, "db-name") });
  return true;
}

function keysStep(configRoot: string) {
  step("Keys");
  const { created } = initPhiRuntimeKeys(configRoot);
  if (created.length === 0) {
    skip("all keys are present");
  } else {
    console.log(`   created ${created.join(", ")}`);
  }
}

/**
 * The media root and the two Site roots the configuration names, created for the stage's service account
 * (`src/lib/configured-directories.ts`). A directory that is there is only checked; what is wrong with one
 * is printed and does not stop the install -- `phis setup status` keeps saying so.
 */
function directoriesStep(configRoot: string) {
  step("Directories");
  const results = ensurePhiStageDirectories(configRoot);
  for (const result of results) {
    if (result.created) console.log(`   created ${result.path} (${result.setting}, mode ${result.mode.toString(8)})`);
  }
  const problems = describePhiConfiguredDirectoryProblems(results);
  for (const problem of problems) console.log(`   problem: ${problem}`);
  if (results.every((result) => !result.created) && problems.length === 0) {
    skip(`${results.map((result) => result.path).join(", ")} are in place`);
  }
}

/**
 * `email.from`, the sender of every message the server sends. Without it nothing can be mailed -- not even a
 * password reset -- so the full mode asks for it; the browser mode writes it only when it is given.
 */
async function emailStep(configRoot: string, flags: FlagMap, prompter: Prompter, ask: boolean) {
  step("Sender");
  let address = flag(flags, "email-from");
  const current = readMergedPhiConfigSync(configRoot).email?.from?.trim() ?? "";
  if (!address && current) {
    skip(`email.from is ${current}`);
    return;
  }
  if (!address && ask && prompter.interactive) {
    address = (await prompter.ask("Sender address for outgoing mail, email.from (empty to skip)", "")) || null;
  }
  if (!address) {
    skip("no --email-from; no mail can be sent until email.from is set (phis setup status warns)");
    return;
  }
  const { from, changed } = writePhiEmailFrom(configRoot, address);
  console.log(changed ? `   email.from set to ${from}` : `   email.from is ${from} already`);
}

/**
 * A test email, once there is a sender: sent here when the full mode runs in a terminal and the operator
 * says so, otherwise the command that sends one is printed. It goes out by the configured path exactly
 * (`phis email test`), so a refused sender or an unreachable relay shows now and not at the first
 * password reset.
 */
async function emailTestStep(configRoot: string, flags: FlagMap, prompter: Prompter, offer: boolean) {
  step("Test email");
  const config = readMergedPhiConfigSync(configRoot);
  if (!config.email?.from?.trim()) {
    skip("no sender (email.from) yet");
    return;
  }
  const suggested = flag(flags, "operator-email")
    ?? (config.platformSuperUsers ?? []).find((user) => user.enabled !== false)?.email?.trim()
    ?? "";
  if (!offer || !prompter.interactive || !await prompter.confirm("Send a test email now?", true)) {
    console.log(`   to check outgoing mail:  phis email test --to ${suggested || "<address>"}`);
    return;
  }
  const to = await prompter.ask("Send it to", suggested || undefined);
  try {
    const result = await runPhiEmailTest(configRoot, { to, siteKey: null }, async () => null);
    printPhiEmailTestResult(result, "   ");
  } catch (error) {
    console.log(`   not sent: ${(error as Error).message}`);
  }
}

/**
 * Started, or restarted when it already runs, so it reads the configuration this run just wrote -- the
 * server caches it for hours. Only a stage under /srv/phis/stages has a unit this knows.
 */
function serviceStep(configRoot: string) {
  step("Service");
  const unit = resolvePhiStageUnit(configRoot);
  if (!unit || !commandExists("systemctl")) {
    skip(unit ? "no systemctl on this host" : `${configRoot} is no packaged stage; start the server yourself`);
    return null;
  }
  runPhiSystemCommand("systemctl", ["enable", "-q", unit]);
  runPhiSystemCommand("systemctl", ["restart", unit]);
  console.log(`   ${unit} enabled and (re)started`);
  return unit;
}

/** The port a URL is asked on: its own, else its scheme's. */
export function resolvePhiUrlPort(target: URL) {
  return target.port || (target.protocol === "https:" ? "443" : "80");
}

/**
 * Until the address answers with anything below 500. A domain is asked for through this host's own web
 * server (`curl --resolve`), so the check proves the proxy file and does not wait for DNS.
 */
async function waitForOk(url: string, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  const target = new URL(url);
  const throughProxy = target.hostname !== "127.0.0.1" && commandExists("curl");
  let last = "";
  while (Date.now() < end) {
    try {
      if (throughProxy) {
        const result = spawnSync("curl", [
          "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5",
          "--resolve", `${target.hostname}:${resolvePhiUrlPort(target)}:127.0.0.1`, url,
        ], { encoding: "utf8" });
        const status = Number(result.stdout.trim());
        if (status > 0 && status < 500) return status;
        last = status ? `HTTP ${status}` : (result.stderr.trim() || "no answer");
      } else {
        const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
        if (response.status < 500) return response.status;
        last = `HTTP ${response.status}`;
      }
    } catch (error) {
      last = (error as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`${url} did not answer within ${timeoutMs / 1000} s (${last}).`);
}

/**
 * Whether the install writes the proxy with TLS: only when `phis proxy tls` already put this domain on
 * HTTPS behind this web server, as the stage's proxy record says.
 *
 * Install itself never obtains a certificate, so on a first run this is false. On a repeated run it keeps
 * what is there: the proxy is one of the gaps install fills, and a working HTTPS proxy is none -- writing
 * it as plain HTTP again (as 0.8.0 did) took the site off HTTPS with exit code 0. A record for another
 * domain or the other web server is a different proxy, and its certificate does not cover this one.
 * There is no flag to step down: an operator who wants plain HTTP back writes it with `phis proxy config`.
 */
export function shouldPhiInstallKeepTls(
  record: Pick<PhiServerProxyRecord, "kind" | "domain" | "tls"> | null,
  input: { kind: PhiProxyKind; domain: string },
) {
  return record?.tls === true && record.kind === input.kind && record.domain === input.domain;
}

async function proxyStep(configRoot: string, flags: FlagMap, prompter: Prompter): Promise<string | null> {
  step("Web server");
  let domain = flag(flags, "domain");
  if (!domain && prompter.interactive) {
    domain = (await prompter.ask("Domain the server answers on (empty to skip)", "")) || null;
  }
  if (!domain) {
    skip("no --domain");
    return null;
  }
  domain = assertPhiProxyDomain(domain);
  const kind: PhiProxyKind | null = detectPhiProxyKind(flag(flags, "proxy"));
  const ports = readPhiStagePorts(configRoot);
  if (!kind || !isPhiProxyInstalled(kind)) {
    skip("neither Apache nor nginx is installed; the file it would need:");
    console.log(renderPhiServerProxyConfig({ domain, tls: false, ports, kind: kind ?? "nginx" }));
    return null;
  }
  const tls = shouldPhiInstallKeepTls(readPhiServerProxyRecord(configRoot), { kind, domain });
  const result = applyAndRecordPhiServerProxyConfig(configRoot, { kind, domain, tls, ports });
  for (const done of result.steps) console.log(`   ${done.command}`);
  console.log(`   wrote ${result.path}${tls ? " over HTTPS, as phis proxy tls left it" : ""}${kind === "apache" ? ` (modules: ${requiredApacheModules(tls).join(" ")})` : ""}`);
  if (!tls) console.log(`   HTTPS: once DNS points here, run  phis proxy tls --domain ${domain} --email <you>`);
  return `${tls ? "https" : "http"}://${domain}`;
}

async function operatorStep(configRoot: string, flags: FlagMap, prompter: Prompter, operations: PhiInstallOperations) {
  step("Operator");
  const operators = (readPhiRuntimeConfigSync(configRoot).platformSuperUsers ?? []).filter((user) => user.enabled !== false);
  if (operators.length > 0) {
    skip(`${operators.length} operator(s) exist`);
    return;
  }
  const email = flag(flags, "operator-email") ?? await prompter.ask("Operator email");
  let password = flag(flags, "operator-password");
  let generated = false;
  if (!password) {
    password = prompter.interactive ? await prompter.ask("Operator password (empty: generate one)", "") : "";
    if (!password) {
      password = generatePassword();
      generated = true;
    }
  }
  await operations.addOperator({ email, password, name: flag(flags, "operator-name") });
  if (generated) {
    console.log(`   generated password for ${email}, shown only now: ${password}`);
  }
}

async function siteStep(flags: FlagMap, prompter: Prompter, operations: PhiInstallOperations) {
  step("First Site");
  if (await operations.countSites() > 0) {
    skip("a Site exists");
    return;
  }
  let key = flag(flags, "site-key");
  if (!key && prompter.interactive && await prompter.confirm("Create a first Site now?", false)) {
    key = await prompter.ask("Site key (e.g. acme)");
  }
  if (!key) {
    skip("no --site-key");
    return;
  }
  const hostname = flag(flags, "site-hostname") ?? await prompter.ask("Site host name (e.g. www.acme.example)");
  const sourceLocale = flag(flags, "site-source-locale") ?? await prompter.ask("Language the Site is written in", "en");
  const siteFlags: FlagMap = new Map<string, string | boolean>([
    ["key", key],
    ["name", flag(flags, "site-name") ?? await prompter.ask("Site name", key)],
    ["hostname", hostname],
    ["public-base-url", flag(flags, "site-public-base-url") ?? `https://${hostname}`],
    ["source-locale", sourceLocale],
    ["default-locale", flag(flags, "site-default-locale") ?? sourceLocale],
    ["support-email", flag(flags, "site-support-email") ?? await prompter.ask("Site support email")],
  ]);
  await operations.createSite(siteFlags);

  const adminEmail = flag(flags, "site-admin-email")
    ?? (prompter.interactive ? (await prompter.ask("Site administrator email (empty to skip)", "")) || null : null);
  if (!adminEmail) {
    skip("no Site administrator (phis site admin later)");
    return;
  }
  let password = flag(flags, "site-admin-password");
  const generated = !password;
  password ??= generatePassword();
  await operations.grantSiteAdmin(new Map<string, string | boolean>([
    ["site", key],
    ["email", adminEmail],
    ["password", password],
  ]));
  if (generated) {
    console.log(`   generated password for ${adminEmail}, shown only now: ${password}`);
  }
}

export async function runPhiInstall(configRoot: string, flags: FlagMap, operations: PhiInstallOperations) {
  const prompter = createPrompter();
  try {
    const mode = await chooseMode(flags, prompter);
    const port = readPhiStagePorts(configRoot)[0];

    if (mode === "browser") {
      keysStep(configRoot);
      directoriesStep(configRoot);
      await emailStep(configRoot, flags, prompter, false);
      await databaseStep(configRoot, flags, prompter, operations, false);
      step("Setup window");
      const { until } = openPhiSetupWindow(configRoot, flag(flags, "for"));
      console.log(`   open until ${until.toISOString()} (${formatPhiDuration(until.getTime() - Date.now())})`);
      serviceStep(configRoot);
      await emailTestStep(configRoot, flags, prompter, false);
      console.log(`
The setup listens on the loopback only. From your machine:
  ssh -L ${port}:127.0.0.1:${port} <user>@<this host>
then open http://127.0.0.1:${port}/setup -- before the window closes (phis setup status).`);
      return;
    }

    await databaseStep(configRoot, flags, prompter, operations, true);
    keysStep(configRoot);
    directoriesStep(configRoot);
    await emailStep(configRoot, flags, prompter, true);
    step("Schema");
    await operations.applySchema();
    await operatorStep(configRoot, flags, prompter, operations);
    await siteStep(flags, prompter, operations);
    step("Setup window");
    const { wasOpen } = closePhiSetupWindow(configRoot);
    console.log(wasOpen ? "   closed" : "   stays closed");
    const unit = serviceStep(configRoot);
    const publicBase = await proxyStep(configRoot, flags, prompter);

    step("Check");
    if (!unit) {
      skip("the service was not started here");
    } else {
      const target = `${publicBase ?? `http://127.0.0.1:${port}`}/operator/login`;
      const status = await waitForOk(target);
      console.log(`   ${target} answered ${status}`);
    }
    await emailTestStep(configRoot, flags, prompter, true);
    if (unit) console.log("\nDone. Sign in at /operator with the operator account.");
  } finally {
    prompter.close();
  }
}
