import {
  mergePhiAreaConfigForPublish,
  type PhiAreaPublishOwnership,
} from "@/lib/cms/area-config";
import type { CmsAreaPresetWriteInput } from "@/lib/cms/write-validation";

export type { PhiAreaPublishOwnership };

/**
 * Merges a draft onto what is currently published.
 *
 * The rule: a publish carries only what its own draft owns, and reads the rest from the published
 * revision rather than from the copy its draft started with. Without it, two drafts left open would
 * overtake each other -- publishing a structure change after a Module publish would restore the Module
 * selection the draft was cloned from, silently, and the operator who made that change would find it
 * undone by an edit that had nothing to do with it.
 *
 * What each draft owns is the tree on one side and one config namespace on the other: the structure
 * draft owns `regions`, `overlays`, `layoutNodes`, `contentWidgets` and `config.shell`; the Module
 * draft owns `config.modules` and nothing else. `mergePhiAreaConfigForPublish` holds the config half of
 * that rule, including what to do when the published revision states nothing about a namespace at all.
 */
export function mergePhiAreaTreeForPublish(
  publishedTree: CmsAreaPresetWriteInput | null,
  draftTree: CmsAreaPresetWriteInput,
  owns: PhiAreaPublishOwnership,
): CmsAreaPresetWriteInput {
  if (!publishedTree) {
    return draftTree;
  }

  // The tree itself comes from whoever owns it; only the config is merged across the two.
  const base = owns === "modules" ? publishedTree : draftTree;

  return {
    ...base,
    preset: {
      ...(base.preset ?? {}),
      config: mergePhiAreaConfigForPublish(
        publishedTree.preset?.config,
        draftTree.preset?.config,
        owns,
      ),
    },
  };
}
