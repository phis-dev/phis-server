import "server-only";

import { accessSync, constants, readFileSync } from "node:fs";
import os from "node:os";

import { getPhiAppRoot } from "@/lib/app-paths";
import {
  getPhiRuntimeConfigPath,
  getPhiStaticConfigPath,
} from "@/lib/config-files";

export type OperatorInfrastructureSnapshot = {
  appRoot: string;
  workingDirectory: string;
  nodeEnv: string;
  processId: number;
  userName: string;
  staticConfigPath: string;
  staticConfigReadable: boolean;
  staticConfigContent: string;
  runtimeConfigPath: string;
  runtimeConfigReadable: boolean;
  runtimeConfigWritable: boolean;
  runtimeConfigContent: string;
};

function canAccess(path: string, mode: number) {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

function resolveUserName() {
  try {
    return os.userInfo().username;
  } catch {
    return "unknown";
  }
}

function readConfigContent(path: string, errorLabel: string) {
  try {
    return readFileSync(path, "utf-8").trim() || "{}";
  } catch (error) {
    const message =
      error instanceof Error ? error.message : `${errorLabel} could not be read.`;
    return `/* ${message} */`;
  }
}

export function readOperatorInfrastructureSnapshot(): OperatorInfrastructureSnapshot {
  const appRoot = getPhiAppRoot();
  const staticConfigPath = getPhiStaticConfigPath();
  const runtimeConfigPath = getPhiRuntimeConfigPath();

  return {
    appRoot,
    workingDirectory: appRoot,
    nodeEnv: process.env.NODE_ENV?.trim() || "development",
    processId: process.pid,
    userName: resolveUserName(),
    staticConfigPath,
    staticConfigReadable: canAccess(staticConfigPath, constants.R_OK),
    staticConfigContent: readConfigContent(staticConfigPath, "Static config"),
    runtimeConfigPath,
    runtimeConfigReadable: canAccess(runtimeConfigPath, constants.R_OK),
    runtimeConfigWritable: canAccess(runtimeConfigPath, constants.W_OK),
    runtimeConfigContent: readConfigContent(runtimeConfigPath, "Runtime config"),
  };
}
