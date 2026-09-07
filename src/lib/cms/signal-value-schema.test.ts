import { describe, expect, it } from "vitest";

import { collectCmsSignalRouteErrors } from "./signal-validation";

/**
 * The weaker of the two questions asked about a value schema name.
 *
 * phi-server checks that a JSON signal names *a* schema, never which one: it holds no Module registry
 * and must not: refusing a schema because it had never heard of the package would refuse every third
 * party's. `@phis/ui` holds the registry and asks the stricter question about the same string.
 *
 * The grammar itself is no longer a copy -- `isPhiSignalValueSchemaShape` lives in
 * `@phis/contracts/signals` -- but the two answers still have to agree on every input, which is what
 * these cases pin. They are the ones `@phis/ui`'s validator asserts too, so a widening that reaches
 * only one answer fails on the other.
 */
const ACCEPTED = [
  "@phis/ui/modules/core/signals/message",
  "@phis/ui/modules/builder/signals/chrome",
  "@phis/ui/modules/asset/signals/selection",
  // Third-party, with and without a module layer. The grammar does not privilege first-party names.
  "@acme/status/modules/status/signals/service-selection",
  "@acme/status/signals/service-selection",
  "unscoped/signals/leaf",
];

const REJECTED = [
  // The pre-namespace form. Accepting it again would let two grammars name one thing.
  "@phis/ui/background-config",
  "@acme/status/service-selection",
  // Namespace present but the leaf is missing, empty, or split.
  "@phis/ui/modules/core/signals",
  "@phis/ui/modules/core/signals/",
  "@phis/ui/modules/core/signals/a/b",
  // No package in front of the namespace.
  "signals/message",
  // Not a string.
  42,
  null,
];

function errorsFor(valueSchema: unknown) {
  return collectCmsSignalRouteErrors(
    {
      emits: [
        {
          routeKey: "probe",
          capabilityId: "probe",
          channel: "content",
          scope: "widget",
          action: "change",
          valueType: "json",
          valueSchema,
          receiver: null,
        },
      ],
    },
    new Set(),
    "signals",
  );
}

describe("signal value schema grammar", () => {
  it.each(ACCEPTED)("accepts %s", (valueSchema) => {
    expect(errorsFor(valueSchema)).toEqual([]);
  });

  it.each(REJECTED.map((value) => [String(value), value] as const))(
    "rejects %s",
    (_label, valueSchema) => {
      expect(errorsFor(valueSchema)).toContain(
        "signals.emits[0].valueSchema is required for JSON values.",
      );
    },
  );
});
