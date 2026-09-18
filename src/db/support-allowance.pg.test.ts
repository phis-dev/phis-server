import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PhisSupportAllowancePeriod, PhisSupportQueueFlag } from "@phis/contracts/support";
import { PhisSiteThreadKindFlag } from "@phis/contracts/threads";

import {
  closePhiTestPool,
  createPhiTestGroup,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import {
  SUPPORT_TICKET_CHANNEL_API,
  SUPPORT_TICKET_CHANNEL_PORTAL,
  createSupportQueue,
  createSupportTicket,
  createSupportTicketType,
} from "./support";
import {
  SupportAllowanceExhaustedError,
  getSupportAllowance,
  grantSupportAllowance,
  revokeSupportAllowanceGrant,
} from "./support-allowance";

const configured = process.env.PHIS_PG_TEST === "1";

const GRANTER = "@phis/pgtest-shop";

/**
 * How much one person may ask for, and who may hand them more.
 *
 * The cases that would break if the two numbers were treated as one: a stock spent before the free
 * allowance it was meant to outlast, a budget Staff can spend on somebody's behalf, a webhook retried
 * into a second ten. See design/SUPPORT.md section 5.
 */
describe.skipIf(!configured)("support allowance", () => {
  let site: PhiTestSite;
  let requester: number;
  let typeId: number;

  /** One request, opened the way the self-service route opens one. */
  async function ask(subject: string) {
    return createSupportTicket({
      siteId: site.id,
      typeId,
      subject,
      message: "Please look at this.",
      channel: SUPPORT_TICKET_CHANNEL_PORTAL,
      requesterUserId: requester,
      createdByUserId: requester,
      enforceRequesterAllowance: true,
    });
  }

  async function grantIdOf(ticketId: number) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ allowance_grant_id: number | null }>(
      `SELECT allowance_grant_id FROM phis.support_tickets WHERE id = $1`,
      [ticketId],
    );
    return rows[0]!.allowance_grant_id;
  }

  const allowanceNow = () => getSupportAllowance({
    siteId: site.id,
    userId: requester,
    typeKey: "question",
    selfServiceChannel: SUPPORT_TICKET_CHANNEL_PORTAL,
  });

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("support-allowance");
    await pool.query(
      `INSERT INTO phis.site_thread_config (site_id, flags) VALUES ($1, $2)
       ON CONFLICT (site_id) DO UPDATE SET flags = EXCLUDED.flags`,
      [site.id, PhisSiteThreadKindFlag.Support],
    );
    const groupId = await createPhiTestGroup(site, "pgtest-allowance");
    await createSupportQueue({
      siteId: site.id, groupId, key: "entry", name: "Support",
      flags: PhisSupportQueueFlag.Entry,
    });
    requester = await createPhiTestUser(site);
    typeId = await createSupportTicketType({ siteId: site.id, key: "question", name: "Question" });
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("counts nothing where the Site set no limit", async () => {
    const allowance = await allowanceNow();
    // Absent rather than a large number: "unlimited" and "very many left" are different answers.
    expect(allowance).toMatchObject({ limit: null, remaining: null, periodStart: null });
    const opened = await ask("No limit here");
    expect(await grantIdOf(opened!.ticket.id)).toBeNull();
  });

  it("refuses the one past the limit, and says what the numbers were", async () => {
    const pool = await requirePhiTestDatabase();
    await pool.query(
      `UPDATE phis.support_ticket_types
       SET requester_allowance = 2, requester_allowance_period = $2
       WHERE id = $1`,
      [typeId, PhisSupportAllowancePeriod.Year],
    );

    // One is already on the account from the test above, so one more fills the two.
    await ask("Second of two");
    expect(await allowanceNow()).toMatchObject({ limit: 2, used: 2, granted: 0, remaining: 0 });

    await expect(ask("One too many")).rejects.toThrow(SupportAllowanceExhaustedError);
    // Refused before the thread exists, so a refusal leaves no conversation nobody can reach.
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM phis.threads WHERE site_id = $1`,
      [site.id],
    );
    expect(Number(rows[0]!.count)).toBe(2);
  });

  it("neither spends the budget nor is stopped by it when Staff opens one", async () => {
    // Not the self-service channel: somebody entitled to take the decision took it.
    const opened = await createSupportTicket({
      siteId: site.id,
      typeId,
      subject: "Opened on their behalf",
      message: "Raised from a call.",
      channel: SUPPORT_TICKET_CHANNEL_API,
      requesterUserId: requester,
      createdByUserId: requester,
    });
    expect(opened).not.toBeNull();
    expect(await allowanceNow()).toMatchObject({ used: 2, remaining: 0 });
  });

  it("lets somebody else hand over more, and spends it only once the free ones are gone", async () => {
    const granted = await grantSupportAllowance({
      siteId: site.id,
      userId: requester,
      typeKey: "question",
      providerId: GRANTER,
      reference: "order-4711",
      amount: 3,
    });
    expect(granted).toMatchObject({ amount: 3, consumed: 0, typeKey: "question" });
    expect(await allowanceNow()).toMatchObject({ limit: 2, used: 2, granted: 3, remaining: 3 });

    const opened = await ask("Out of the stock");
    // The periodic allowance was already spent, so this one came out of what was handed over -- and the
    // ticket records which, so whoever sold it can say what it was spent on.
    expect(await grantIdOf(opened!.ticket.id)).toBe(granted.id);
    expect(await allowanceNow()).toMatchObject({ granted: 2, remaining: 2 });
  });

  it("answers a retried grant with the first one instead of a second stock", async () => {
    const again = await grantSupportAllowance({
      siteId: site.id,
      userId: requester,
      typeKey: "question",
      providerId: GRANTER,
      reference: "order-4711",
      // A retry carrying a different amount must not rewrite one that has already been partly spent.
      amount: 99,
    });
    expect(again).toMatchObject({ amount: 3, consumed: 1 });
    expect(await allowanceNow()).toMatchObject({ granted: 2 });
  });

  it("leaves an expired stock out of the count without deleting it", async () => {
    const pool = await requirePhiTestDatabase();
    await grantSupportAllowance({
      siteId: site.id,
      userId: requester,
      typeKey: "question",
      providerId: GRANTER,
      reference: "order-expired",
      amount: 5,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    // Still two: the five that lapsed are a record of what was sold, not headroom.
    expect(await allowanceNow()).toMatchObject({ granted: 2 });
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM phis.support_allowance_grants
       WHERE site_id = $1 AND reference = 'order-expired'`,
      [site.id],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it("stops the unspent remainder on a refund and leaves the request that was made standing", async () => {
    const revoked = await revokeSupportAllowanceGrant({
      siteId: site.id, providerId: GRANTER, reference: "order-4711",
    });
    expect(revoked).toMatchObject({ consumed: 1 });
    expect(revoked!.revokedAt).not.toBeNull();
    expect(await allowanceNow()).toMatchObject({ granted: 0, remaining: 0 });

    // The ticket it paid for is a conversation somebody is having; a payment reversed later does not
    // make it not have happened.
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM phis.support_tickets WHERE allowance_grant_id = $1`,
      [revoked!.id],
    );
    expect(Number(rows[0]!.count)).toBe(1);

    await expect(ask("Nothing left")).rejects.toThrow(SupportAllowanceExhaustedError);
  });

  it("revokes only what the Add-on granted itself", async () => {
    expect(await revokeSupportAllowanceGrant({
      siteId: site.id, providerId: "@phis/pgtest-other", reference: "order-4711",
    })).toBeNull();
  });

  it("refuses a half-written limit at the schema, in both directions", async () => {
    const pool = await requirePhiTestDatabase();
    // A period with no count limits nothing while looking as though it does. This is the direction the
    // obvious spelling of the constraint let through: `NULL >= 0` is NULL, `false OR NULL` is NULL, and
    // a CHECK that evaluates to NULL passes.
    await expect(pool.query(
      `UPDATE phis.support_ticket_types SET requester_allowance_period = 1, requester_allowance = NULL
       WHERE id = $1`,
      [typeId],
    )).rejects.toThrow(/allowance_check/);
    // And a count with no period does not say five of what.
    await expect(pool.query(
      `UPDATE phis.support_ticket_types SET requester_allowance = 5, requester_allowance_period = 0
       WHERE id = $1`,
      [typeId],
    )).rejects.toThrow(/allowance_check/);
  });
});
