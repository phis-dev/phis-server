import type {
  PhisPayment, PhisPaymentFeatures, PhisPaymentOperation, PhisPaymentProfileDraft, PhisPaymentProviderBinding,
  PhisPaymentProviderCommand, PhisPaymentRefund, PhisPaymentProviderProbe,
} from "@phis/contracts/payments";

export type PhisPaymentProfile = PhisPaymentProfileDraft & {
  siteId: number;
  providerAddonId: string;
  merchantIdentity: string | null;
  revision: number;
  enabled: boolean;
  retired: boolean;
  probedAt: string | null;
  methods: PhisPaymentProviderProbe["methods"] | null;
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
