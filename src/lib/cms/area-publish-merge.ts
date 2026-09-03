import type { CmsAreaPresetWriteInput } from "@/lib/cms/write-validation";

/**
 * Which half of an Area a draft owns.
 *
 * An Area is edited from two places that never touch the same fields: its structure on the Shells page,
 * its Module selection on the Modules page. Both keep their own Working Draft in the same revision
 * family, so a publish has to say which half it speaks for.
 */
export type PhiAreaPublishOwnership = "structure" | "modules";

/**
 * Merges a draft onto what is currently published.
 *
 * The rule: a publish carries only the fields its own draft owns, and reads the rest from the published
 * revision rather than from the copy its draft started with. Without it, two drafts left open would
 * overtake each other -- publishing a structure change after a Module publish would restore the Module
 * selection the draft was cloned from, silently, and the operator who made that change would find it
 * undone by an edit that had nothing to do with it.
 *
 * A structure publish keeps its own config when the published revision carries none at all. That is not
 * the same case: an absent config is a revision that never stated a selection, and reading it as an
 * empty selection would deactivate every Module of an Area on the next unrelated publish.
 */
export function mergePhiAreaTreeForPublish(
  publishedTree: CmsAreaPresetWriteInput | null,
  draftTree: CmsAreaPresetWriteInput,
  owns: PhiAreaPublishOwnership,
): CmsAreaPresetWriteInput {
  if (!publishedTree) {
    return draftTree;
  }

  if (owns === "modules") {
    return {
      ...publishedTree,
      preset: { ...(publishedTree.preset ?? {}), config: draftTree.preset?.config ?? {} },
    };
  }

  const publishedConfig = publishedTree.preset?.config;
  if (publishedConfig === undefined) {
    return draftTree;
  }

  return {
    ...draftTree,
    preset: { ...(draftTree.preset ?? {}), config: publishedConfig },
  };
}
