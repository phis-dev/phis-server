import "server-only";

import type { PhisBillingCapabilityV1, PhisBillingDocumentKind } from "@phis/contracts/billing";
import type { PhisAddonManifestV1 } from "@phis/contracts/addon";

import { getPhisAddonInstalledManifest } from "@/lib/addons/installed";
import { listBillingListenersOf } from "@/lib/addons/commerce-listeners";
import {
  attachPhisBillingFile, getPhisBillingDocumentFor, issuePhisBillingDocument, listPhisBillingDocumentsFor, listPhisBillingSeriesRecords,
  openPhisBillingDocument, setPhisBillingPaymentState, voidPhisBillingDocument, type PhisBillingActor,
} from "./documents.ts";
import { PhisBillingError } from "./validation.ts";

/** The enabled Add-ons that declare a handler for `billing-document.changed`. */
export const listPhisBillingListeners = (): string[] => listBillingListenersOf(getPhisAddonInstalledManifest());

/** The installed Add-ons whose manifest declares that they issue documents: the only ones a series may name. */
export function listPhisBillingIssuers(): string[] {
  return Object.entries(getPhisAddonInstalledManifest())
    .filter(([, entry]) => (entry.manifest.billing?.issues?.length ?? 0) > 0)
    .map(([addonId]) => addonId)
    .sort();
}

/**
 * `billing:v1` for one request, job or event (SERVER_ADDONS.md, billing:v1): reading by the access rules,
 * issuing as an allowed source. An unverified hook reaches none of it.
 */
export function buildPhisAddonBillingCapability(input: {
  manifest: PhisAddonManifestV1;
  siteId: number;
  actorUserId: number | null;
  billingStaff: () => Promise<boolean>;
  unauthenticated?: boolean;
}): PhisBillingCapabilityV1 {
  const addonId = input.manifest.addonId;
  const actor: PhisBillingActor = { siteId: input.siteId, addonId, actorUserId: input.actorUserId, billingStaff: input.billingStaff, listeners: listPhisBillingListeners };
  const guard = <A extends unknown[], R>(call: string, run: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    if (input.unauthenticated) throw new PhisBillingError("forbidden", `${addonId} called billing.${call} from an unverified hook.`);
    return run(...args);
  };
  const declaredKinds = (input.manifest.billing?.issues ?? []) as readonly PhisBillingDocumentKind[];
  return Object.freeze({
    list: guard("list", (query) => listPhisBillingDocumentsFor(actor, query)),
    get: guard("get", (documentId) => getPhisBillingDocumentFor(actor, documentId)),
    open: guard("open", (query) => openPhisBillingDocument(actor, query)),
    issue: guard("issue", (document) => issuePhisBillingDocument(actor, document, {
      declaredKinds,
      mayIssueFor: (consumerAddonId) => getPhisAddonInstalledManifest()[consumerAddonId]?.manifest.billing?.issuedBy?.includes(addonId) === true,
    })),
    attachFile: guard("attachFile", (file) => attachPhisBillingFile(actor, file)),
    void: guard("void", (query) => voidPhisBillingDocument(actor, query)),
    setPaymentState: guard("setPaymentState", (query) => setPhisBillingPaymentState(actor, query)),
    listSeries: guard("listSeries", () => listPhisBillingSeriesRecords(input.siteId, { open: true, source: addonId })),
  } satisfies PhisBillingCapabilityV1);
}
