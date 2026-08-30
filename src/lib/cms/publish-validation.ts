import "server-only";

import type {
  CmsAreaPresetWriteInput,
  CmsDraftContentWidgetInput,
  CmsDraftLayoutNodeInput,
  CmsDraftOverlayInput,
  CmsPageWriteInput,
} from "@/lib/cms/write-validation";
import { isPhiCmsInstanceId, type PhiCmsInstanceId } from "@/lib/cms/instance-id";
import { collectCmsSignalRouteErrors } from "@/lib/cms/signal-validation";

function assertRevisionNodes(
  overlays: readonly CmsDraftOverlayInput[],
  layoutNodes: readonly CmsDraftLayoutNodeInput[],
  contentWidgets: readonly CmsDraftContentWidgetInput[],
) {
  const activeIds = new Set<PhiCmsInstanceId>();
  for (const node of [...overlays, ...layoutNodes, ...contentWidgets]) {
    if (!isPhiCmsInstanceId(node.id)) {
      throw new Error(`CMS node id "${String(node.id)}" is not canonical.`);
    }
    if (activeIds.has(node.id)) {
      throw new Error(`CMS node id "${node.id}" is not unique in the revision.`);
    }
    activeIds.add(node.id);
  }
  for (const node of [...overlays, ...layoutNodes, ...contentWidgets]) {
    const errors = collectCmsSignalRouteErrors(
      node.config?.signalRoutes,
      activeIds,
      `CMS node ${node.id}.signalRoutes`,
    );
    if (errors.length > 0) {
      throw new Error(errors.join(" "));
    }
  }
}

export function validateCmsPageRevisionForPublish(input: CmsPageWriteInput) {
  assertRevisionNodes(input.overlays, input.layoutNodes, input.contentWidgets);
  return input;
}

export function validateCmsAreaRevisionForPublish(input: CmsAreaPresetWriteInput) {
  assertRevisionNodes(input.overlays, input.layoutNodes, input.contentWidgets);
  return input;
}
