import { PHI_SERVER_ADDON_ID_PATTERN } from "./schema-name.ts";

/**
 * Where Core receives the body of an Add-on asset, for a Provider that cannot take one directly.
 *
 * Core owns its route table, so the address is composed here and handed to the adapter rather than
 * assembled by it -- the same rule the Media upload plan follows.
 *
 * The Add-on and the table are in the path rather than in the token. A token that carried its own
 * location would have to be decoded before it could be trusted, and a token found by scanning every
 * asset table of every installed Add-on is a lookup that grows with the installation. Here the path
 * says where to look and the token says whether the looker may.
 */
export function phiServerAddonAssetProxyUrl(addonId: string, table: string, token: string) {
  if (!PHI_SERVER_ADDON_ID_PATTERN.test(addonId)) {
    throw new Error(`"${addonId}" is not a valid Add-on id.`);
  }
  const [scope, name] = addonId.slice(1).split("/");
  return `/api/v1/addon-assets/${scope}/${name}/${encodeURIComponent(table)}/${token}`;
}
