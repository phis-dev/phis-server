import type { OperationalMode } from "@/lib/operator-runtime";
import type { PhiStageWebServer } from "@/lib/server-proxy-record";
import {
  buildApacheConfig,
  buildCustomRuntimeNote,
  buildDockerCompose,
  buildNginxConfig,
  buildSystemdUnit,
  type SiteDeploymentRecord,
  type SiteDeploymentSettings,
} from "@/lib/site-deployment-config";

export type DeploymentBlockLabels = {
  dockerCompose: string;
  systemdUnit: string;
  customRuntime: string;
  nginxConfig: string;
  apacheConfig: string;
};

type DeploymentBlock = { title: string; code: string; collapsed?: boolean };

/**
 * The runtime snippet for the mode, then both web server snippets: the one this stage runs open and first,
 * the other collapsed, since a stage moved to the other server needs it too. Without a known server both
 * stay open in the old order, nginx first. TLS follows the stage's proxy record and applies only to the
 * server it names; the other one has no certificate on this host.
 */
export function buildDeploymentBlocks(
  site: SiteDeploymentRecord,
  mode: OperationalMode,
  labels: DeploymentBlockLabels,
  siteSettings: SiteDeploymentSettings,
  webServer: PhiStageWebServer,
): DeploymentBlock[] {
  const runtime =
    mode === "docker"
      ? { title: labels.dockerCompose, code: buildDockerCompose(site, siteSettings) }
      : mode === "systemd"
        ? { title: labels.systemdUnit, code: buildSystemdUnit(site, siteSettings) }
        : { title: labels.customRuntime, code: buildCustomRuntimeNote(site, siteSettings) };
  const nginx = {
    title: labels.nginxConfig,
    code: buildNginxConfig(site, siteSettings, { tls: webServer.kind === "nginx" && webServer.tls }),
  };
  const apache = {
    title: labels.apacheConfig,
    code: buildApacheConfig(site, siteSettings, { tls: webServer.kind === "apache" && webServer.tls }),
  };
  if (webServer.kind === null) {
    return [runtime, nginx, apache];
  }
  const [primary, other] = webServer.kind === "apache" ? [apache, nginx] : [nginx, apache];
  return [runtime, primary, { ...other, collapsed: true }];
}
