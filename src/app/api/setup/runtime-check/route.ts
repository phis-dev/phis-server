import { execFileSync } from "node:child_process";
import { accessSync, constants, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextResponse } from "next/server";

import {
  type RuntimeCheckKey,
  runtimeCheckOrder,
} from "@/bootstrap/runtime-checks";
import { getPhiAppRoot, resolvePhiAppPath } from "@/lib/app-paths";
import {
  isBootstrapEnabled,
} from "@/lib/config";
import {
  getPhiRuntimeConfigPath,
  getPhiStaticConfigPath,
  readMergedPhiConfigSync,
} from "@/lib/config-files";

function formatBytes(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function ensureWritable(configPath: string) {
  accessSync(configPath, constants.R_OK);
  accessSync(path.dirname(configPath), constants.W_OK);
  const probePath = `${configPath}.probe-${process.pid}`;
  writeFileSync(probePath, "phis-write-check\n", "utf-8");
  unlinkSync(probePath);
}

function ensureReadable(configPath: string) {
  accessSync(configPath, constants.R_OK);
}

function verifyPhisCli() {
  const appRoot = getPhiAppRoot();
  const cliPath = resolvePhiAppPath("phis");

  accessSync(cliPath, constants.R_OK | constants.X_OK);
  const output = execFileSync(cliPath, ["config", "validate"], {
    cwd: appRoot,
    encoding: "utf-8",
  }).trim();

  return output || cliPath;
}

function classifyMemory(totalBytes: number) {
  const totalGb = totalBytes / 1024 / 1024 / 1024;

  if (totalGb < 2) {
    return "failed" as const;
  }
  if (totalGb < 4) {
    return "warning" as const;
  }
  return "verified" as const;
}

function classifyDisk(freeBytes: number) {
  const freeGb = freeBytes / 1024 / 1024 / 1024;

  if (freeGb < 3) {
    return "failed" as const;
  }
  if (freeGb < 10) {
    return "warning" as const;
  }
  return "verified" as const;
}

/**
 * Node 24.21.0 or later, the floor `engines` declares. Earlier releases leak under React Flight
 * rendering -- an Immediate held through `async_context` -- and a server under load runs out of memory.
 */
const PHIS_MINIMUM_NODE_VERSION = [24, 21, 0] as const;

function isSupportedNodeVersion(version: string) {
  const parts = version.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (const [index, minimum] of PHIS_MINIMUM_NODE_VERSION.entries()) {
    const actual = parts[index] ?? 0;
    if (actual !== minimum) return actual > minimum;
  }
  return true;
}

function runRuntimeCheck(checkId: RuntimeCheckKey) {
  const mergedConfig = readMergedPhiConfigSync();
  const appRoot = getPhiAppRoot();
  const staticConfigPath = getPhiStaticConfigPath();
  const runtimeConfigPath = getPhiRuntimeConfigPath();

  switch (checkId) {
    case "hostname":
      return {
        status: "verified" as const,
        detail: os.hostname(),
      };
    case "platform":
      return {
        status: "verified" as const,
        detail: `${os.platform()} / ${os.arch()}`,
      };
    case "node":
      return {
        status: isSupportedNodeVersion(process.versions.node)
          ? ("verified" as const)
          : ("failed" as const),
        detail: `Node ${process.version}`,
      };
    case "memory":
      return {
        status: classifyMemory(os.totalmem()),
        detail: `${formatBytes(os.freemem())} free of ${formatBytes(os.totalmem())}`,
      };
    case "disk": {
      const stats = statfsSync(appRoot);
      const freeBytes = stats.bavail * stats.bsize;
      return {
        status: classifyDisk(freeBytes),
        detail: `${formatBytes(freeBytes)} free in ${appRoot}`,
      };
    }
    case "configStatic":
      ensureReadable(staticConfigPath);
      return {
        status: "verified" as const,
        detail: staticConfigPath,
      };
    case "configRuntime":
      ensureWritable(runtimeConfigPath);
      return {
        status: "verified" as const,
        detail: runtimeConfigPath,
      };
    case "cli":
      return {
        status: "verified" as const,
        detail: verifyPhisCli(),
      };
    case "containerized":
      return {
        status: "verified" as const,
        detail: mergedConfig.runtime?.containerized ? "true" : "false",
      };
    default:
      return {
        status: "failed" as const,
        detail: "Unknown runtime check.",
      };
  }
}

export async function POST(request: Request) {
  if (!isBootstrapEnabled()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  let checkId: unknown;

  try {
    const payload = (await request.json()) as { checkId?: unknown };
    checkId = payload.checkId;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (
    typeof checkId !== "string" ||
    !(runtimeCheckOrder as readonly string[]).includes(checkId)
  ) {
    return NextResponse.json({ error: "Invalid runtime check id." }, { status: 400 });
  }

  try {
    const result = runRuntimeCheck(checkId as RuntimeCheckKey);
    return NextResponse.json({
      checkId,
      ...result,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown runtime check failure.";
    return NextResponse.json(
      {
        checkId,
        status: "failed",
        detail: message,
      },
      { status: 200 },
    );
  }
}
