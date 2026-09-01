/*
 * The vocabularies come from `@phis/contracts/signals`, not from a copy kept here. They were a copy
 * once: `@phis/ui` had grown `date`, `time` and `length`, this file had not, and a length control's
 * change signal was refused on save with "valueType is invalid" -- a widget the same release shipped.
 */
import {
  isPhiSignalAction,
  isPhiSignalScope,
  isPhiSignalValueSchemaShape,
  isPhiSignalValueType,
} from "@phis/contracts/signals";

import type { PhiCmsInstanceId } from "@/lib/cms/instance-id";
import { isPhiCmsInstanceId } from "@/lib/cms/instance-id";

type JsonRecord = Record<string, unknown>;

const PHI_CORE_CONTROLLER_ADDRESS = "controller:@phis/ui/modules/core/controller/default:default";

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAddressSegment(value: string) {
  return value.length > 0 && !value.includes("/") && !value.includes(":");
}

function isNpmPackageName(value: string) {
  if (!value || value.includes(":") || value.length > 214) {
    return false;
  }
  return value.startsWith("@")
    ? /^@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*$/.test(value)
    : /^[a-z0-9][a-z0-9._~-]*$/.test(value);
}

function readCmsAddressInstanceId(address: string) {
  if (!address.startsWith("cms:")) {
    return null;
  }
  const parts = address.slice("cms:".length).split(":");
  if (
    (parts.length !== 1 && parts.length !== 2) ||
    !isPhiCmsInstanceId(parts[0]) ||
    (parts.length === 2 && !isAddressSegment(parts[1]!))
  ) {
    return null;
  }
  return parts[0];
}

function isRegionAddress(address: string) {
  return address.startsWith("region:") && isAddressSegment(address.slice("region:".length));
}

function isControllerAddress(address: string) {
  if (!address.startsWith("controller:")) {
    return false;
  }
  const body = address.slice("controller:".length);
  const instanceSeparatorIndex = body.lastIndexOf(":");
  if (instanceSeparatorIndex <= 0 || instanceSeparatorIndex === body.length - 1) {
    return false;
  }
  const namespacedType = body.slice(0, instanceSeparatorIndex);
  const instanceKey = body.slice(instanceSeparatorIndex + 1);
  const controllerSeparatorIndex = namespacedType.lastIndexOf("/");
  if (controllerSeparatorIndex <= 0 || controllerSeparatorIndex === namespacedType.length - 1) {
    return false;
  }
  return (
    isControllerPluginKey(namespacedType.slice(0, controllerSeparatorIndex)) &&
    isAddressSegment(namespacedType.slice(controllerSeparatorIndex + 1)) &&
    isAddressSegment(instanceKey)
  );
}

/**
 * A controller lives in the namespace of the module that owns it, so a plugin key is either a bare
 * package name or that package followed by `/modules/<module>/<namespace>`. This mirrors the grammar
 * in @phis/ui; phi-server cannot import it, because it does not depend on the UI package.
 */
function isControllerPluginKey(value: string) {
  const marker = value.indexOf("/modules/");
  if (marker < 0) {
    return isNpmPackageName(value);
  }
  const rest = value.slice(marker + "/modules/".length).split("/");
  return (
    isNpmPackageName(value.slice(0, marker)) &&
    rest.length === 2 &&
    rest.every((part) => isAddressSegment(part))
  );
}


/**
 * Every error a stored signal wiring can carry, collected rather than thrown one at a time.
 *
 * The vocabularies come from `@phis/contracts/signals` and the value schema is checked for its shape
 * only -- `isPhiSignalValueSchemaShape`. Which schemas exist is the UI's to know: refusing one because
 * phi-server had never heard of the package would refuse every third party's.
 */
export function collectCmsSignalRouteErrors(
  value: unknown,
  activeIds: ReadonlySet<PhiCmsInstanceId>,
  label: string,
) {
  const errors: string[] = [];
  if (value == null) {
    return errors;
  }
  if (!isRecord(value)) {
    return [`${label} must be an object or null.`];
  }

  const routeKeys = new Set<string>();
  for (const collectionKey of ["emits", "listens"] as const) {
    const collection = value[collectionKey];
    if (collection == null) {
      continue;
    }
    if (!Array.isArray(collection)) {
      errors.push(`${label}.${collectionKey} must be an array or null.`);
      continue;
    }
    collection.forEach((route, index) => {
      const routeLabel = `${label}.${collectionKey}[${index}]`;
      if (!isRecord(route)) {
        errors.push(`${routeLabel} must be an object.`);
        return;
      }
      const routeKey = typeof route.routeKey === "string" ? route.routeKey.trim() : "";
      const capabilityId = typeof route.capabilityId === "string" ? route.capabilityId.trim() : "";
      const channel = typeof route.channel === "string" ? route.channel.trim() : "";
      if (!routeKey || !capabilityId || !channel) {
        errors.push(`${routeLabel} requires routeKey, capabilityId, and channel.`);
      } else if (routeKeys.has(routeKey)) {
        errors.push(`${label} contains duplicate routeKey "${routeKey}".`);
      } else {
        routeKeys.add(routeKey);
      }
      if (!isPhiSignalScope(route.scope)) {
        errors.push(`${routeLabel}.scope is invalid.`);
      }
      if (!isPhiSignalAction(route.action)) {
        errors.push(`${routeLabel}.action is invalid.`);
      }
      if (!isPhiSignalValueType(route.valueType)) {
        errors.push(`${routeLabel}.valueType is invalid.`);
      }
      if (route.valueType === "json" && !isPhiSignalValueSchemaShape(route.valueSchema)) {
        errors.push(`${routeLabel}.valueSchema is required for JSON values.`);
      }

      const receiver = route.receiver;
      if (receiver === null) {
        return;
      }
      if (receiver === "broadcast") {
        if (route.scope === "site") {
          errors.push(`${routeLabel} must not broadcast in Site scope.`);
        }
        return;
      }
      if (typeof receiver !== "string") {
        errors.push(`${routeLabel}.receiver must be null, broadcast, or a signal address.`);
        return;
      }
      const cmsInstanceId = readCmsAddressInstanceId(receiver);
      if (cmsInstanceId) {
        if (!activeIds.has(cmsInstanceId)) {
          errors.push(`${routeLabel} targets an unknown CMS instance.`);
        }
        if (route.scope === "site") {
          errors.push(`${routeLabel} must not target a CMS instance in Site scope.`);
        }
        return;
      }
      if (isRegionAddress(receiver)) {
        if (route.scope === "site") {
          errors.push(`${routeLabel} must not target a Region in Site scope.`);
        }
        return;
      }
      if (isControllerAddress(receiver)) {
        if (route.scope === "site" && receiver !== PHI_CORE_CONTROLLER_ADDRESS) {
          errors.push(`${routeLabel} may target only the Core Runtime Controller in Site scope.`);
        }
        return;
      }
      errors.push(`${routeLabel}.receiver is not a canonical signal address.`);
    });
  }

  return errors;
}
