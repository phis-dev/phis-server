/*
 * The vocabularies come from `@phis/contracts/signals`, not from a copy kept here. They were a copy
 * once: `@phis/ui` had grown `date`, `time` and `length`, this file had not, and a length control's
 * change signal was refused on save with "valueType is invalid" -- a widget the same release shipped.
 */
import {
  isPhiSignalReceiver,
  readPhiCmsSignalAddressInstanceId,
  readPhiSignalReceiverScopeProblem,
  isPhiSignalAction,
  isPhiSignalScope,
  isPhiSignalValueSchemaShape,
  isPhiSignalValueType,
} from "@phis/contracts/signals";

import type { PhiCmsInstanceId } from "@/lib/cms/instance-id";
import { isPhiRecord } from "@/lib/helpers/record";


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
  if (!isPhiRecord(value)) {
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
      if (!isPhiRecord(route)) {
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
      if (!isPhiSignalReceiver(receiver)) {
        errors.push(typeof receiver === "string"
          ? `${routeLabel}.receiver is not a canonical signal address.`
          : `${routeLabel}.receiver must be null, broadcast, or a signal address.`);
        return;
      }
      /*
       * Which receivers a scope admits is the contract's sentence, not one written twice.
       *
       * The site UI refuses to deliver the same combinations at runtime; what differs is only what
       * each side does with the answer -- a rejected write here, a dropped signal there.
       */
      const scopeProblem = isPhiSignalScope(route.scope)
        ? readPhiSignalReceiverScopeProblem(route.scope, receiver)
        : null;
      if (scopeProblem) {
        errors.push(`${routeLabel} ${scopeProblem}.`);
      }
      const cmsInstanceId = receiver === "broadcast" ? null : readPhiCmsSignalAddressInstanceId(receiver);
      if (cmsInstanceId && !activeIds.has(cmsInstanceId)) {
        errors.push(`${routeLabel} targets an unknown CMS instance.`);
      }
    });
  }

  return errors;
}
