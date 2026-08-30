import { describe, expect, it } from "vitest";

import { collectCmsSignalRouteErrors } from "./signal-validation";

/**
 * phi-server keeps its own copy of the signal grammar because it does not depend on `@phis/ui`. The
 * copies are the failure mode: widening one alone turns a stored wiring into a rejected write, which
 * is how a renamed controller namespace once produced a 500 on `/admin`. These cases are the ones the
 * `@phis/ui` side asserts too, so a future widening that reaches only one side fails here.
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
