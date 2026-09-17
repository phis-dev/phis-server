import "server-only";

import { isPhisCmsAreaKey, resolvePhisCmsAreaMask } from "@/lib/constants/cms-areas";
import {
  PHI_AREA_CONFIG_MODULES_NAMESPACE,
  PHI_AREA_CONFIG_SHELL_NAMESPACE,
  PHI_AREA_PUBLIC_ROUTE_PATHS_KEY,
  PHI_AREA_ROOT_ROUTE_KEY,
  PHI_AREA_META_KEY,
  isPhiAreaConfigNamespace,
  readPhiAreaConfigNamespace,
} from "@/lib/cms/area-config";
import { normalizeSiteCmsPath } from "@/lib/helpers/cms-path";
import {
  readPhiCmsInstanceId,
  readPhiCmsInstanceIdDescriptor,
  type PhiCmsInstanceDomain,
  type PhiCmsInstanceId,
} from "@/lib/cms/instance-id";
import { collectCmsSignalRouteErrors } from "@/lib/cms/signal-validation";
import { readPhiPageReference } from "@/lib/internal-references";
import { readPhiViewerAccessPolicy, type PhiViewerAccessPolicy } from "@/lib/authorization";

type JsonRecord = Record<string, unknown>;

export type CmsDraftWriteState = {
  revisionId: number;
  version: number;
  nextNodeSequence: number;
};

export type CmsPresetSourceInput = {
  ownerModuleId: string;
  presetKey: string;
  sourcePresetVersion: number;
};

export type CmsDraftContentBindingInput = {
  storage: "text" | "html" | "markdown" | "asset";
  sourceField: string;
  translatable?: boolean;
};

export type CmsDraftRegionInput = {
  id?: number;
  regionType: number;
  rootLayoutNodeId: PhiCmsInstanceId;
  status?: number;
  flags?: number;
  visibilityMask?: number;
  sortOrder?: number;
  config?: JsonRecord;
};

export type CmsDraftOverlayInput = {
  id: PhiCmsInstanceId;
  overlayType: "modal" | "drawer";
  headerLayoutNodeId: PhiCmsInstanceId | null;
  bodyLayoutNodeId: PhiCmsInstanceId;
  footerLayoutNodeId: PhiCmsInstanceId | null;
  status?: number;
  flags?: number;
  visibilityMask?: number;
  sortOrder?: number;
  label?: string | null;
  config?: JsonRecord;
};

export type CmsDraftLayoutNodeInput = {
  id: PhiCmsInstanceId;
  parentLayoutNodeId: PhiCmsInstanceId | null;
  widgetType: string;
  slotIndex: number;
  sortOrder?: number;
  status?: number;
  flags?: number;
  visibilityMask?: number;
  label?: string | null;
  config?: JsonRecord;
};

export type CmsDraftContentWidgetInput = {
  id: PhiCmsInstanceId;
  parentLayoutNodeId: PhiCmsInstanceId;
  widgetType: string;
  slotIndex: number;
  sortOrder?: number;
  status?: number;
  flags?: number;
  visibilityMask?: number;
  label?: string | null;
  config?: JsonRecord;
  contentId?: number | null;
  contentBinding?: CmsDraftContentBindingInput | null;
};

export type CmsAreaPresetWriteInput = {
  area: string;
  areaMask: number;
  sourcePreset: CmsPresetSourceInput;
  draft?: CmsDraftWriteState;
  preset?: {
    id?: number;
    status?: number;
    flags?: number;
    visibilityMask?: number;
    config?: JsonRecord;
  };
  regions: CmsDraftRegionInput[];
  overlays: CmsDraftOverlayInput[];
  layoutNodes: CmsDraftLayoutNodeInput[];
  contentWidgets: CmsDraftContentWidgetInput[];
};

/**
 * What a Module selection write carries, which is deliberately not an Area.
 *
 * The selection lives under `config.modules` and is published from the same revision family, but it is
 * edited on its own page and saved on its own. So the payload names the config and nothing else: a
 * caller that could also send `regions` would be able to move the structure through a route nobody
 * reviews as a structure write. `config.shell` is refused here for the mirror-image reason -- it
 * belongs to the structure draft, and a write that carries it believes it owns something it does not.
 *
 * `baseline` is the exception, and only for a Site that has never persisted this Area. There is then no
 * revision to patch, and the Area runs on the code-owned Shell preset -- which lives in `@phis/ui` and
 * is not something this process can render. The client sends the preset it is already showing, it is
 * validated exactly like an ordinary Area write, and it is used only when no revision exists.
 */
export type CmsAreaModulesWriteInput = {
  area: string;
  areaMask: number;
  sourcePreset: CmsPresetSourceInput;
  draft?: CmsDraftWriteState;
  config: JsonRecord;
  baseline?: CmsAreaPresetWriteInput;
};

export type CmsPageWriteInput = {
  area: string;
  areaMask: number;
  path: string;
  sourcePreset: CmsPresetSourceInput | null;
  draft?: CmsDraftWriteState;
  pageMeta?: {
    title?: string | null;
    description?: string | null;
  };
  page?: {
    id?: number;
    pageType?: number;
    status?: number;
    flags?: number;
    visibilityMask?: number;
    accessPolicy?: PhiViewerAccessPolicy;
    titleMsgId?: number | null;
    descriptionMsgId?: number | null;
    heroRootLayoutNodeId?: PhiCmsInstanceId | null;
    headerBottomRootLayoutNodeId?: PhiCmsInstanceId | null;
    siderRightRootLayoutNodeId?: PhiCmsInstanceId | null;
    footerTopRootLayoutNodeId?: PhiCmsInstanceId | null;
    drawerRightRootLayoutNodeId?: PhiCmsInstanceId | null;
    contentRootLayoutNodeId?: PhiCmsInstanceId | null;
    layoutConfig?: JsonRecord;
  };
  overlays: CmsDraftOverlayInput[];
  layoutNodes: CmsDraftLayoutNodeInput[];
  contentWidgets: CmsDraftContentWidgetInput[];
};

export type CmsValidationResult<T> = {
  ok: true;
  value: T;
} | {
  ok: false;
  error: string;
  details?: string[];
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readInteger(value: unknown, label: string, errors: string[], options?: {
  min?: number;
  allowZero?: boolean;
}) {
  if (!Number.isInteger(value)) {
    errors.push(`${label} must be an integer.`);
    return undefined;
  }

  const min = options?.min ?? Number.MIN_SAFE_INTEGER;
  if ((value as number) < min) {
    errors.push(`${label} must be >= ${min}.`);
    return undefined;
  }

  if (!options?.allowZero && value === 0) {
    errors.push(`${label} must not be 0.`);
    return undefined;
  }

  return value as number;
}

function readOptionalInteger(value: unknown, label: string, errors: string[], options?: {
  min?: number;
  allowZero?: boolean;
}) {
  if (value === undefined) {
    return undefined;
  }

  return readInteger(value, label, errors, options);
}

/**
 * Reads a stored access policy through the vocabulary both processes compile.
 *
 * The shapes and their field grammars belong to `@phis/contracts/access`, so this asks the shared reader
 * instead of restating it. Restating it is what went wrong: this validator knew four of the six shapes,
 * so a Page, Area or node whose visibility was bound to a Site group or to an Add-on role was refused at
 * write while the evaluator on both ends was perfectly able to decide it.
 *
 * Shape only, as everywhere else on this path. Whether the named provider is installed, enabled for this
 * Site and compatible is the reader's question, asked again on every request -- an Add-on switched off
 * long after this write contributes no claims, so its policy matches nobody. That is a Page nobody but a
 * Site Admin sees, not a stored policy that has become invalid, and refusing it here would instead make
 * the Page unsavable for as long as the Add-on is off.
 */
function readViewerAccessPolicy(
  value: unknown,
  label: string,
  errors: string[],
): PhiViewerAccessPolicy | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    errors.push(`${label} must be an access policy object.`);
    return undefined;
  }
  const policy = readPhiViewerAccessPolicy(value);
  if (!policy) {
    errors.push(`${label} is invalid.`);
    return undefined;
  }
  return policy;
}

function readNullableOptionalInteger(value: unknown, label: string, errors: string[], options?: {
  min?: number;
  allowZero?: boolean;
}) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  return readInteger(value, label, errors, options);
}

function readDraftWriteState(value: unknown, errors: string[]) {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    errors.push("draft must be an object.");
    return undefined;
  }

  const revisionId = readInteger(value.revisionId, "draft.revisionId", errors, { min: 1 });
  const version = readInteger(value.version, "draft.version", errors, { min: 1 });
  const nextNodeSequence = readInteger(value.nextNodeSequence, "draft.nextNodeSequence", errors, {
    min: 1,
  });
  if (revisionId === undefined || version === undefined || nextNodeSequence === undefined) {
    return undefined;
  }
  if (revisionId > 0xffffffffffff) {
    errors.push("draft.revisionId exceeds the 48-bit CMS instance-id range.");
  }
  if (nextNodeSequence > 0xffffffff) {
    errors.push("draft.nextNodeSequence exceeds the 32-bit CMS instance-id range.");
  }

  return { revisionId, version, nextNodeSequence } satisfies CmsDraftWriteState;
}

function readRequiredCmsInstanceId(
  value: unknown,
  label: string,
  errors: string[],
  domain: PhiCmsInstanceDomain,
) {
  const instanceId = readPhiCmsInstanceId(value);
  const descriptor = readPhiCmsInstanceIdDescriptor(instanceId);
  if (!instanceId || descriptor?.domain !== domain) {
    errors.push(`${label} must be a canonical ${domain} PhiCmsInstanceId.`);
    return undefined;
  }
  return instanceId;
}

function readNullableOptionalCmsInstanceId(
  value: unknown,
  label: string,
  errors: string[],
  domain: PhiCmsInstanceDomain,
) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return readRequiredCmsInstanceId(value, label, errors, domain);
}

function readOptionalString(value: unknown, label: string, errors: string[], options?: {
  allowEmpty?: boolean;
  nullable?: boolean;
}) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null && options?.nullable) {
    return null;
  }

  if (typeof value !== "string") {
    errors.push(`${label} must be a string.`);
    return undefined;
  }

  if (!options?.allowEmpty && !value.trim()) {
    errors.push(`${label} must not be empty.`);
    return undefined;
  }

  return value;
}

function readRequiredString(value: unknown, label: string, errors: string[]) {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${label} must be a non-empty string.`);
    return undefined;
  }

  return value;
}

function readCmsPresetSource(
  value: unknown,
  label: string,
  errors: string[],
  options?: { nullable?: boolean },
) {
  if (value === null && options?.nullable) {
    return null;
  }
  if (!isRecord(value)) {
    errors.push(`${label} must be an object${options?.nullable ? " or null" : ""}.`);
    return undefined;
  }

  const ownerModuleId = readRequiredString(value.ownerModuleId, `${label}.ownerModuleId`, errors)?.trim();
  const presetKey = readRequiredString(value.presetKey, `${label}.presetKey`, errors)?.trim();
  const sourcePresetVersion = readInteger(
    value.sourcePresetVersion,
    `${label}.sourcePresetVersion`,
    errors,
    { min: 1 },
  );
  if (ownerModuleId && ownerModuleId.lastIndexOf("/") <= 0) {
    errors.push(`${label}.ownerModuleId must contain a package-qualified module key.`);
  }
  if (!ownerModuleId || !presetKey || sourcePresetVersion === undefined) {
    return undefined;
  }

  return { ownerModuleId, presetKey, sourcePresetVersion } satisfies CmsPresetSourceInput;
}

function readOptionalRecord(value: unknown, label: string, errors: string[]) {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    errors.push(`${label} must be an object.`);
    return undefined;
  }

  return value;
}

function validateRenderableConfigAssetSources(
  value: unknown,
  label: string,
  errors: string[],
) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      validateRenderableConfigAssetSources(entry, `${label}[${index}]`, errors);
    });
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  if (
    value.sourceKind === "asset" &&
    Object.prototype.hasOwnProperty.call(value, "sourceUrl")
  ) {
    errors.push(`${label}.sourceUrl is forbidden when sourceKind is "asset".`);
  }
  for (const [key, entry] of Object.entries(value)) {
    validateRenderableConfigAssetSources(entry, `${label}.${key}`, errors);
  }
}

function readRenderableConfig(value: unknown, label: string, errors: string[]) {
  const config = readOptionalRecord(value, label, errors) ?? {};
  validateRenderableConfigAssetSources(config, label, errors);
  if (Object.prototype.hasOwnProperty.call(config, "accessPolicy")) {
    readViewerAccessPolicy(config.accessPolicy, `${label}.accessPolicy`, errors);
  }
  if (Array.isArray(config.buttons)) {
    for (const [index, button] of config.buttons.entries()) {
      if (
        isRecord(button) &&
        Object.prototype.hasOwnProperty.call(button, "accessPolicy")
      ) {
        readViewerAccessPolicy(
          button.accessPolicy,
          `${label}.buttons[${index}].accessPolicy`,
          errors,
        );
      }
    }
  }
  return config;
}

function normalizeCmsStoragePath(value: unknown, errors: string[]) {
  if (typeof value !== "string") {
    errors.push("path must be a string.");
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    errors.push("path must not be empty.");
    return undefined;
  }

  return normalizeSiteCmsPath(trimmed);
}

function normalizeCmsArea(value: unknown, errors: string[]) {
  if (typeof value !== "string" || !value.trim()) {
    errors.push("area must be a non-empty string.");
    return undefined;
  }

  return value.trim().toLowerCase();
}

function resolveCmsAreaMaskFromArea(value: unknown, errors: string[]) {
  const area = normalizeCmsArea(value, errors);
  if (area === undefined) {
    return undefined;
  }

  if (!isPhisCmsAreaKey(area)) {
    errors.push("area must be a valid CMS area.");
    return undefined;
  }

  return resolvePhisCmsAreaMask(area);
}

function parseContentBinding(value: unknown, label: string, errors: string[]) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (!isRecord(value)) {
    errors.push(`${label} must be an object.`);
    return undefined;
  }

  const storage = readRequiredString(value.storage, `${label}.storage`, errors);
  const sourceField = readRequiredString(value.sourceField, `${label}.sourceField`, errors);

  if (storage !== undefined && storage !== "text" && storage !== "html" && storage !== "markdown" && storage !== "asset") {
    errors.push(`${label}.storage must be "text", "html", "markdown", or "asset".`);
  }

  let translatable: boolean | undefined;
  if (value.translatable !== undefined) {
    if (typeof value.translatable !== "boolean") {
      errors.push(`${label}.translatable must be a boolean.`);
    } else {
      translatable = value.translatable;
    }
  }

  if ((storage !== "text" && storage !== "html" && storage !== "markdown" && storage !== "asset") || sourceField === undefined) {
    return undefined;
  }

  return {
    storage,
    sourceField,
    translatable,
  } satisfies CmsDraftContentBindingInput;
}

function parseLayoutNodes(value: unknown, errors: string[], domain: PhiCmsInstanceDomain) {
  if (!Array.isArray(value)) {
    errors.push("layoutNodes must be an array.");
    return [];
  }

  const parsed: CmsDraftLayoutNodeInput[] = [];

  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      errors.push(`layoutNodes[${index}] must be an object.`);
      continue;
    }

    const id = readRequiredCmsInstanceId(entry.id, `layoutNodes[${index}].id`, errors, domain);
    const parentLayoutNodeId =
      entry.parentLayoutNodeId === null
        ? null
        : readRequiredCmsInstanceId(
            entry.parentLayoutNodeId,
            `layoutNodes[${index}].parentLayoutNodeId`,
            errors,
            domain,
          ) ?? null;

    const widgetType = readRequiredString(entry.widgetType, `layoutNodes[${index}].widgetType`, errors);
    const slotIndex = readInteger(entry.slotIndex, `layoutNodes[${index}].slotIndex`, errors, {
      min: 0,
      allowZero: true,
    });

    if (id === undefined || widgetType === undefined || slotIndex === undefined) {
      continue;
    }

    parsed.push({
      id,
      parentLayoutNodeId,
      widgetType,
      slotIndex,
      sortOrder: readOptionalInteger(entry.sortOrder, `layoutNodes[${index}].sortOrder`, errors, {
        min: 0,
        allowZero: true,
      }) ?? 0,
      status: readOptionalInteger(entry.status, `layoutNodes[${index}].status`, errors, {
        min: 0,
        allowZero: true,
      }),
      flags: readOptionalInteger(entry.flags, `layoutNodes[${index}].flags`, errors, {
        min: 0,
        allowZero: true,
      }),
      visibilityMask: readOptionalInteger(
        entry.visibilityMask,
        `layoutNodes[${index}].visibilityMask`,
        errors,
        { min: 0, allowZero: true },
      ),
      label: readOptionalString(entry.label, `layoutNodes[${index}].label`, errors, {
        allowEmpty: false,
        nullable: true,
      }),
      config: readRenderableConfig(entry.config, `layoutNodes[${index}].config`, errors),
    });
  }

  return parsed;
}

function parseContentWidgets(value: unknown, errors: string[], domain: PhiCmsInstanceDomain) {
  if (!Array.isArray(value)) {
    errors.push("contentWidgets must be an array.");
    return [];
  }

  const parsed: CmsDraftContentWidgetInput[] = [];

  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      errors.push(`contentWidgets[${index}] must be an object.`);
      continue;
    }

    const id = readRequiredCmsInstanceId(entry.id, `contentWidgets[${index}].id`, errors, domain);
    const parentLayoutNodeId = readRequiredCmsInstanceId(
      entry.parentLayoutNodeId,
      `contentWidgets[${index}].parentLayoutNodeId`,
      errors,
      domain,
    );
    const widgetType = readRequiredString(entry.widgetType, `contentWidgets[${index}].widgetType`, errors);
    const slotIndex = readInteger(entry.slotIndex, `contentWidgets[${index}].slotIndex`, errors, {
      min: 0,
      allowZero: true,
    });

    if (
      id === undefined ||
      parentLayoutNodeId === undefined ||
      widgetType === undefined ||
      slotIndex === undefined
    ) {
      continue;
    }

    parsed.push({
      id,
      parentLayoutNodeId,
      widgetType,
      slotIndex,
      sortOrder: readOptionalInteger(entry.sortOrder, `contentWidgets[${index}].sortOrder`, errors, {
        min: 0,
        allowZero: true,
      }) ?? 0,
      status: readOptionalInteger(entry.status, `contentWidgets[${index}].status`, errors, {
        min: 0,
        allowZero: true,
      }),
      flags: readOptionalInteger(entry.flags, `contentWidgets[${index}].flags`, errors, {
        min: 0,
        allowZero: true,
      }),
      visibilityMask: readOptionalInteger(
        entry.visibilityMask,
        `contentWidgets[${index}].visibilityMask`,
        errors,
        { min: 0, allowZero: true },
      ),
      label: readOptionalString(entry.label, `contentWidgets[${index}].label`, errors, {
        allowEmpty: false,
        nullable: true,
      }),
      config: readRenderableConfig(entry.config, `contentWidgets[${index}].config`, errors),
      contentId: readNullableOptionalInteger(
        entry.contentId,
        `contentWidgets[${index}].contentId`,
        errors,
        { min: 1 },
      ),
      contentBinding:
        parseContentBinding(
          entry.contentBinding,
          `contentWidgets[${index}].contentBinding`,
          errors,
        ) ?? null,
    });
  }

  return parsed;
}

function parseRegions(value: unknown, errors: string[], domain: PhiCmsInstanceDomain) {
  if (!Array.isArray(value)) {
    errors.push("regions must be an array.");
    return [];
  }

  const parsed: CmsDraftRegionInput[] = [];

  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      errors.push(`regions[${index}] must be an object.`);
      continue;
    }

    const regionType = readInteger(entry.regionType, `regions[${index}].regionType`, errors);
    const rootLayoutNodeId = readRequiredCmsInstanceId(
      entry.rootLayoutNodeId,
      `regions[${index}].rootLayoutNodeId`,
      errors,
      domain,
    );

    if (regionType === undefined || rootLayoutNodeId === undefined) {
      continue;
    }

    parsed.push({
      id: readOptionalInteger(entry.id, `regions[${index}].id`, errors),
      regionType,
      rootLayoutNodeId,
      status: readOptionalInteger(entry.status, `regions[${index}].status`, errors, {
        min: 0,
        allowZero: true,
      }),
      flags: readOptionalInteger(entry.flags, `regions[${index}].flags`, errors, {
        min: 0,
        allowZero: true,
      }),
      visibilityMask: readOptionalInteger(
        entry.visibilityMask,
        `regions[${index}].visibilityMask`,
        errors,
        { min: 0, allowZero: true },
      ),
      sortOrder: readOptionalInteger(entry.sortOrder, `regions[${index}].sortOrder`, errors, {
        min: 0,
        allowZero: true,
      }) ?? 0,
      config: readRenderableConfig(entry.config, `regions[${index}].config`, errors),
    });
  }

  return parsed;
}

function parseOverlays(value: unknown, errors: string[], domain: PhiCmsInstanceDomain) {
  if (!Array.isArray(value)) {
    errors.push("overlays must be an array.");
    return [];
  }

  const parsed: CmsDraftOverlayInput[] = [];

  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      errors.push(`overlays[${index}] must be an object.`);
      continue;
    }

    const id = readRequiredCmsInstanceId(entry.id, `overlays[${index}].id`, errors, domain);
    const overlayType = readRequiredString(entry.overlayType, `overlays[${index}].overlayType`, errors);
    const headerLayoutNodeId = readNullableOptionalCmsInstanceId(
      entry.headerLayoutNodeId,
      `overlays[${index}].headerLayoutNodeId`,
      errors,
      domain,
    );
    const bodyLayoutNodeId = readRequiredCmsInstanceId(
      entry.bodyLayoutNodeId,
      `overlays[${index}].bodyLayoutNodeId`,
      errors,
      domain,
    );
    const footerLayoutNodeId = readNullableOptionalCmsInstanceId(
      entry.footerLayoutNodeId,
      `overlays[${index}].footerLayoutNodeId`,
      errors,
      domain,
    );
    if (entry.headerLayoutNodeId === undefined) {
      errors.push(`overlays[${index}].headerLayoutNodeId must be null or a canonical ${domain} PhiCmsInstanceId.`);
    }
    if (entry.footerLayoutNodeId === undefined) {
      errors.push(`overlays[${index}].footerLayoutNodeId must be null or a canonical ${domain} PhiCmsInstanceId.`);
    }
    if (overlayType !== undefined && overlayType !== "modal" && overlayType !== "drawer") {
      errors.push(`overlays[${index}].overlayType must be modal or drawer.`);
    }

    if (
      id === undefined ||
      (overlayType !== "modal" && overlayType !== "drawer") ||
      headerLayoutNodeId === undefined ||
      bodyLayoutNodeId === undefined ||
      footerLayoutNodeId === undefined
    ) {
      continue;
    }

    parsed.push({
      id,
      overlayType,
      headerLayoutNodeId,
      bodyLayoutNodeId,
      footerLayoutNodeId,
      status: readOptionalInteger(entry.status, `overlays[${index}].status`, errors, {
        min: 0,
        allowZero: true,
      }),
      flags: readOptionalInteger(entry.flags, `overlays[${index}].flags`, errors, {
        min: 0,
        allowZero: true,
      }),
      visibilityMask: readOptionalInteger(
        entry.visibilityMask,
        `overlays[${index}].visibilityMask`,
        errors,
        { min: 0, allowZero: true },
      ),
      sortOrder: readOptionalInteger(entry.sortOrder, `overlays[${index}].sortOrder`, errors, {
        min: 0,
        allowZero: true,
      }) ?? 0,
      label: readOptionalString(entry.label, `overlays[${index}].label`, errors, {
        allowEmpty: false,
        nullable: true,
      }),
      config: readRenderableConfig(entry.config, `overlays[${index}].config`, errors),
    });
  }

  return parsed;
}

function validateUniqueNodeIds(
  overlays: CmsDraftOverlayInput[],
  layoutNodes: CmsDraftLayoutNodeInput[],
  contentWidgets: CmsDraftContentWidgetInput[],
  errors: string[],
) {
  const seen = new Set<string>();

  for (const overlay of overlays) {
    if (seen.has(overlay.id)) {
      errors.push(`Duplicate node id ${overlay.id}.`);
      continue;
    }
    seen.add(overlay.id);
  }

  for (const layoutNode of layoutNodes) {
    const key = layoutNode.id;
    if (seen.has(key)) {
      errors.push(`Duplicate node id ${layoutNode.id}.`);
      continue;
    }

    seen.add(key);
  }

  for (const contentWidget of contentWidgets) {
    const key = contentWidget.id;
    if (seen.has(key)) {
      errors.push(`Duplicate node id ${contentWidget.id}.`);
      continue;
    }

    seen.add(key);
  }
}

function validateNodeSignalRoutes(
  overlays: CmsDraftOverlayInput[],
  layoutNodes: CmsDraftLayoutNodeInput[],
  contentWidgets: CmsDraftContentWidgetInput[],
  errors: string[],
) {
  const activeIds = new Set<PhiCmsInstanceId>([
    ...overlays.map((node) => node.id),
    ...layoutNodes.map((node) => node.id),
    ...contentWidgets.map((node) => node.id),
  ]);
  for (const node of [...overlays, ...layoutNodes, ...contentWidgets]) {
    errors.push(...collectCmsSignalRouteErrors(
      node.config?.signalRoutes,
      activeIds,
      `CMS node ${node.id}.signalRoutes`,
    ));
  }
}

function validateReferences(
  overlays: CmsDraftOverlayInput[],
  layoutNodes: CmsDraftLayoutNodeInput[],
  contentWidgets: CmsDraftContentWidgetInput[],
  rootLayoutNodeIds: PhiCmsInstanceId[],
  pageRootLayoutNodeIds: Array<PhiCmsInstanceId | null | undefined>,
  errors: string[],
) {
  const layoutIds = new Set(layoutNodes.map((widget) => widget.id));
  const claimedRootIds = new Map<PhiCmsInstanceId, string>();

  const claimRoot = (rootLayoutNodeId: PhiCmsInstanceId, owner: string) => {
    const existingOwner = claimedRootIds.get(rootLayoutNodeId);
    if (existingOwner) {
      errors.push(`Root layout ${rootLayoutNodeId} is shared by ${existingOwner} and ${owner}.`);
      return;
    }
    claimedRootIds.set(rootLayoutNodeId, owner);
  };

  for (const overlay of overlays) {
    const roots = [
      ["header", overlay.headerLayoutNodeId],
      ["body", overlay.bodyLayoutNodeId],
      ["footer", overlay.footerLayoutNodeId],
    ] as const;
    for (const [zone, rootLayoutNodeId] of roots) {
      if (rootLayoutNodeId == null) continue;
      claimRoot(rootLayoutNodeId, `overlay ${overlay.id} ${zone}`);
      if (!layoutIds.has(rootLayoutNodeId)) {
        errors.push(`Overlay ${zone} root layout ${rootLayoutNodeId} does not exist in layoutNodes.`);
        continue;
      }
      const root = layoutNodes.find((widget) => widget.id === rootLayoutNodeId);
      if (root?.parentLayoutNodeId !== null) {
        errors.push(`Overlay ${zone} root layout ${rootLayoutNodeId} must be a top-level layout.`);
      }
    }
  }

  for (const widget of layoutNodes) {
    if (widget.parentLayoutNodeId === null) {
      continue;
    }

    if (!layoutIds.has(widget.parentLayoutNodeId)) {
      errors.push(
        `Layout node ${widget.id} references missing parent layout ${widget.parentLayoutNodeId}.`,
      );
    }
  }

  for (const widget of contentWidgets) {
    if (!layoutIds.has(widget.parentLayoutNodeId)) {
      errors.push(
        `Content widget ${widget.id} references missing parent layout ${widget.parentLayoutNodeId}.`,
      );
    }
  }

  for (const rootLayoutNodeId of rootLayoutNodeIds) {
    claimRoot(rootLayoutNodeId, "a Region");
    if (!layoutIds.has(rootLayoutNodeId)) {
      errors.push(`Region root layout ${rootLayoutNodeId} does not exist in layoutNodes.`);
      continue;
    }

    const root = layoutNodes.find((widget) => widget.id === rootLayoutNodeId);
    if (root?.parentLayoutNodeId !== null) {
      errors.push(`Region root layout ${rootLayoutNodeId} must be a top-level layout.`);
    }
  }

  for (const pageRootLayoutNodeId of pageRootLayoutNodeIds) {
    if (pageRootLayoutNodeId !== undefined && pageRootLayoutNodeId !== null) {
      claimRoot(pageRootLayoutNodeId, "a Page Region");
      if (!layoutIds.has(pageRootLayoutNodeId)) {
        errors.push(`Page root layout ${pageRootLayoutNodeId} does not exist in layoutNodes.`);
      } else {
        const root = layoutNodes.find((widget) => widget.id === pageRootLayoutNodeId);
        if (root?.parentLayoutNodeId !== null) {
          errors.push(`Page root layout ${pageRootLayoutNodeId} must be a top-level layout.`);
        }
      }
    }
  }
}

function validateSingleNodePerSlot(
  layoutNodes: CmsDraftLayoutNodeInput[],
  contentWidgets: CmsDraftContentWidgetInput[],
  errors: string[],
) {
  const counts = new Map<string, number>();

  for (const entry of [...layoutNodes, ...contentWidgets]) {
    const parentId = "parentLayoutNodeId" in entry ? entry.parentLayoutNodeId : null;
    if (parentId === null || parentId === undefined) {
      continue;
    }

    const key = `${parentId}:${entry.slotIndex}`;
    const nextCount = (counts.get(key) ?? 0) + 1;
    counts.set(key, nextCount);

    if (nextCount > 1) {
      errors.push(
        `Layout slot ${entry.slotIndex} on parent layout ${parentId} contains more than one direct node.`,
      );
    }
  }
}

function buildFailure(error: string, details: string[]): CmsValidationResult<never> {
  return {
    ok: false,
    error,
    details,
  };
}

/**
 * The same shape, read for two different reasons.
 *
 * A *write* carries one draft's work and must not carry the other's, which is what the ownership rule
 * is for. A *stored* revision is the product of one or the other -- and after a publish merge, of both
 * -- so reading one back under the write rule refused every Module draft the moment anything tried to
 * read it again: written once, unreadable afterwards, including by its own publish.
 */
export function validateCmsAreaPresetWriteInput(
  payload: unknown,
  options?: { config?: "structure" | "stored" },
): CmsValidationResult<CmsAreaPresetWriteInput> {
  if (!isRecord(payload)) {
    return buildFailure("Invalid request body.", ["Body must be an object."]);
  }

  const errors: string[] = [];
  const area = normalizeCmsArea(payload.area, errors);
  const areaMask = area ? resolveCmsAreaMaskFromArea(area, errors) : undefined;
  const sourcePreset = readCmsPresetSource(payload.sourcePreset, "sourcePreset", errors);
  const draft = readDraftWriteState(payload.draft, errors);
  const preset = isRecord(payload.preset)
    ? {
        id: readOptionalInteger(payload.preset.id, "preset.id", errors),
        status: readOptionalInteger(payload.preset.status, "preset.status", errors, {
          min: 0,
          allowZero: true,
        }),
        flags: readOptionalInteger(payload.preset.flags, "preset.flags", errors, {
          min: 0,
          allowZero: true,
        }),
        visibilityMask: readOptionalInteger(
          payload.preset.visibilityMask,
          "preset.visibilityMask",
          errors,
          { min: 0, allowZero: true },
        ),
        config: readAreaPresetConfig(payload.preset.config, options?.config ?? "structure", errors),
      }
    : undefined;

  const regions = parseRegions(payload.regions, errors, "area");
  const overlays = parseOverlays(payload.overlays, errors, "area");
  const layoutNodes = parseLayoutNodes(payload.layoutNodes, errors, "area");
  const contentWidgets = parseContentWidgets(payload.contentWidgets, errors, "area");

  validateUniqueNodeIds(overlays, layoutNodes, contentWidgets, errors);
  validateNodeSignalRoutes(overlays, layoutNodes, contentWidgets, errors);
  validateReferences(
    overlays,
    layoutNodes,
    contentWidgets,
    regions.map((region) => region.rootLayoutNodeId),
    [],
    errors,
  );
  validateSingleNodePerSlot(layoutNodes, contentWidgets, errors);

  if (area === undefined || areaMask === undefined || sourcePreset == null || errors.length > 0) {
    return buildFailure("Invalid CMS area preset payload.", errors);
  }

  return {
    ok: true,
    value: {
      area,
      areaMask,
      sourcePreset,
      draft,
      preset,
      regions,
      overlays,
      layoutNodes,
      contentWidgets,
    },
  };
}

/**
 * Reads an Area preset config and holds the namespace boundary while doing it.
 *
 * `config.shell` belongs to the structure draft and `config.modules` to the Module selection; a write
 * that carries the other side's namespace is rejected rather than quietly dropped, because a client
 * sending it is a client that believes it owns something it does not. A key outside both namespaces is
 * refused for the same reason: a value nothing can read back is a bug on its way to being stored.
 */
/**
 * The addresses this Site gave Public routes whose declared path was taken.
 *
 * Shape only, and strictly: a route names itself by its Module and preset, and the address is a fixed
 * path -- a dynamic segment belongs to the route the Module declared, not to an answer somebody typed
 * into a dialog. The reader in the site UI drops an entry it cannot act on, which is right for a read
 * that runs on every request; here is where being wrong is worth refusing.
 */
function readAreaPublicRoutePaths(value: unknown, errors: string[], label: string) {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array.`);
    return;
  }

  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${entryLabel} must be an object.`);
      return;
    }
    const ownerModuleId = typeof entry.ownerModuleId === "string" ? entry.ownerModuleId.trim() : "";
    const presetKey = typeof entry.presetKey === "string" ? entry.presetKey.trim() : "";
    if (!ownerModuleId || !presetKey) {
      errors.push(`${entryLabel} must name ownerModuleId and presetKey.`);
      return;
    }
    if (typeof entry.path !== "string" || !isAssignablePublicRoutePath(entry.path)) {
      errors.push(`${entryLabel}.path must be a fixed path such as "/sign-in".`);
      return;
    }
    const identity = `${ownerModuleId}/${presetKey}`;
    if (seen.has(identity)) {
      errors.push(`${label} names route "${identity}" twice.`);
      return;
    }
    seen.add(identity);
  });
}

const PUBLIC_ROUTE_PATH_SEGMENT_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._~-]*$/u;

function isAssignablePublicRoutePath(value: string) {
  if (!value.startsWith("/") || value === "/") {
    return false;
  }
  const segments = value.split("/");
  return segments[0] === "" &&
    segments.length > 1 &&
    segments.slice(1).every((segment) => PUBLIC_ROUTE_PATH_SEGMENT_PATTERN.test(segment));
}

function readAreaPresetConfig(
  value: unknown,
  owns: "structure" | "modules" | "stored",
  errors: string[],
  label = "preset.config",
) {
  const config = readOptionalRecord(value, label, errors) ?? {};
  const owned = owns === "structure" ? PHI_AREA_CONFIG_SHELL_NAMESPACE : PHI_AREA_CONFIG_MODULES_NAMESPACE;

  for (const key of Object.keys(config)) {
    // `stored` accepts either namespace: what is on disk was written by whichever draft owns it, and a
    // published revision carries both because the publish merge put them together. What stays refused
    // everywhere is a namespace nothing can read back at all.
    if (key === owned || (owns === "stored" && isPhiAreaConfigNamespace(key))) {
      continue;
    }
    errors.push(
      isPhiAreaConfigNamespace(key)
        ? `${label}.${key} belongs to the other draft and must not be written here.`
        : `${label}.${key} is not a known Area config namespace.`,
    );
  }

  if (owns !== "modules" && config[PHI_AREA_CONFIG_SHELL_NAMESPACE] !== undefined) {
    readAreaShellConfig(
      config[PHI_AREA_CONFIG_SHELL_NAMESPACE],
      errors,
      `${label}.${PHI_AREA_CONFIG_SHELL_NAMESPACE}`,
    );
  }

  return config;
}

/**
 * What the Shell may state about itself.
 *
 * The shape is checked here and the meaning is not: whether the Page a root route forwards to still
 * exists is the reader's question, asked again on every request, because the answer changes when a
 * Module is switched off or a Page is deleted long after this write. What must not reach the database
 * is a value nothing can read back at all -- an unknown key, or a target that is not a Page reference.
 */
function readAreaShellConfig(value: unknown, errors: string[], label: string) {
  const shell = readOptionalRecord(value, label, errors);
  if (!shell) {
    return;
  }

  for (const key of Object.keys(shell)) {
    if (key !== PHI_AREA_ROOT_ROUTE_KEY && key !== PHI_AREA_META_KEY) {
      errors.push(`${label}.${key} is not a known Shell config key.`);
    }
  }

  readAreaMetaConfig(shell[PHI_AREA_META_KEY], errors, `${label}.${PHI_AREA_META_KEY}`);

  if (shell[PHI_AREA_ROOT_ROUTE_KEY] === undefined) {
    return;
  }
  const rootRoute = readOptionalRecord(shell[PHI_AREA_ROOT_ROUTE_KEY], `${label}.${PHI_AREA_ROOT_ROUTE_KEY}`, errors);
  if (!rootRoute) {
    return;
  }

  const rootRouteLabel = `${label}.${PHI_AREA_ROOT_ROUTE_KEY}`;
  if (rootRoute.mode === "landing") {
    // A landing names the applicant whose Page stands at the root, or nothing -- a landing without an
    // applicant is a Page the Site authors itself, which is a state and not an omission.
    if (rootRoute.target !== undefined && !readPhiPageReference(rootRoute.target)) {
      errors.push(`${rootRouteLabel}.target must be an internal Page reference.`);
    }
    return;
  }
  if (rootRoute.mode !== "redirect") {
    errors.push(`${rootRouteLabel}.mode must be "landing" or "redirect".`);
    return;
  }
  if (!readPhiPageReference(rootRoute.target)) {
    errors.push(`${rootRouteLabel}.target must be an internal Page reference.`);
  }
}

/**
 * What an Area may state about the head of its Pages.
 *
 * Every key optional, because the Shell states its config whole on every structure save: an Area that
 * was never asked sends nothing rather than a guess. Whether the answers change anything -- only
 * Public is indexed at all -- is the reader's question, as it is for the root route.
 *
 * The template is checked for its placeholder and not merely for being a string. A template without
 * one is not a formatting slip but a Site where every Page has the same title, which no reader can
 * detect and no Operator would have meant; and it is the write path, so it is refused here rather
 * than worked around later.
 */
const AREA_META_BOOLEAN_KEYS = new Set(["index", "sitemap"]);
const AREA_META_TEXT_KEYS = new Set(["titleTemplate", "defaultTitle"]);
const AREA_META_TITLE_MAX_LENGTH = 200;

function readAreaMetaConfig(value: unknown, errors: string[], label: string) {
  if (value === undefined) {
    return;
  }
  const meta = readOptionalRecord(value, label, errors);
  if (!meta) {
    return;
  }
  for (const key of Object.keys(meta)) {
    if (AREA_META_BOOLEAN_KEYS.has(key)) {
      if (typeof meta[key] !== "boolean") {
        errors.push(`${label}.${key} must be a boolean.`);
      }
      continue;
    }
    if (!AREA_META_TEXT_KEYS.has(key)) {
      errors.push(`${label}.${key} is not a known area meta key.`);
      continue;
    }
    const text = meta[key];
    if (typeof text !== "string") {
      errors.push(`${label}.${key} must be a string.`);
      continue;
    }
    if (text.length > AREA_META_TITLE_MAX_LENGTH) {
      errors.push(`${label}.${key} must be at most ${AREA_META_TITLE_MAX_LENGTH} characters.`);
      continue;
    }
    if (key === "titleTemplate" && text.trim() && !text.includes("%s")) {
      errors.push(`${label}.${key} must contain the "%s" placeholder for the Page's own title.`);
    }
  }
}

export function validateCmsAreaModulesWriteInput(
  payload: unknown,
): CmsValidationResult<CmsAreaModulesWriteInput> {
  if (!isRecord(payload)) {
    return buildFailure("Invalid request body.", ["Body must be an object."]);
  }

  const errors: string[] = [];
  const area = normalizeCmsArea(payload.area, errors);
  const areaMask = area ? resolveCmsAreaMaskFromArea(area, errors) : undefined;
  const sourcePreset = readCmsPresetSource(payload.sourcePreset, "sourcePreset", errors);
  const draft = readDraftWriteState(payload.draft, errors);
  const config = payload.config === undefined
    ? undefined
    : readAreaPresetConfig(payload.config, "modules", errors, "config");
  const modules = readPhiAreaConfigNamespace(config, PHI_AREA_CONFIG_MODULES_NAMESPACE);

  if (config === undefined) {
    errors.push("config must be provided as an object.");
  } else if (modules === undefined) {
    errors.push(`config.${PHI_AREA_CONFIG_MODULES_NAMESPACE} must be provided as an object.`);
  } else if (
    !Array.isArray(modules.runtimeModules) ||
    modules.runtimeModules.some((moduleId) => typeof moduleId !== "string" || moduleId.trim() === "")
  ) {
    // Which ids are allowed for this Area is the catalog's answer and is settled before the write.
    // What is checked here is only the shape, so a malformed body fails as a bad request rather than
    // reaching the database as a config nothing can read back.
    errors.push(`config.${PHI_AREA_CONFIG_MODULES_NAMESPACE}.runtimeModules must be an array of module ids.`);
  }

  if (modules !== undefined) {
    readAreaPublicRoutePaths(
      modules[PHI_AREA_PUBLIC_ROUTE_PATHS_KEY],
      errors,
      `config.${PHI_AREA_CONFIG_MODULES_NAMESPACE}.${PHI_AREA_PUBLIC_ROUTE_PATHS_KEY}`,
    );
  }

  let baseline: CmsAreaPresetWriteInput | undefined;
  if (payload.baseline !== undefined) {
    const validatedBaseline = validateCmsAreaPresetWriteInput(payload.baseline);
    if (!validatedBaseline.ok) {
      errors.push(`baseline is not a valid Area payload. ${validatedBaseline.error}`);
      errors.push(...(validatedBaseline.details ?? []));
    } else if (validatedBaseline.value.areaMask !== areaMask) {
      errors.push("baseline must describe the same Area.");
    } else {
      baseline = validatedBaseline.value;
    }
  }

  if (area === undefined || areaMask === undefined || sourcePreset == null || config === undefined || errors.length > 0) {
    return buildFailure("Invalid CMS Area Module payload.", errors);
  }

  return {
    ok: true,
    value: {
      area,
      areaMask,
      sourcePreset,
      draft,
      config,
      baseline,
    },
  };
}

export function validateCmsPageWriteInput(payload: unknown): CmsValidationResult<CmsPageWriteInput> {
  if (!isRecord(payload)) {
    return buildFailure("Invalid request body.", ["Body must be an object."]);
  }

  const errors: string[] = [];
  const area = normalizeCmsArea(payload.area, errors);
  const areaMask = area ? resolveCmsAreaMaskFromArea(area, errors) : undefined;
  const path = normalizeCmsStoragePath(payload.path, errors);
  const sourcePreset = Object.prototype.hasOwnProperty.call(payload, "sourcePreset")
    ? readCmsPresetSource(payload.sourcePreset, "sourcePreset", errors, { nullable: true })
    : (errors.push("sourcePreset must be provided as an object or null."), undefined);
  const draft = readDraftWriteState(payload.draft, errors);
  let pageMeta: CmsPageWriteInput["pageMeta"] = undefined;
  if (payload.pageMeta !== undefined) {
    if (!isRecord(payload.pageMeta)) {
      errors.push("pageMeta must be an object.");
    } else {
      pageMeta = {
        title: readOptionalString(payload.pageMeta.title, "pageMeta.title", errors, {
          allowEmpty: true,
          nullable: true,
        }),
        description: readOptionalString(payload.pageMeta.description, "pageMeta.description", errors, {
          allowEmpty: true,
          nullable: true,
        }),
      };
    }
  }
  const page = isRecord(payload.page)
    ? {
        id: readOptionalInteger(payload.page.id, "page.id", errors),
        pageType: readOptionalInteger(payload.page.pageType, "page.pageType", errors, {
          min: 0,
          allowZero: true,
        }),
        status: readOptionalInteger(payload.page.status, "page.status", errors, {
          min: 0,
          allowZero: true,
        }),
        flags: readOptionalInteger(payload.page.flags, "page.flags", errors, {
          min: 0,
          allowZero: true,
        }),
        visibilityMask: readOptionalInteger(payload.page.visibilityMask, "page.visibilityMask", errors, {
          min: 0,
          allowZero: true,
        }),
        accessPolicy: readViewerAccessPolicy(
          payload.page.accessPolicy,
          "page.accessPolicy",
          errors,
        ),
        titleMsgId: readNullableOptionalInteger(payload.page.titleMsgId, "page.titleMsgId", errors, {}),
        descriptionMsgId: readNullableOptionalInteger(
          payload.page.descriptionMsgId,
          "page.descriptionMsgId",
          errors,
          {},
        ),
        heroRootLayoutNodeId: readNullableOptionalCmsInstanceId(
          payload.page.heroRootLayoutNodeId,
          "page.heroRootLayoutNodeId",
          errors,
          "page",
        ),
        headerBottomRootLayoutNodeId: readNullableOptionalCmsInstanceId(
          payload.page.headerBottomRootLayoutNodeId,
          "page.headerBottomRootLayoutNodeId",
          errors,
          "page",
        ),
        siderRightRootLayoutNodeId: readNullableOptionalCmsInstanceId(
          payload.page.siderRightRootLayoutNodeId,
          "page.siderRightRootLayoutNodeId",
          errors,
          "page",
        ),
        footerTopRootLayoutNodeId: readNullableOptionalCmsInstanceId(
          payload.page.footerTopRootLayoutNodeId,
          "page.footerTopRootLayoutNodeId",
          errors,
          "page",
        ),
        drawerRightRootLayoutNodeId: readNullableOptionalCmsInstanceId(
          payload.page.drawerRightRootLayoutNodeId,
          "page.drawerRightRootLayoutNodeId",
          errors,
          "page",
        ),
        contentRootLayoutNodeId: readNullableOptionalCmsInstanceId(
          payload.page.contentRootLayoutNodeId,
          "page.contentRootLayoutNodeId",
          errors,
          "page",
        ),
        layoutConfig: readOptionalRecord(payload.page.layoutConfig, "page.layoutConfig", errors) ?? {},
      }
    : undefined;

  const overlays = parseOverlays(payload.overlays, errors, "page");
  const layoutNodes = parseLayoutNodes(payload.layoutNodes, errors, "page");
  const contentWidgets = parseContentWidgets(payload.contentWidgets, errors, "page");

  validateUniqueNodeIds(overlays, layoutNodes, contentWidgets, errors);
  validateNodeSignalRoutes(overlays, layoutNodes, contentWidgets, errors);
  validateReferences(
    overlays,
    layoutNodes,
    contentWidgets,
    [],
    [
      page?.heroRootLayoutNodeId,
      page?.headerBottomRootLayoutNodeId,
      page?.siderRightRootLayoutNodeId,
      page?.footerTopRootLayoutNodeId,
      page?.drawerRightRootLayoutNodeId,
      page?.contentRootLayoutNodeId,
    ],
    errors,
  );
  validateSingleNodePerSlot(layoutNodes, contentWidgets, errors);

  if (
    area === undefined ||
    areaMask === undefined ||
    path === undefined ||
    sourcePreset === undefined ||
    errors.length > 0
  ) {
    return buildFailure("Invalid CMS page payload.", errors);
  }

  return {
    ok: true,
    value: {
      area,
      areaMask,
      path,
      sourcePreset,
      draft,
      pageMeta,
      page,
      overlays,
      layoutNodes,
      contentWidgets,
    },
  };
}
