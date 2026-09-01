import { createHash } from "node:crypto";

import type { PhiServerAddonQueryOrdering, PhiServerAddonQueryRow } from "./contract.ts";

/**
 * The cursor a paged select hands back, and reads again on the next call.
 *
 * It is opaque on purpose. An Add-on that took one apart would fix its shape forever, and the shape is
 * Core's -- today the ordering values, tomorrow perhaps something else. What an Add-on may do with a
 * cursor is pass it back, and that is the whole of the agreement.
 *
 * It carries a signature of the ordering it was made for, and a query with a different one refuses it.
 * Paging on somebody else's order is not an error the database reports: the comparison is valid SQL and
 * the answer is quietly wrong, skipping rows and repeating others. Refusing costs a comparison and
 * turns a silent fault into a loud one.
 */

/** Short on purpose: this is a mismatch check, not a defence against forgery. */
const SIGNATURE_LENGTH = 12;

export class PhiServerAddonCursorError extends Error {}

export function phiServerAddonOrderingSignature(
  queryName: string,
  ordering: PhiServerAddonQueryOrdering[],
) {
  const spec = ordering.map((entry) => `${entry.column}:${entry.direction}`).join(",");
  return createHash("sha256").update(`${queryName}|${spec}`).digest("hex").slice(0, SIGNATURE_LENGTH);
}

/**
 * What a cursor value looks like once it is out of a row.
 *
 * Everything becomes text, and the database reads it back into the column's own type on the next
 * statement. An identity key is a bigint, which JavaScript cannot hold exactly beyond 2^53 -- the
 * driver already hands those over as strings, and keeping them that way is what stops a cursor going
 * wrong at a row number nobody will reach in testing.
 */
function encodeValue(value: unknown, column: string): string {
  if (value === null || value === undefined) {
    throw new PhiServerAddonCursorError(
      `Ordering column "${column}" is null in a row being paged. Ordering columns must be NOT NULL.`,
    );
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

export function encodePhiServerAddonCursor(
  queryName: string,
  ordering: PhiServerAddonQueryOrdering[],
  row: PhiServerAddonQueryRow,
) {
  const payload = {
    s: phiServerAddonOrderingSignature(queryName, ordering),
    k: ordering.map((entry) => encodeValue(row[entry.column], entry.column)),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodePhiServerAddonCursor(
  queryName: string,
  ordering: PhiServerAddonQueryOrdering[],
  cursor: string,
): string[] {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new PhiServerAddonCursorError("The cursor is not readable.");
  }
  if (
    typeof payload !== "object" || payload === null ||
    !Array.isArray((payload as { k?: unknown }).k) ||
    typeof (payload as { s?: unknown }).s !== "string"
  ) {
    throw new PhiServerAddonCursorError("The cursor is not readable.");
  }
  const { s, k } = payload as { s: string; k: unknown[] };
  if (s !== phiServerAddonOrderingSignature(queryName, ordering)) {
    throw new PhiServerAddonCursorError(
      `The cursor was made for a different ordering than query "${queryName}" runs under.`,
    );
  }
  if (k.length !== ordering.length || k.some((value) => typeof value !== "string")) {
    throw new PhiServerAddonCursorError("The cursor does not carry this query's ordering values.");
  }
  return k as string[];
}
