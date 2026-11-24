import { randomBytes } from "node:crypto";

import type { PhisEntitlementSubject } from "@phis/contracts/entitlements";

/**
 * A new subject reference: `sub_` and 24 characters of base 36, about 124 bits, which nobody guesses and
 * nobody needs to read. On its own so the subject writers -- the entitlements and the user events
 * (`user-events.mts`), which issue one where a person had none -- share it without importing each other.
 */
export function newEntitlementSubjectReference(): PhisEntitlementSubject {
  let text = "";
  for (const byte of randomBytes(24)) {
    text += (byte % 36).toString(36);
  }
  return `sub_${text}`;
}
