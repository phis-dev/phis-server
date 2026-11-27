import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PhisPaymentPricing, PhisPaymentProviderCommand, PhisPaymentProviderExecution } from "@phis/contracts/payments";
import { PhisPaymentEngine } from "@/lib/payments/engine";
import { findPhiCoreJob } from "@/lib/jobs/core-jobs";
import { reconcilePhisPayments } from "@/lib/payments/recovery";
import { reconcileUnresolvedPhisPayments } from "@/lib/payments/runtime";
import { withPoolTransaction } from "@/lib/db-transaction";
import {
  claimPhisPayment, readPhisPayment, readPhisPaymentProfile, recordPhisPaymentProfileFeatures, setPhisPaymentProfileEnabled,
  writePhisPaymentProfile,
} from "./payments.mts";
import { closePhiTestPool, createPhiTestSite, dropPhiTestSites, requirePhiTestDatabase, type PhiTestSite } from "../../test/pg/harness";
import { StoringProvider } from "../../test/pg/payment-storing-provider";

const providerBinding = vi.hoisted(() => ({ addonId: "@pgtest/recover-provider", factory: null as null | (() => unknown) }));
vi.mock("@/lib/addons/services.ts", () => ({ resolvePhisServiceProvider: async () => ({ addonId: providerBinding.addonId, factory: providerBinding.factory }) }));
vi.mock("@/lib/addons/event-trigger.ts", () => ({ schedulePhisAddonEventDelivery: vi.fn() }));
const CONSUMER = "@pgtest/recover-consumer";
const FINAL: PhisPaymentPricing = { basis: "final", tax: "none" };

/** The Provider as the reconciliation meets it: every command it is sent is counted, and a question can be held. */
class CountingProvider extends StoringProvider {
  executes = 0;
  observes = 0;
  observePause: Promise<void> | null = null;
  observeEntered: (() => void) | null = null;
  override async execute(command: PhisPaymentProviderCommand): Promise<PhisPaymentProviderExecution> {
    this.executes += 1;
    return super.execute(command);
  }
  override async observe(input: Parameters<StoringProvider["observe"]>[0]) {
    this.observes += 1;
    const answer = await super.observe(input);
    this.observeEntered?.();
    if (this.observePause) await this.observePause;
    return answer;
  }
}

/**
 * The reconciliation that runs hourly on the server and on demand through `phis maintain`.
 *
 * It asks the Provider how things stand and writes that down. What these tests settle is that it can run
 * twice -- a job whose lease ran out and was taken over, the CLI beside the job -- without a second
 * financial command and without a run that counts as failed because a payment was held.
 */
describe("payment reconciliation as a job", () => {
  let site: PhiTestSite;
  const remote = new CountingProvider();

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("recover");
    providerBinding.factory = () => remote;
    for (const addon of [providerBinding.addonId, CONSUMER]) await pool.query(`INSERT INTO phis.server_addons
      (addon_id, package_name, package_version, server_abi, manifest_digest, release_build_id)
      VALUES ($1, $1, '0.1.0', '^1', repeat('0', 64), 'pgtest') ON CONFLICT (addon_id) DO NOTHING`, [addon]);
    const policy = { roles: [], jobs: [], events: [] };
    const profile = await writePhisPaymentProfile(pool, site.id, providerBinding.addonId, {
      key: "sandbox", providerKey: "@pgtest/recover-provider/test", mode: "test", credentialReferences: {}, grants: [
        { consumerAddonId: CONSUMER, operations: ["read", "create", "refresh"], merchantActions: { capture: policy, cancel: policy, refund: policy } },
      ],
    }, false);
    await recordPhisPaymentProfileFeatures(pool, profile, "acct_stored", "test", "CHF", []);
    await setPhisPaymentProfileEnabled(pool, (await readPhisPaymentProfile(pool, site.id, "sandbox"))!, true);
  });
  afterAll(async () => {
    const pool = await requirePhiTestDatabase();
    // Fixture-only teardown; the product deliberately exposes no financial purge.
    await pool.query("DELETE FROM phis.addon_event_outbox WHERE site_id = $1", [site.id]);
    await pool.query("DELETE FROM phis.payment_refunds WHERE payment_id IN (SELECT id FROM phis.payments WHERE site_id = $1)", [site.id]);
    await pool.query("DELETE FROM phis.payment_operations WHERE site_id = $1", [site.id]);
    await pool.query("DELETE FROM phis.payments WHERE site_id = $1", [site.id]);
    await pool.query("DELETE FROM phis.payment_profiles WHERE site_id = $1", [site.id]);
    for (const addon of [providerBinding.addonId, CONSUMER]) await pool.query("DELETE FROM phis.server_addons WHERE addon_id = $1", [addon]);
    await dropPhiTestSites(); await closePhiTestPool();
  });
  beforeEach(() => { remote.executes = 0; remote.observes = 0; remote.observePause = null; remote.observeEntered = null; });

  async function engine() {
    return new PhisPaymentEngine({ pool: await requirePhiTestDatabase(), scope: { siteId: site.id, siteKey: site.key, consumerAddonId: CONSUMER },
      signal: new AbortController().signal, publicBaseUrl: async () => `https://${site.key}.invalid`, resolveProvider: async () => remote, merchantAuthorized: async () => false });
  }
  /** A payment the customer has paid at the Provider, and Core has not yet been told: owed an observation. */
  async function owed() {
    const pool = await requirePhiTestDatabase();
    const created = await (await engine()).create({ profileKey: "sandbox", reference: randomUUID(), idempotencyKey: randomUUID(),
      amount: { currency: "CHF", minor: "1990" }, pricing: FINAL, description: "Test purchase", captureMode: "automatic",
      methodKey: "card", checkoutKind: "redirect", returnPath: "/return" });
    const id = created.payment.id;
    remote.customerPays(id, null);
    await pool.query(`UPDATE phis.payments SET record = jsonb_set(record, '{flags}', '1') WHERE id = $1`, [id]);
    return id;
  }
  const status = async (id: string) => (await readPhisPayment(await requirePhiTestDatabase(), site.id, id))!.record.status;
  const generation = async (id: string) => (await readPhisPayment(await requirePhiTestDatabase(), site.id, id))!.generation;
  const job = () => findPhiCoreJob("payments.recover")!;

  it("is registered as an hourly Core job", () => {
    expect(job().schedule).toEqual({ every: "hourly" });
  });

  it("asks the Provider and writes down its answer, and sends no command", async () => {
    const id = await owed();
    const sent = remote.executes;

    await job().run(new AbortController().signal);

    expect(await status(id)).toBe("captured");
    expect(remote.executes).toBe(sent);
    expect(remote.charges).toHaveLength(0);
    expect(remote.observes).toBeGreaterThanOrEqual(1);
  });

  it("runs a second time -- the job taken over after its lease ran out -- without a second command or an error", async () => {
    const id = await owed();
    await job().run(new AbortController().signal);
    const sent = remote.executes;
    const settled = await status(id);

    // The run that was taken over is the same job once more, over the same rows.
    await expect(job().run(new AbortController().signal)).resolves.toBeUndefined();
    const again = await reconcileUnresolvedPhisPayments();

    expect(remote.executes).toBe(sent);
    expect(await status(id)).toBe(settled);
    expect(again.detail).toMatch(/\d+ reconciled; \d+ unavailable or concurrently claimed/);
  });

  it("skips a payment another reconciliation holds, and does not count that as the run's failure", async () => {
    const pool = await requirePhiTestDatabase();
    const held = await owed();
    const free = await owed();
    await withPoolTransaction(pool, async db => claimPhisPayment(db, (await readPhisPayment(db, site.id, held, null, true))!));
    const heldGeneration = await generation(held);
    const sent = remote.executes;

    await expect(job().run(new AbortController().signal)).resolves.toBeUndefined();

    expect(await status(free)).toBe("captured");
    expect(await status(held)).toBe("awaiting_customer");
    expect(await generation(held)).toBe(heldGeneration);
    expect(remote.executes).toBe(sent);

    // Its holder is done: the next run offers it again and settles it.
    await pool.query("UPDATE phis.payments SET lease_token = NULL, lease_until = NULL WHERE id = $1", [held]);
    await job().run(new AbortController().signal);
    expect(await status(held)).toBe("captured");
    expect(remote.executes).toBe(sent);
  });

  it("lets the CLI and the job meet on one payment: one observes, the other leaves it, neither sends a command", async () => {
    const pool = await requirePhiTestDatabase();
    const id = await owed();
    const sent = remote.executes;
    let release!: () => void;
    remote.observePause = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const asked = new Promise<void>(resolve => { entered = resolve; });
    remote.observeEntered = entered;

    // The CLI side: the shared function with a resolver of its own. It holds the payment while it waits for the Provider.
    const cli = reconcilePhisPayments({ pool, dryRun: false, resolveProvider: async () => remote });
    await asked;
    // The job side meets a held payment: skipped, the run is not an error.
    remote.observePause = null; remote.observeEntered = null;
    const server = await reconcileUnresolvedPhisPayments();
    expect(server.detail).toMatch(/0 reconciled; 1 unavailable or concurrently claimed/);
    release();
    const result = await cli;

    expect(result.cleared).toBe(1);
    expect(await status(id)).toBe("captured");
    expect(remote.executes).toBe(sent);
    expect(remote.observes).toBe(1);
  });

  it("stops between two payments when the scheduler gives up on the run", async () => {
    const id = await owed();
    const stopped = new AbortController();
    stopped.abort();

    await job().run(stopped.signal);

    expect(await status(id)).toBe("awaiting_customer");
    // Whatever is left is the next run's; clear it so the next test starts from nothing owed.
    await job().run(new AbortController().signal);
    expect(await status(id)).toBe("captured");
  });
});
