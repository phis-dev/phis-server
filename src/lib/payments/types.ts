import type {
  PhisPayment, PhisPaymentFeatures, PhisPaymentOperation, PhisPaymentProfileDraft, PhisPaymentProfileFeatures, PhisPaymentProviderBinding,
  PhisPaymentProviderCommand, PhisPaymentRefund, PhisPaymentStoredMethod, PhisPaymentSubscription, PhisPaymentSubscriptionChange,
} from "@phis/contracts/payments";
import type { PhisEntitlementSubject } from "@phis/contracts/entitlements";

export type PhisPaymentProfile = PhisPaymentProfileDraft & {
  siteId: number;
  providerAddonId: string;
  merchantIdentity: string | null;
  revision: number;
  enabled: boolean;
  retired: boolean;
  /** When Core last asked the Provider about this profile, in any currency. */
  probedAt: string | null;
  /**
   * What the Provider declared when Core last asked in each currency, per pricing policy
   * (`phis.payment_profiles.features`, keyed by the uppercase currency code); `null` until the first probe.
   */
  features: Readonly<Record<string, PhisPaymentProfileFeatures>> | null;
};

export type PhisStoredPayment = {
  siteId: number;
  consumerAddonId: string;
  providerKey: string;
  merchantIdentity: string;
  profileRevision: number;
  currencyExponent: number;
  features: PhisPaymentFeatures;
  binding: PhisPaymentProviderBinding | null;
  record: PhisPayment;
  generation: number;
  leaseToken: string | null;
  leaseUntil: Date | null;
  /**
   * The lease generation a verified notification met while the payment was held, until a reconciliation that
   * claimed after it has observed the Provider. Null when no notification waits.
   */
  notifiedGeneration: number | null;
  /** Whose documents this payment's are (`billing:v1`) and their list line; Core's own, never in the record. */
  documentSubject: PhisEntitlementSubject | null;
  documentLabel: string | null;
};

export type PhisStoredPaymentCommand = PhisPaymentProviderCommand extends infer T
  ? T extends PhisPaymentProviderCommand ? Omit<T, "signal"> : never : never;

export type PhisStoredPaymentOperation = {
  record: PhisPaymentOperation;
  command: PhisStoredPaymentCommand;
  request: Record<string, unknown>;
};

export type PhisStoredPaymentRefund = {
  record: PhisPaymentRefund;
  operationId: string | null;
  binding: PhisPaymentProviderBinding | null;
};

/**
 * A stored method with what only Core sees: the Provider's binding a charge is sent with, and the
 * method's features as they stood when it was stored.
 */
export type PhisStoredPaymentMethod = {
  siteId: number;
  consumerAddonId: string;
  features: PhisPaymentFeatures;
  binding: PhisPaymentProviderBinding | null;
  record: PhisPaymentStoredMethod;
};

/**
 * A subscription with what only Core sees: the request it was created from, for idempotency, the start of
 * its current term and the index of the term's first period, from which every boundary is computed (the
 * record's `term`, mirrored for the scheduler), and the scheduler's lease where one holds.
 */
export type PhisStoredPaymentSubscription = {
  siteId: number;
  consumerAddonId: string;
  record: PhisPaymentSubscription;
  request: Record<string, unknown>;
  anchorAt: string | null;
  termFirstIndex: number;
  leaseToken: string | null;
};

/** A change of a subscription's terms with the request it was made from, for idempotency. */
export type PhisStoredPaymentSubscriptionChange = {
  siteId: number;
  consumerAddonId: string;
  record: PhisPaymentSubscriptionChange;
  request: Record<string, unknown>;
};

/** Assigned by the dispatcher/job/event runner, never accepted from request arguments. */
export type PhisPaymentAuthority =
  | { kind: "request"; operator: boolean; actorUserId: number | null }
  | { kind: "job"; id: string }
  | { kind: "event"; id: string }
  | { kind: "hook" };

export type PhisPaymentScope = {
  siteId: number;
  siteKey: string;
  consumerAddonId: string;
};

export type PhisPaymentReceipt = {
  profileKey: string;
  deliveryId: string;
  token: string;
};
