import "server-only";

/**
 * The namespace an application outside this platform writes its strings under.
 *
 * `tr_msg` is unique on `(msg_hash, ctx)` and the hash covers only the opening of a message, so two
 * writers sharing a context share one key space: a foreign string can occupy the hash a Label Set will
 * want later, and then ours is the one rejected while nobody looks there. An application therefore names
 * itself in `PHIS_APP_HEADER` and the server puts that name in front of the context it was sent
 * (TRANSLATIONS.md, "Somebody else's strings in the global store").
 *
 * The construction belongs to the server rather than the caller, which is the whole difference between a
 * rule and an agreement: whatever arrives, what is stored begins with the caller's own name.
 *
 * It is a namespace and not an identity. Anybody holding the public token can claim any name, so this
 * protects the platform's space from every caller rather than one application from another.
 */

/**
 * What a name may be made of, and what it must not reach.
 *
 * No brackets, because a leading `[...]` is the storage flag envelope and an application calling itself
 * `[html]` would forge one. No colon, because the colon is the separator this builds with and a name
 * carrying one would make the boundary unreadable. Lower case and single spaces, because `Acme`, `acme `
 * and `acme` must be one key space rather than three an application searches in vain.
 */
const APP_NAME_PATTERN = /^[a-z0-9][a-z0-9 ._-]*$/;

/** Long enough for a product name, short enough to leave the caller its own context. */
export const PHIS_TRANSLATION_APP_NAME_MAX_LENGTH = 32;

/**
 * What the constructed context may measure, which is less than the column holds.
 *
 * `ctx` is `varchar(128)` and the storage flag envelope is prepended after this -- `[html:extern]` is
 * thirteen characters -- so the natural-language part has to leave room for it. Overlong is refused and
 * never truncated: a cut context silently merges two key spaces into one, which is the collision this
 * whole mechanism exists to prevent.
 */
export const PHIS_TRANSLATION_APP_CONTEXT_MAX_LENGTH = 115;

export type PhisTranslationAppNameResult =
  | { kind: "absent" }
  | { kind: "named"; app: string }
  | { kind: "invalid"; reason: string };

export function readPhisTranslationAppName(
  raw: string | null | undefined,
): PhisTranslationAppNameResult {
  const collapsed = (raw ?? "").trim().replace(/\s+/gu, " ").toLowerCase();
  if (!collapsed) {
    return { kind: "absent" };
  }
  if (collapsed.length > PHIS_TRANSLATION_APP_NAME_MAX_LENGTH) {
    return {
      kind: "invalid",
      reason: `An application name may hold at most ${PHIS_TRANSLATION_APP_NAME_MAX_LENGTH} characters.`,
    };
  }
  if (!APP_NAME_PATTERN.test(collapsed)) {
    return {
      kind: "invalid",
      reason: "An application name may hold letters, digits, spaces, dots, dashes and underscores only.",
    };
  }
  return { kind: "named", app: collapsed };
}

export type PhisTranslationAppContextResult =
  | { kind: "context"; context: string }
  | { kind: "invalid"; reason: string };

/**
 * The stored context: the application's name, and what it said about the text.
 *
 * An empty context is the name on its own rather than a dangling separator -- both are inside the
 * application's space, which is what the separator is there to establish.
 */
export function buildPhisTranslationAppContext(
  app: string,
  ctx: string,
): PhisTranslationAppContextResult {
  const stated = ctx.trim();
  const context = stated ? `${app}: ${stated}` : app;
  if (context.length > PHIS_TRANSLATION_APP_CONTEXT_MAX_LENGTH) {
    return {
      kind: "invalid",
      reason:
        `An application's name and context may hold at most ${PHIS_TRANSLATION_APP_CONTEXT_MAX_LENGTH} `
        + "characters together.",
    };
  }
  return { kind: "context", context };
}
