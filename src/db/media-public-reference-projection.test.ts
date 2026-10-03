import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), getPool: vi.fn() }));

vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));

import { listPublicSiteSpaceMediaAssetsByIds } from "./media";
import { PhiMediaDeliveryPolicy, PhiMediaLifecycleStatus, PhisMediaSpaceKind } from "./media-spaces";

function pool() {
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.getPool.mockReturnValue({ query: mocks.query });
  return mocks.query;
}

/*
 * The only Asset read the internal reference resolver performs, and therefore the only one that answers
 * an unauthenticated render. Everything it must not hand out is expressed as a WHERE clause here: an
 * Asset in a User or Group Space, one that is not Ready, or one that is not publicly deliverable is
 * absent rather than reported, so a `phis:asset` reference cannot be used to probe for it.
 */
describe("The public Asset projection behind reference resolution", () => {
  it("asks only for Ready, publicly deliverable Assets of this Site's Site Space", async () => {
    const query = pool();
    await listPublicSiteSpaceMediaAssetsByIds(31, [9]);
    // A prepared statement: text and values travel together in one config.
    const { text, values } = query.mock.calls[0][0];
    expect(text).toMatch(/lifecycle_status = \$4 AND delivery_policy = \$5/u);
    expect(text).toMatch(/space_id IN \(\s*SELECT id FROM phis\.media_spaces WHERE site_id = \$1 AND kind = \$3/u);
    expect(values).toEqual([
      31,
      [9],
      PhisMediaSpaceKind.Site,
      PhiMediaLifecycleStatus.Ready,
      PhiMediaDeliveryPolicy.Public,
    ]);
  });

  it("asks once per distinct id", async () => {
    const query = pool();
    await listPublicSiteSpaceMediaAssetsByIds(31, [9, 9, 10, 9]);
    expect(query.mock.calls[0][0].values[1]).toEqual([9, 10]);
  });

  it("drops what cannot be an Asset id instead of putting it into the statement", async () => {
    const query = pool();
    await listPublicSiteSpaceMediaAssetsByIds(31, [9, 0, -3, 1.5, Number.NaN]);
    expect(query.mock.calls[0][0].values[1]).toEqual([9]);
  });

  it("asks nothing when nothing was asked for", async () => {
    const query = pool();
    await expect(listPublicSiteSpaceMediaAssetsByIds(31, [])).resolves.toEqual([]);
    await expect(listPublicSiteSpaceMediaAssetsByIds(31, [0, -1])).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
