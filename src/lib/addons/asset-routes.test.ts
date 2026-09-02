import { describe, expect, it } from "vitest";

import { phiServerAddonAssetProxyUrl } from "./asset-routes.ts";

/**
 * Where Core receives a body it has to take itself.
 *
 * The Add-on and the table are in the path rather than in the token. A token carrying its own location
 * would have to be decoded before it could be trusted; a token found by scanning every asset table of
 * every installed Add-on is a lookup that grows with the installation. Here the path says where to look
 * and the token says whether the looker may.
 */
describe("the asset upload proxy address", () => {
  it("splits the Add-on id into the path Core routes on", () => {
    expect(phiServerAddonAssetProxyUrl("@acme/shop", "offering", "abc123"))
      .toBe("/api/v1/addon-assets/acme/shop/offering/abc123");
  });

  it("refuses to compose an address for something that is not an Add-on id", () => {
    expect(() => phiServerAddonAssetProxyUrl("acme-shop", "offering", "abc123"))
      .toThrow(/not a valid Add-on id/);
  });

  it("escapes the table rather than trusting it into a path", () => {
    expect(phiServerAddonAssetProxyUrl("@acme/shop", "a/b", "t"))
      .toBe("/api/v1/addon-assets/acme/shop/a%2Fb/t");
  });
});
