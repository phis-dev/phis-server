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
