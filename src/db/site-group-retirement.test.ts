import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

/*
 * Retiring a group is not a column with a timestamp in it; the column was always there. What makes it
 * a feature is that a retired group stops granting things, everywhere at once, and that every affected
 * member's authorization revision moves. These pin the places that would otherwise drift apart --
 * a second query that forgets the filter grants exactly what the first one took away.
 */
describe("A retired group grants nothing", () => {
  it("is filtered out of the one claim projection every decision reads", async () => {
    const source = await read("src/db/site-groups.ts");
    const projection = /async function readEffectiveGroupFlagsWithDb[\s\S]*?\[siteId, userId\]/u.exec(source);
    expect(projection, "the effective-claims query stays findable").not.toBeNull();
    expect(projection![0]).toMatch(/g\.retired_at IS NULL/u);
  });

  it("keeps its key, so the row is updated rather than deleted", async () => {
    const source = await read("src/db/site-groups.ts");
    expect(source).toMatch(/SET retired_at = CASE WHEN \$3 THEN NOW\(\) ELSE NULL END/u);
    expect(source, "a group is never deleted here").not.toMatch(/DELETE FROM phis\.site_groups/u);
  });

  it("moves every affected member's authorization revision in the same transaction", async () => {
    const source = await read("src/db/site-groups.ts");
    const fn = /export async function setSiteGroupRetirement[\s\S]*?\n\}\n/u.exec(source);
    expect(fn).not.toBeNull();
    const body = fn![0];
    expect(body).toMatch(/BEGIN/u);
    expect(body).toMatch(/authorization_revision = authorization_revision \+ 1/u);
    expect(body).toMatch(/COMMIT/u);
    // The revision update sits between them, not after the commit.
    expect(body.indexOf("authorization_revision")).toBeLessThan(body.indexOf("COMMIT"));
  });

  it("only writes the state of a group this Site owns", async () => {
    const source = await read("src/db/site-groups.ts");
    const fn = /export async function setSiteGroupRetirement[\s\S]*?\n\}\n/u.exec(source)![0];
    expect(fn, "a Directory group stops being asserted at its source, not here")
      .toMatch(/provider_id = \$4/u);
  });

  it("takes no new members while retired", async () => {
    const db = await read("src/db/site-groups.ts");
    expect(db).toMatch(/g\.provider_id = \$4 AND g\.retired_at IS NULL/u);
    const route = await read("src/app/api/site/groups/route.ts");
    expect(route).toMatch(/error: "group_retired"/u);
  });

  it("disappears from Space selection without retiring the Space itself", async () => {
    const spaces = await read("src/db/media-spaces.ts");
    const occurrences = spaces.match(/retired_at IS NULL/gu) ?? [];
    // The authorized list, the membership check, materialization, and the not-yet-materialized list.
    expect(occurrences.length).toBeGreaterThanOrEqual(4);
    expect(spaces, "a Space is not deleted or flagged when its group is retired")
      .not.toMatch(/UPDATE phis\.media_spaces[\s\S]{0,120}retired/u);
  });
});

describe("The way back", () => {
  it("is Developer or Admin, because the level that would allow it is gone", async () => {
    const route = await read("src/app/api/site/groups/route.ts");
    const patch = /export async function PATCH[\s\S]*?\n\}\n/u.exec(route)![0];
    expect(patch).toMatch(/if \(!retired && !guarded\.context!\.authority\.siteWide\)/u);
    expect(patch).toMatch(/error: "reactivate_forbidden"/u);
  });

  it("lists retired groups only where they can be acted on", async () => {
    const route = await read("src/app/api/site/groups/route.ts");
    expect(route).toMatch(/includeRetired = scope === "site" &&/u);
    expect(route, "the default answer is the groups in service")
      .toMatch(/searchParams\.get\("includeRetired"\) === "1"/u);
  });
});
