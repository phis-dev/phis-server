export const runtimeCheckOrder = [
  "hostname",
  "platform",
  "node",
  "memory",
  "disk",
  "configStatic",
  "configRuntime",
  "cli",
  "containerized",
] as const;

export type RuntimeCheckKey = (typeof runtimeCheckOrder)[number];
