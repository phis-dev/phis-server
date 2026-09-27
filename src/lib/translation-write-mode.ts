import "server-only";

import { getPhisConfigSync } from "@/lib/config";
import type { ApiV1TokenMode } from "@/lib/api-v1-guard";

/**
 * What a request to the global translation store may write, which is two rights and not one.
 *
 * `allowPublicWrites` used to grant both at once: filling in a translation for a message the catalogue
 * already holds, and creating a message nobody here has seen. They carry different risk and belong to
 * different callers (TRANSLATIONS.md, "Somebody else's strings in the global store").
 *
 * - `fill` is what an installation asking a mirror needs: its miss is a message of the platform's own,
 *   and answering it once serves every installation after it. This may stand open.
 * - `extend` is what an application outside the platform needs, and it is the one that lets a stranger
 *   put rows in `tr_msg`. It is granted inside a window that is opened deliberately and closes by
 *   itself.
 * - `none` reads and does not write, which is the public default.
 */
export type PhisTranslationWriteMode = "none" | "fill" | "extend";

/**
 * How long a window may be opened for.
 *
 * Ten minutes is short enough that forgetting it is not an outage, and the ceiling is enforced where the
 * value is written rather than where it is read: clamping a stored timestamp against "now" on every read
 * would keep any window permanently ten minutes from closing.
 */
export const PHIS_TRANSLATION_WRITE_WINDOW_MAX_MS = 10 * 60_000;

/**
 * When the window closes, or `null` for closed.
 *
 * An absent timestamp is closed rather than open. The window has to be opened deliberately, and a
 * configuration that says nothing has not opened anything.
 */
export function resolvePhisTranslationWriteWindowEnd(now = Date.now()) {
  const stated = getPhisConfigSync().translation?.allowPublicWritesUntil?.trim();
  if (!stated) {
    return null;
  }
  const until = Date.parse(stated);
  if (!Number.isFinite(until) || until <= now) {
    return null;
  }
  return until;
}

/**
 * Nothing about the name is trusted here beyond the fact that there was one.
 *
 * The name decides which key space a write lands in, and the server builds that space, so a caller
 * cannot reach the platform's registers by claiming anything. What the name does not do is authorise:
 * whoever holds the public token can claim any of them, so the grant rests on the window and on the
 * token, never on the string.
 */
export function resolvePhisTranslationWriteMode(input: {
  tokenMode: ApiV1TokenMode;
  named: boolean;
  now?: number;
}): PhisTranslationWriteMode {
  if (input.tokenMode === "internal") {
    return "extend";
  }
  if (getPhisConfigSync().translation?.allowPublicWrites !== true) {
    return "none";
  }
  if (input.named && resolvePhisTranslationWriteWindowEnd(input.now ?? Date.now()) != null) {
    return "extend";
  }
  return "fill";
}
