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
 * What an Area says about being found, by key.
 *
 * `seo` holds two answers, and only Public is ever asked them: whether search engines may index the
 * Area at all, and whether its published Pages are listed in the sitemap. Every other Area is
 * authenticated, so its answer is fixed and needs no storage -- which is why an absent key is not a
 * default to be guessed here but a Site that has not been asked, exactly as with the root route.
 */
export const PHI_AREA_SEO_KEY = "seo" as const;

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

/** Which half of an Area a draft owns. A publish has to say which, because both write the same family. */
export type PhiAreaPublishOwnership = "structure" | "modules";

export const PHI_AREA_CONFIG_NAMESPACE_BY_OWNERSHIP = {
  structure: PHI_AREA_CONFIG_SHELL_NAMESPACE,
  modules: PHI_AREA_CONFIG_MODULES_NAMESPACE,
} as const satisfies Record<PhiAreaPublishOwnership, PhiAreaConfigNamespace>;

export function isPhiAreaConfigNamespace(value: string): value is PhiAreaConfigNamespace {
  return (PHI_AREA_CONFIG_NAMESPACES as readonly string[]).includes(value);
}

/**
 * One namespace of a stored config, or `undefined` when the revision never stated anything about it.
 *
 * The distinction matters at publish time: an absent namespace is a revision that made no statement,
 * and reading it as an empty one would deactivate every Module of an Area on the next unrelated publish.
 */
export function readPhiAreaConfigNamespace(
  config: Record<string, unknown> | undefined,
  namespace: PhiAreaConfigNamespace,
): Record<string, unknown> | undefined {
  const value = config?.[namespace];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Merges two configs for a publish: the publishing draft brings its own namespace, every other one is
 * read from what is currently published.
 *
 * The exception is a namespace the published revision does not carry at all. There the draft's copy is
 * kept -- it is what the Area is running on, inherited from the code-owned preset, and dropping it would
 * turn a first publish of one half into a silent reset of the other.
 *
 * A key outside the known namespaces belongs to nobody. It is carried over from the published revision
 * rather than dropped, because losing stored data is the worse failure of the two, but no draft can
 * introduce one.
 */
export function mergePhiAreaConfigForPublish(
  publishedConfig: Record<string, unknown> | undefined,
  draftConfig: Record<string, unknown> | undefined,
  owns: PhiAreaPublishOwnership,
): Record<string, unknown> {
  const owned = PHI_AREA_CONFIG_NAMESPACE_BY_OWNERSHIP[owns];
  const merged: Record<string, unknown> = { ...(publishedConfig ?? {}) };

  for (const namespace of PHI_AREA_CONFIG_NAMESPACES) {
    const value = namespace === owned
      ? draftConfig?.[namespace]
      : publishedConfig?.[namespace] ?? draftConfig?.[namespace];
    if (value === undefined) {
      delete merged[namespace];
    } else {
      merged[namespace] = value;
    }
  }

  return merged;
}
