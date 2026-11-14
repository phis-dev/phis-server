import { describe, expect, it } from "vitest";

import { buildDeploymentBlocks } from "./deployment-blocks";

const site = { id: 3, key: "acme", name: "ACME", hostname: "www.acme.test" };
const labels = {
  dockerCompose: "compose",
  systemdUnit: "unit",
  customRuntime: "runtime",
  nginxConfig: "nginx",
  apacheConfig: "apache",
};
const settings = { basePort: 52000 };

const summary = (blocks: ReturnType<typeof buildDeploymentBlocks>) =>
  blocks.map((block) => `${block.title}${block.collapsed ? " (collapsed)" : ""}`);

describe("the deployment snippets of a Site", () => {
  it("offers both web servers in every mode, the stage's first and the other collapsed", () => {
    const apache = { kind: "apache" as const, tls: false };
    expect(summary(buildDeploymentBlocks(site, "systemd", labels, settings, apache))).toEqual([
      "unit",
      "apache",
      "nginx (collapsed)",
    ]);
    const nginx = { kind: "nginx" as const, tls: false };
    expect(summary(buildDeploymentBlocks(site, "docker", labels, settings, nginx))).toEqual([
      "compose",
      "nginx",
      "apache (collapsed)",
    ]);
  });

  it("keeps both open, nginx first, when the web server is unknown", () => {
    const unknown = { kind: null, tls: false };
    expect(summary(buildDeploymentBlocks(site, "custom", labels, settings, unknown))).toEqual([
      "runtime",
      "nginx",
      "apache",
    ]);
  });

  it("puts TLS only into the snippet of the server the record names", () => {
    const blocks = buildDeploymentBlocks(site, "systemd", labels, settings, { kind: "apache", tls: true });
    expect(blocks[1].code).toContain("<VirtualHost *:443>");
    expect(blocks[2].code).not.toContain("443");
  });
});
