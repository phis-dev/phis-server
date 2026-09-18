import "server-only";

import { NextResponse } from "next/server";

import { normalizeString } from "@/lib/helpers/request";

/**
 * What the queue and ticket-type administration routes read out of a body, and how they refuse.
 *
 * Shared rather than repeated because the four routes have to agree: a key that one of them accepts and
 * another does not is a Site that can create a row it cannot then edit.
 */

/**
 * A key, spelled as the schema spells one.
 *
 * The same shape a Module's declared seed uses, and for the same reason: `UNIQUE (site_id, key)` is what
 * finds a row again. Keys are never edited afterwards -- renaming one would not rename the row, it would
 * make the next publish create a second one beside it -- so this is the only place one is accepted.
 */
export function readSupportAdministrationKey(value: unknown) {
  const key = normalizeString(value).toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(key) ? key : null;
}

/** What the Site calls the thing, which unlike its key is the Site's to change whenever it likes. */
export function readSupportAdministrationName(value: unknown) {
  const name = normalizeString(value);
  return name.length > 0 && name.length <= 128 ? name : null;
}

export function readSupportInteger(value: unknown) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  const parsed = Number.parseInt(normalizeString(value), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

/** `true`, `false`, or absent -- which for a retirement means "leave it as it is". */
export function readSupportFlag(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

/**
 * Turns a refusal this module raised into a 409, and lets everything else through to the handler.
 *
 * 409 rather than 400: a duplicate key, a group that is not there, the last entry queue -- none of them
 * is a malformed request. They are requests the Site's current state will not accept, and telling the
 * two apart is what lets an interface say "this will not work" rather than "you typed it wrong".
 */
export function refuseSupportAdministration(
  cause: unknown,
  errorType: new (...args: never[]) => Error,
) {
  if (cause instanceof errorType) {
    return NextResponse.json({ error: cause.message }, { status: 409 });
  }
  throw cause;
}
