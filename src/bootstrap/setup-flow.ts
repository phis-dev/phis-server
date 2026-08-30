export const bootstrapStepOrder = [
  "runtime",
  "operator",
  "translations",
  "database",
  "schema",
  "site",
  "finish",
] as const;

export type BootstrapStepKey = (typeof bootstrapStepOrder)[number];

export function getBootstrapStep(value: string | undefined): BootstrapStepKey {
  return bootstrapStepOrder.includes(value as BootstrapStepKey)
    ? (value as BootstrapStepKey)
    : "runtime";
}
