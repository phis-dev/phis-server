/**
 * `phis.products.flags` (DB.md).
 *
 * `Counted`: holding it has a quantity that adds up. `Free`: acquired without a payment, so its supplier
 * may record the acquisition itself. `Released`: the Site operator released a publisher's product (set
 * from the start on the Site's own, which needs none). `SupplierOff`: withdrawn by Core because its
 * supplier was switched off, and put back when the supplier is. `AccountRequired`: can only be acquired with an account. `Declared`: the supplier's manifest
 * declares it, which is what lets Core withdraw it when a later manifest stops doing so.
 */
export const PHIS_PRODUCT_FLAG = {
  Counted: 1 << 0,
  Free: 1 << 1,
  Released: 1 << 2,
  SupplierOff: 1 << 3,
  Declared: 1 << 4,
  AccountRequired: 1 << 5,
} as const;

/** The most a product's attributes of one Add-on take, serialized as JSON (SERVER_ADDONS.md, `products:v1`). */
export const PHIS_PRODUCT_ATTRIBUTES_MAX_BYTES = 8 * 1024;

/** `phis.entitlement_sources.flags`: the source may write for every product, not only for named suppliers. */
export const PHIS_ENTITLEMENT_SOURCE_FLAG_ALL_PRODUCTS = 1 << 0;

/**
 * The most entries one listing answers (`entitlements:v1` `list`, `phis entitlement list`). A listing that
 * would hold more is refused rather than cut, so nobody reads a partial list as the whole one.
 */
export const PHIS_ENTITLEMENT_LIST_MAX = 500;
