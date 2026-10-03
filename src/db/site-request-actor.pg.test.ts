import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import {
  addPhiTestGroupMember,
  closePhiTestPool,
  createPhiTestGroup,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { buildSessionCookieValue, SESSION_COOKIE_NAME } from "@/lib/auth";
import { PhiGroupMembershipFlags } from "@/lib/constants/site-groups";

import { getSiteRequestActorFromRequest } from "./site-request-actor";
import { getUserAccountById } from "./user-accounts";
import { createUserSession, getSessionFromRequest } from "./user-sessions";
import { getEffectiveUserSiteAuthorization } from "./user-site-memberships";

afterAll(async () => {
  await closePhiTestPool();
});

/**
 * The request actor is the single readers' answer, read in one statement. These run both against the
 * same rows and require the same answer -- the subqueries are the readers' own SQL, but only the
 * database can show that they correlate with the session row the way the readers' parameters did.
 */
describe("getSiteRequestActorFromRequest against PostgreSQL", () => {
  let site: PhiTestSite;
  let otherSite: PhiTestSite;
  let userId: number;
  let cookie: string;

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("actor");
    otherSite = await createPhiTestSite("actor-other");
    for (const each of [site, otherSite]) {
      await pool.query(`INSERT INTO phis.site_auth_config (site_id) VALUES ($1) ON CONFLICT DO NOTHING`, [each.id]);
    }
    userId = await createPhiTestUser(site);
    await pool.query(
      `INSERT INTO phis.user_site_role_claims (user_id, site_id, provider_id, role_flags)
       VALUES ($1, $2, '@phis/server/core', 5), ($1, $2, '@pgtest/not-installed', 1)`,
      [userId, site.id],
    );
    const live = await createPhiTestGroup(site, "actor-live");
    const retired = await createPhiTestGroup(site, "actor-retired");
    const lapsed = await createPhiTestGroup(site, "actor-lapsed");
    await addPhiTestGroupMember({ site, groupId: live, userId, membershipFlags: PhiGroupMembershipFlags.Member });
    await addPhiTestGroupMember({ site, groupId: retired, userId });
    await addPhiTestGroupMember({ site, groupId: lapsed, userId, validUntilSeconds: -60 });
    await pool.query(`UPDATE phis.site_groups SET retired_at = NOW() WHERE id = $1`, [retired]);

    const session = await createUserSession({ userId, siteId: site.id, authMethodKeys: ["password"] });
    cookie = `${SESSION_COOKIE_NAME}=${buildSessionCookieValue(session.id, session.secret)}`;
  });

  afterAll(async () => {
    await dropPhiTestSites();
  });

  const request = () => new NextRequest("https://server.test/api/site/x", { headers: { cookie } });

  it("answers what the session, authorization and account readers answer", async () => {
    const actor = await getSiteRequestActorFromRequest(request(), site.id, { account: { externalSiteId: site.id } });
    const session = await getSessionFromRequest(request(), site.id);
    const authorization = await getEffectiveUserSiteAuthorization(userId, site.id);

    expect(actor).not.toBeNull();
    expect(actor!.session).toEqual(session);
    expect(actor!.siteRole).toEqual(authorization);
    expect(actor!.user).toEqual(await getUserAccountById(userId, site.id));
    // What the rows above are for: the core role counts, the uninstalled provider does not, and of the
    // three groups only the live one grants.
    expect(actor!.siteRole.coreRoleFlags).toBe(5);
    expect(actor!.siteRole.roleClaims.map((claim) => claim.providerId)).toEqual(["@phis/server/core"]);
    expect(actor!.siteRole.groupClaims.map((claim) => claim.key)).toEqual(["actor-live"]);
  });

  it("reads no account unless asked", async () => {
    expect((await getSiteRequestActorFromRequest(request(), site.id))!.user).toBeNull();
  });

  it("answers nothing for another Site, a missing cookie or a wrong secret", async () => {
    expect(await getSiteRequestActorFromRequest(request(), otherSite.id)).toBeNull();
    expect(await getSiteRequestActorFromRequest(new NextRequest("https://server.test/x"), site.id)).toBeNull();
    const forged = cookie.replace(/.$/u, (last) => (last === "a" ? "b" : "a"));
    expect(await getSiteRequestActorFromRequest(
      new NextRequest("https://server.test/x", { headers: { cookie: forged } }),
      site.id,
    )).toBeNull();
  });
});
