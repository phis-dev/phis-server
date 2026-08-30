import "server-only";

import { statfsSync } from "node:fs";
import os from "node:os";
import packageJson from "../../package.json";

import { getPhiAppRoot } from "@/lib/app-paths";
import { readMergedPhiConfigSync } from "@/lib/config-files";

export type OperationalMode = "docker" | "systemd" | "custom";

export type OperatorOverviewSnapshot = {
  collectedAt: string;
  osLabel: string;
  nodeVersion: string;
  nextVersion: string;
  reactVersion: string;
  cpuCount: number;
  load1: number;
  load5: number;
  load15: number;
  cpuUsageRatio: number;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  usedMemoryBytes: number;
  memoryUsageRatio: number;
  diskTotalBytes: number;
  diskFreeBytes: number;
  diskUsedBytes: number;
  diskUsageRatio: number;
  uptimeSeconds: number;
};

function clampRatio(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  if (value >= 1) {
    return 1;
  }

  return value;
}

export function resolveOperationalMode(): OperationalMode {
  const config = readMergedPhiConfigSync();
  if (config.runtime?.containerized === true) {
    return "docker";
  }

  if (process.env.INVOCATION_ID || process.env.SYSTEMD_EXEC_PID || process.env.JOURNAL_STREAM) {
    return "systemd";
  }

  return "custom";
}

export function readOperatorOverviewSnapshot(): OperatorOverviewSnapshot {
  const appRoot = getPhiAppRoot();
  const cpuCount = Math.max(os.cpus().length, 1);
  const [load1, load5, load15] = os.loadavg();
  const totalMemoryBytes = os.totalmem();
  const freeMemoryBytes = os.freemem();
  const usedMemoryBytes = Math.max(totalMemoryBytes - freeMemoryBytes, 0);
  const memoryUsageRatio = totalMemoryBytes > 0 ? usedMemoryBytes / totalMemoryBytes : 0;

  const fsStats = statfsSync(appRoot);
  const diskTotalBytes = Number(fsStats.blocks) * Number(fsStats.bsize);
  const diskFreeBytes = Number(fsStats.bavail) * Number(fsStats.bsize);
  const diskUsedBytes = Math.max(diskTotalBytes - diskFreeBytes, 0);
  const diskUsageRatio = diskTotalBytes > 0 ? diskUsedBytes / diskTotalBytes : 0;

  return {
    collectedAt: new Date().toISOString(),
    osLabel: `${os.type()} ${os.release()} (${os.arch()})`,
    nodeVersion: process.version.replace(/^v/, ""),
    nextVersion: packageJson.dependencies.next.replace(/^[^\d]*/, ""),
    reactVersion: packageJson.dependencies.react.replace(/^[^\d]*/, ""),
    cpuCount,
    load1,
    load5,
    load15,
    cpuUsageRatio: clampRatio(load1 / cpuCount),
    totalMemoryBytes,
    freeMemoryBytes,
    usedMemoryBytes,
    memoryUsageRatio: clampRatio(memoryUsageRatio),
    diskTotalBytes,
    diskFreeBytes,
    diskUsedBytes,
    diskUsageRatio: clampRatio(diskUsageRatio),
    uptimeSeconds: Math.max(Math.floor(os.uptime()), 0),
  };
}
