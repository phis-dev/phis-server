import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readPhiDatabaseNamesFromUris } from "./db-bootstrap.mts";
import {
  mergePhiServerProxyRecord,
  planPhiServerProxyRemoval,
  readPhiServerProxyRecord,
  writePhiServerProxyRecord,
  type PhiServerProxyApplyResult,
  type PhiServerProxyRecord,
} from "./proxy.mts";
import { archivePhiStageConfig, listPhiOtherStages, resolvePhiStageName } from "./stage.mts";

function applied(content: string, enabledModules: string[] = []): PhiServerProxyApplyResult {
  return { path: "/etc/apache2/sites-available/phis.conf", steps: [], content, enabledModules };
}

describe("the proxy record", () => {
  it("keeps the modules and the certificate of every earlier run", () => {
    const first = mergePhiServerProxyRecord(null, {
      kind: "apache",
      domain: "api.example.com",
      tls: false,
      result: applied("a", ["proxy_balancer", "lbmethod_byrequests", "slotmem_shm"]),
    }, new Date("2026-11-14T00:00:00Z"));
    expect(first.certificate).toBeNull();
    const tls = mergePhiServerProxyRecord(first, {
      kind: "apache",
      domain: "api.example.com",
      tls: true,
      result: applied("b", ["ssl"]),
      certificate: "api.example.com",
    });
    expect(tls.enabledModules).toEqual(["proxy_balancer", "lbmethod_byrequests", "slotmem_shm", "ssl"]);
    expect(tls.certificate).toBe("api.example.com");
    // A later plain `proxy config` for the same domain does not forget the certificate it is served with.
    const again = mergePhiServerProxyRecord(tls, { kind: "apache", domain: "api.example.com", tls: true, result: applied("c") });
    expect(again.certificate).toBe("api.example.com");
    expect(again.enabledModules).toContain("ssl");
    // Another domain is another certificate's business.
    const moved = mergePhiServerProxyRecord(tls, { kind: "apache", domain: "new.example.com", tls: false, result: applied("d") });
    expect(moved.certificate).toBeNull();
  });

  it("is read back from the stage it was written to", () => {
    const root = mkdtempSync(path.join(tmpdir(), "phis-stage-"));
    expect(readPhiServerProxyRecord(root)).toBeNull();
    const record = mergePhiServerProxyRecord(null, { kind: "nginx", domain: "api.example.com", tls: false, result: applied("x") });
    const file = writePhiServerProxyRecord(root, record);
    expect(file).toBe(path.join(root, "config", "phis-proxy.json"));
    expect(readPhiServerProxyRecord(root)).toEqual(record);
    writeFileSync(file, JSON.stringify({ version: 2 }));
    expect(() => readPhiServerProxyRecord(root)).toThrow(/not a proxy record/);
  });
});

describe("removing a recorded proxy", () => {
  function recordFor(directory: string, content: string): PhiServerProxyRecord {
    const available = path.join(directory, "sites-available", "phis.conf");
    const enabled = path.join(directory, "sites-enabled", "phis.conf");
    mkdirSync(path.dirname(available), { recursive: true });
    mkdirSync(path.dirname(enabled), { recursive: true });
    writeFileSync(available, content);
    symlinkSync(available, enabled);
    return {
      ...mergePhiServerProxyRecord(null, {
        kind: "nginx",
        domain: "api.example.com",
        tls: false,
        result: { path: available, steps: [], content, enabledModules: [] },
      }),
      enabledPath: enabled,
      acmeWebroot: path.join(directory, "acme-not-there"),
    };
  }

  it("removes the file only while it is what phis wrote", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "phis-proxy-"));
    const record = recordFor(directory, "server {}\n");
    expect(planPhiServerProxyRemoval(record)).toMatchObject({ fileState: "unchanged", enabled: true, acmeWebroot: null });
    writeFileSync(record.path, "server { # edited }\n");
    expect(planPhiServerProxyRemoval(record).fileState).toBe("changed");
  });

  it("knows a link that points elsewhere is not its own", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "phis-proxy-"));
    const record = recordFor(directory, "server {}\n");
    const elsewhere = { ...record, path: path.join(directory, "sites-available", "other.conf") };
    writeFileSync(elsewhere.path, "server {}\n");
    expect(planPhiServerProxyRemoval(elsewhere).enabled).toBe(false);
  });
});

describe("a stage", () => {
  it("is named by its directory, and nothing else is one", () => {
    expect(resolvePhiStageName("/srv/phis/stages/prod")).toBe("prod");
    expect(resolvePhiStageName("/srv/phis/stages/prod/")).toBe("prod");
    expect(resolvePhiStageName("/srv/phis/stages")).toBeNull();
    expect(resolvePhiStageName("/opt/elsewhere")).toBeNull();
  });

  it("lists the other stages, not itself", () => {
    const stages = mkdtempSync(path.join(tmpdir(), "phis-stages-"));
    for (const name of ["prod", "dev", "test"]) mkdirSync(path.join(stages, name));
    writeFileSync(path.join(stages, "README"), "");
    expect(listPhiOtherStages("prod", stages)).toEqual(["dev", "test"]);
    expect(listPhiOtherStages("prod", path.join(stages, "missing"))).toEqual([]);
  });

  it("finds the names its database was made with in the connection strings", () => {
    expect(readPhiDatabaseNamesFromUris(
      "postgresql://phis_prod_user:secret@127.0.0.1:5432/phis_prod",
      "postgresql://phis_prod_migrator:other@127.0.0.1:5432/phis_prod?sslmode=disable",
    )).toEqual({ databaseName: "phis_prod", servingRole: "phis_prod_user", migrationRole: "phis_prod_migrator" });
    expect(readPhiDatabaseNamesFromUris(null, "not a uri")).toEqual({
      databaseName: null,
      servingRole: null,
      migrationRole: null,
    });
  });

  it("backs up its configuration and secrets readable by nobody else, and never over a file", () => {
    const root = mkdtempSync(path.join(tmpdir(), "phis-stage-"));
    mkdirSync(path.join(root, "config"));
    writeFileSync(path.join(root, "config", "phis-runtime.json"), "{}");
    writeFileSync(path.join(root, ".env"), "PORT=5301\n");
    const target = path.join(mkdtempSync(path.join(tmpdir(), "phis-backup-")), "prod.tar.gz");
    const archive = archivePhiStageConfig(root, target);
    expect(archive.entries).toEqual(["config", ".env"]);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    const listing = spawnSync("tar", ["-tzf", target], { encoding: "utf8" }).stdout;
    expect(listing).toContain("config/phis-runtime.json");
    expect(listing).toContain(".env");
    expect(readFileSync(target).length).toBeGreaterThan(0);
    expect(() => archivePhiStageConfig(root, target)).toThrow(/exists/);
  });
});
