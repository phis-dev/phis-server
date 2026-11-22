import type { PhisPaymentErrorCode, PhisPaymentTaxCategory } from "@phis/contracts/payments";

export const PHIS_PAYMENT_ERROR_CODES: readonly PhisPaymentErrorCode[] = [
  "invalid_input", "not_found", "forbidden", "profile_unavailable", "method_unavailable", "unsupported_operation",
  "invalid_state", "active_attempt_exists", "idempotency_conflict", "payment_declined", "provider_rejected", "provider_unavailable", "reconciliation_required",
  "customer_action_required", "stored_method_unavailable", "rate_limited",
];

export const PHIS_PAYMENT_LEASE_SECONDS = 60;
/** How often a reconciliation repeats its observation because a notification arrived while it held the payment. */
export const PHIS_PAYMENT_KNOCK_REPEATS = 3;
export const PHIS_PAYMENT_CALL_TIMEOUT_MS = 15_000;
export const PHIS_PAYMENT_RECOVERY_LIMIT = 100;
export const PHIS_PAYMENT_MAX_REFUNDS = 500;
export const PHIS_PAYMENT_INSTANCE_STALE_SECONDS = 90;
/** How long after Core last asked the Provider about a profile a consumer may ask it again. */
export const PHIS_PAYMENT_REACH_REFRESH_SECONDS = 60;
/** The most currencies one refresh of a profile's reach asks about: one Provider probe each. */
export const PHIS_PAYMENT_REACH_MAX_CURRENCIES = 16;

export const PHIS_PAYMENT_TAX_CATEGORIES: readonly PhisPaymentTaxCategory[] = [
  "general", "reduced-goods", "digital-goods", "digital-service", "service", "shipping", "exempt",
];
export const PHIS_PAYMENT_MAX_LINE_ITEMS = 200;
export const PHIS_PAYMENT_MAX_LINE_QUANTITY = 1_000_000;
export const PHIS_PAYMENT_MAX_DISCOUNTS = 20;
export const PHIS_PAYMENT_MAX_TAX_IDS = 8;
export const PHIS_PAYMENT_MAX_PROVIDER_TAX_CODES = 8;
export const PHIS_PAYMENT_MAX_ADDITIONS = 64;
/** The latest end a method may declare for its checkout (`checkoutExpiry.maxSeconds`): 31 days. */
export const PHIS_PAYMENT_MAX_CHECKOUT_EXPIRY_SECONDS = 31 * 86_400;
export const PHIS_PAYMENT_TEXT_LENGTH = 200;
