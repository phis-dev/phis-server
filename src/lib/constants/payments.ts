import type { PhisPaymentErrorCode, PhisPaymentTaxCategory } from "@phis/contracts/payments";

export const PHIS_PAYMENT_ERROR_CODES: readonly PhisPaymentErrorCode[] = [
  "invalid_input", "not_found", "forbidden", "profile_unavailable", "method_unavailable", "unsupported_operation",
  "invalid_state", "active_attempt_exists", "idempotency_conflict", "payment_declined", "provider_rejected", "provider_unavailable", "reconciliation_required",
  "customer_action_required", "stored_method_unavailable",
];

export const PHIS_PAYMENT_LEASE_SECONDS = 60;
export const PHIS_PAYMENT_CALL_TIMEOUT_MS = 15_000;
export const PHIS_PAYMENT_RECOVERY_LIMIT = 100;
export const PHIS_PAYMENT_MAX_REFUNDS = 500;
export const PHIS_PAYMENT_INSTANCE_STALE_SECONDS = 90;

export const PHIS_PAYMENT_TAX_CATEGORIES: readonly PhisPaymentTaxCategory[] = [
  "general", "reduced-goods", "digital-goods", "digital-service", "service", "shipping", "exempt",
];
export const PHIS_PAYMENT_MAX_LINE_ITEMS = 200;
export const PHIS_PAYMENT_MAX_LINE_QUANTITY = 1_000_000;
export const PHIS_PAYMENT_MAX_DISCOUNTS = 20;
export const PHIS_PAYMENT_MAX_TAX_IDS = 8;
export const PHIS_PAYMENT_MAX_PROVIDER_TAX_CODES = 8;
export const PHIS_PAYMENT_MAX_ADDITIONS = 64;
export const PHIS_PAYMENT_TEXT_LENGTH = 200;
