export const PHIS_ADDON_FLAG_GLOBALLY_ENABLED = 1 << 0;

export const PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED = 1 << 0;

export const PHIS_INSTANCE_FLAG_READY = 1 << 0;

/**
 * The longest key an Add-on may give `notify` or `emit` to say a thing once (SERVER_ADDONS.md). One
 * number for both, because both write the same promise into their outboxes.
 */
export const PHIS_ADDON_DEDUPE_KEY_MAX_LENGTH = 200;
