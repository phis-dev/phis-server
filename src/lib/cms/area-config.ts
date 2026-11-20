/**
 * The two halves of an Area preset config, expressed as a path rather than as a list of field names.
 *
 * An Area is edited from two workspaces that own different things: its structure on `/builder/shells`,
 * its Module selection on `/builder/modules`. The config used to belong to the Module selection whole,
 * which held only because nothing else had ever been stored in it -- a Shell Background lives in a
 * Region's own config, inside the structure tree. The first genuinely Shell-owned setting, whether the
 * root route of the Area is a landing page or a redirect, ends that.
 *
 * Splitting by namespace rather than by a list of owned keys buys two things. The rule is readable off
 * the path a value is written to, instead of having to be looked up somewhere. And it becomes checkable:
 * a write can be rejected for carrying a namespace it does not own, where before ownership was only a
 * convention the client happened to keep.
 *
 * The two halves are also stored apart. A structure revision carries `config.shell`; a Modules revision
 * (flagged `PhiCmsAreaRevisionFlags.Modules`) carries `config.modules` and nothing else, under its own
 * published pointer -- the shell an Area takes depends on the Modules it runs, so the selection must be
 * readable before the identity a structure is stored under is known (DB.md, `site_area_scopes`).
 */

/**
 * The Shell's own statements about itself, by key.
 *
 * `rootRoute` says what an Area's `/` resolves to: a landing page, or a forward to a Page named by an
 * internal reference. The site UI reads the same key; the server only checks that what is stored can
 * be read back at all.
 */
export const PHI_AREA_ROOT_ROUTE_KEY = "rootRoute" as const;

/**
 * What an Area says about itself in the head of every Page it draws, by key.
 *
 * `meta` holds four answers in two groups. Whether search engines may index the Area and whether its
 * published Pages are listed in the sitemap are only ever asked of Public -- every other Area is
 * authenticated, so its answer is fixed and needs no storage. The title template and the default title
 * are asked of every Area, because a tab title is not a search result. An absent key is not a default
 * to be guessed here but a Site that has not been asked, exactly as with the root route.
 */
export const PHI_AREA_META_KEY = "meta" as const;

/**
 * What a Site decided about a Public address, by key.
 *
 * `publicRoutePaths` holds the answers given when a Module was enabled and the address it declared was
 * already taken. Public is the only Area where that question arises -- everywhere else a Module's
 * routes live under its package -- and the server checks only that an entry can be read back as one:
 * whether the route still exists, and whether the address is free today, are the site UI's questions,
 * asked again every time the table is compiled.
 */
export const PHI_AREA_PUBLIC_ROUTE_PATHS_KEY = "publicRoutePaths" as const;

export const PHI_AREA_CONFIG_SHELL_NAMESPACE = "shell" as const;
export const PHI_AREA_CONFIG_MODULES_NAMESPACE = "modules" as const;

export const PHI_AREA_CONFIG_NAMESPACES = [
  PHI_AREA_CONFIG_SHELL_NAMESPACE,
  PHI_AREA_CONFIG_MODULES_NAMESPACE,
] as const;

export type PhiAreaConfigNamespace = (typeof PHI_AREA_CONFIG_NAMESPACES)[number];

export function isPhiAreaConfigNamespace(value: string): value is PhiAreaConfigNamespace {
  return (PHI_AREA_CONFIG_NAMESPACES as readonly string[]).includes(value);
}

/** One namespace of a config, or `undefined` when the config states nothing about it. */
export function readPhiAreaConfigNamespace(
  config: Record<string, unknown> | undefined,
  namespace: PhiAreaConfigNamespace,
): Record<string, unknown> | undefined {
  const value = config?.[namespace];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
