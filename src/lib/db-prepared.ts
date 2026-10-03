import { createHash } from "node:crypto";

import type { QueryConfig } from "pg";

const namesByText = new Map<string, string>();

/**
 * A statement PostgreSQL plans once per connection instead of on every call.
 *
 * Sent as plain text, a statement is parsed and planned each time it runs, and for the reads every
 * request makes that is most of what the database does: the request-actor read took 4 ms to plan and
 * 0.6 ms to execute, and prepared it runs in about a tenth of the time (measured 03.10.2026). node-pg
 * prepares a named statement on first use per pooled connection and reuses it after.
 *
 * The name is the hash of the text, so a statement whose text has a few fixed forms -- with or without
 * `FOR UPDATE`, by path or by Module identity -- is one prepared statement per form, and two call sites
 * with the same text share one. That also says where this must not be used: a text that carries values
 * spliced into it would prepare a new statement for every value, on every connection, for as long as the
 * connection lives. Values travel as parameters, always.
 *
 * A pooler in transaction mode (PgBouncer) does not keep a prepared statement on the connection the
 * next request gets; phis connects to PostgreSQL directly.
 */
export function phiPrepared(text: string, values: unknown[]): QueryConfig {
  let name = namesByText.get(text);
  if (!name) {
    name = `phi_${createHash("sha1").update(text).digest("hex").slice(0, 24)}`;
    namesByText.set(text, name);
  }
  return { name, text, values };
}
