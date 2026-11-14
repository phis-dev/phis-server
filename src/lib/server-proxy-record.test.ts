import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolvePhiStageWebServer } from "./server-proxy-record.ts";

const roots: string[] = [];

function stageRoot(record?: object) {
  const root = mkdtempSync(path.join(os.tmpdir(), "phis-proxy-record-"));
  roots.push(root);
  if (record) {
    mkdirSync(path.join(root, "config"));
    writeFileSync(path.join(root, "config", "phis-proxy.json"), JSON.stringify(record));
  }
  return root;
}

const hostWith = (...dirs: string[]) => (file: string) => dirs.includes(file);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the web server in front of a stage", () => {
  it("is the one the proxy record names, with its TLS, whatever else is installed", () => {
    const root = stageRoot({ version: 1, kind: "apache", tls: true, path: "/etc/apache2/sites-available/phis.conf" });
    expect(resolvePhiStageWebServer(root, hostWith("/etc/nginx"))).toEqual({ kind: "apache", tls: true });
  });

  it("is the installed one without a record, never over TLS", () => {
    const root = stageRoot();
    expect(resolvePhiStageWebServer(root, hostWith("/etc/nginx"))).toEqual({ kind: "nginx", tls: false });
    expect(resolvePhiStageWebServer(root, hostWith("/etc/apache2"))).toEqual({ kind: "apache", tls: false });
  });

  it("is unknown when the host has neither or both", () => {
    const root = stageRoot();
    expect(resolvePhiStageWebServer(root, hostWith()).kind).toBeNull();
    expect(resolvePhiStageWebServer(root, hostWith("/etc/apache2", "/etc/nginx")).kind).toBeNull();
  });

  it("refuses a record it cannot read rather than guessing", () => {
    const root = stageRoot({ version: 2, kind: "apache", path: "/x" });
    expect(() => resolvePhiStageWebServer(root, hostWith())).toThrow(/not a proxy record/);
  });
});
