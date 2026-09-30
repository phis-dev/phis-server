/**
 * How this server stores the kind of a Space.
 *
 * The numbers are the stored contract and never change. They are deliberately not in
 * `@phis/contracts`: a Site never sees them, it is handed the wire name instead.
 *
 * Kept free of `server-only` so the CLI's storage passes name a Space the way Media does, rather than
 * by a bare 4 in their SQL.
 */
export const PhisMediaSpaceKind = { Site: 1, User: 2, Group: 3, Addon: 4 } as const;

export type PhisMediaSpaceKindValue = (typeof PhisMediaSpaceKind)[keyof typeof PhisMediaSpaceKind];
