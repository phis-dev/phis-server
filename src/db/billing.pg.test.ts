import { randomUUID, createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PhisBillingDocumentFlag, PhisBillingNumberSeriesFlag, type PhisBillingDocumentIssueInput, type PhisBillingDocumentKind } from "@phis/contracts/billing";
import { PhisPaymentDocumentFeatureFlag, type PhisPaymentProviderDocument, type PhisPaymentProviderV1 } from "@phis/contracts/payments";

import {
  attachPhisBillingFile, closePhisBillingSeriesById, createPhisBillingSeries, detachPhisBillingDocumentsOfUser, editPhisBillingSeries,
  failPhisProviderDocuments, getPhisBillingDocumentFor, issuePhisBillingDocument, listPhisBillingDocumentsFor, listPhisBillingSeriesRecords,
  openPhisBillingDocument, phisProviderDocumentCollector, previewPhisBillingSeries, removeExpiredPhisBillingDocuments, retryPhisProviderDocument,
  setPhisBillingPaymentState, verifyPhisBillingOpen, voidIncompletePhisBillingDocuments, voidPhisBillingDocument, type PhisBillingActor,
} from "@/lib/billing/documents";
import { readPhisBillingFile } from "@/lib/billing/store";
import { PhisBillingError } from "@/lib/billing/validation";
import { getPhisConfigSync } from "@/lib/config";
import { SITE_FLAG_ACTIVE } from "@/lib/site-flags";
import { allowPhisBillingSource, readPhisBillingDocument, takePhisBillingSerial } from "./billing.mts";
import { ensureEntitlementSubject } from "./entitlements.mts";
import { readPhisPayment, readPhisPaymentProfile } from "./payments.mts";
import { deleteUserAccount } from "./user-accounts";
import { closePhiTestPool, createPhiTestSite, createPhiTestUser, dropPhiTestSites, requirePhiTestDatabase, type PhiTestSite } from "../../test/pg/harness";
import { billingContent } from "../../test/billing-fixtures";

vi.mock("@/lib/addons/event-trigger.ts", () => ({ schedulePhisAddonEventDelivery: vi.fn() }));

const ISSUER = "@pgtest/billing-issuer";
const SELLER = "@pgtest/billing-seller";
const OTHER = "@pgtest/billing-other";
const PROVIDER = "@pgtest/billing-provider";
const ALL_KINDS: PhisBillingDocumentKind[] = ["invoice", "credit-note", "reminder", "receipt", "confirmation"];
const listeners = () => [ISSUER, SELLER];
const rules = { declaredKinds: ALL_KINDS, mayIssueFor: (id: string) => id === SELLER };

const chf = (minor: string) => billingContent({
  lines: [{ description: "Line", quantity: "1", unit: null, unitMinor: minor, lineMinor: minor, taxRate: null, taxCategory: "general", servicePeriod: null }],
  totals: { net: { currency: "CHF", minor }, taxes: [], total: { currency: "CHF", minor } },
});

describe("billing:v1 documents and number series", () => {
  let site: PhiTestSite;
  let owner: number; let stranger: number; let leaving: number;
  let ownerSubject: string; let leavingSubject: string;

  const issuerActor = (): PhisBillingActor => ({ siteId: site.id, addonId: ISSUER, actorUserId: null, billingStaff: async () => false, listeners });
  const addonActor = (addonId: string, actorUserId: number | null = null, staff = false): PhisBillingActor =>
    ({ siteId: site.id, addonId, actorUserId, billingStaff: async () => staff, listeners });
  const personActor = (actorUserId: number, staff = false): PhisBillingActor =>
    ({ siteId: site.id, addonId: null, actorUserId, billingStaff: async () => staff, listeners });
  const issueInput = (overrides: Partial<PhisBillingDocumentIssueInput> = {}): PhisBillingDocumentIssueInput => ({
    kind: "invoice", series: "invoice", idempotencyKey: randomUUID(), label: "PhiVoice AI Pro, yearly", subject: ownerSubject, reference: "S100",
    issuedAt: "2026-06-01T10:00:00Z", issuer: { kind: "merchant", name: "Phisys AG", taxId: "CHE-123.456.789 MWST" }, content: billingContent() as PhisBillingDocumentIssueInput["content"],
    file: "follows", consumerAddonId: SELLER, ...overrides,
  });
  const issue = (overrides: Partial<PhisBillingDocumentIssueInput> = {}) => issuePhisBillingDocument(issuerActor(), issueInput(overrides), rules);
  const refusal = async (work: Promise<unknown>) => { try { await work; } catch (error) { return error instanceof PhisBillingError ? error.code : String(error); } return "accepted"; };

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("billing");
    // `open` addresses the Site's public origin, which only a Site that is served has.
    await pool.query("UPDATE phis.sites SET flags = flags | $2 WHERE id = $1", [site.id, SITE_FLAG_ACTIVE]);
    for (const addon of [ISSUER, SELLER, OTHER, PROVIDER]) {
      await pool.query(`INSERT INTO phis.server_addons (addon_id, package_name, package_version, server_abi, manifest_digest, release_build_id)
        VALUES ($1, $1, '0.1.0', '^1', repeat('0', 64), 'pgtest') ON CONFLICT (addon_id) DO NOTHING`, [addon]);
      await pool.query(`INSERT INTO phis.site_server_addons (site_id, addon_id, configuration_status) VALUES ($1, $2, 'ready')`, [site.id, addon]);
    }
    await allowPhisBillingSource(pool, site.id, ISSUER, ALL_KINDS);
    owner = await createPhiTestUser(site); stranger = await createPhiTestUser(site); leaving = await createPhiTestUser(site);
    ownerSubject = await ensureEntitlementSubject(pool, site.id, owner);
    await ensureEntitlementSubject(pool, site.id, stranger);
    leavingSubject = await ensureEntitlementSubject(pool, site.id, leaving);
    await createPhisBillingSeries(site.id, { key: "invoice", label: "Invoices", template: "INV-{YYYY}-{xxxx}", reset: "yearly",
      kinds: ["invoice", "credit-note", "reminder"], sources: [ISSUER] }, [ISSUER]);
  });

  afterAll(async () => {
    const pool = await requirePhiTestDatabase();
    // Fixture-only teardown; a document is otherwise removed by its retention only.
    await pool.query("DELETE FROM phis.billing_documents WHERE site_id = $1 AND corrects_id IS NOT NULL", [site.id]);
    await pool.query("DELETE FROM phis.billing_documents WHERE site_id = $1", [site.id]);
    for (const table of ["addon_event_outbox", "payment_record_tasks"]) await pool.query(`DELETE FROM phis.${table} WHERE site_id = $1`, [site.id]);
    await pool.query("DELETE FROM phis.payment_refunds WHERE payment_id IN (SELECT id FROM phis.payments WHERE site_id = $1)", [site.id]);
    await pool.query("DELETE FROM phis.payments WHERE site_id = $1", [site.id]);
    await pool.query("DELETE FROM phis.payment_profiles WHERE site_id = $1", [site.id]);
    const root = getPhisConfigSync().media?.local?.rootDir?.trim();
    if (root && path.isAbsolute(root)) {
      const dir = path.join(root, "core", "billing-documents");
      for (const entry of await readdir(dir).catch(() => [] as string[])) if (entry.startsWith("pgtest-")) await rm(path.join(dir, entry), { recursive: true, force: true });
    }
    await dropPhiTestSites();
    for (const addon of [ISSUER, SELLER, OTHER, PROVIDER]) await pool.query("DELETE FROM phis.server_addons WHERE addon_id = $1", [addon]);
    await closePhiTestPool();
  });

  describe("number series", () => {
    it("previews, refuses a second open series of a key, replaces one, and closes", async () => {
      expect(await previewPhisBillingSeries(site.id, { template: "PHI-{YY}{xxxxx}", reset: "yearly" })).toEqual({ next: `PHI-${String(new Date().getUTCFullYear() % 100)}00001` });
      expect(await refusal(previewPhisBillingSeries(site.id, { template: "PHI {x}", reset: "none" }))).toBe("invalid_input");
      const first = await createPhisBillingSeries(site.id, { key: "reminder", label: "Reminders", template: "M-{xxx}", reset: "none", kinds: ["reminder"], sources: [ISSUER] }, [ISSUER]);
      expect(first.next).toBe("M-001");
      expect(await refusal(createPhisBillingSeries(site.id, { key: "reminder", label: "Again", template: "N-{x}", reset: "none", kinds: ["reminder"] }, [ISSUER]))).toBe("invalid_state");
      expect(await refusal(createPhisBillingSeries(site.id, { key: "other", label: "X", template: "O-{x}", reset: "none", kinds: ["invoice"], sources: [OTHER] }, [ISSUER]))).toBe("invalid_input");
      const second = await createPhisBillingSeries(site.id, { key: "reminder", label: "Reminders 2", template: "MR-{xxxx}", reset: "none", kinds: ["reminder"], replaces: first.id }, [ISSUER]);
      const all = await listPhisBillingSeriesRecords(site.id);
      expect(all.find(entry => entry.id === first.id)!.flags & PhisBillingNumberSeriesFlag.Closed).toBeTruthy();
      expect(all.find(entry => entry.id === second.id)!.closedAt).toBeNull();
      const closed = await closePhisBillingSeriesById(site.id, second.id);
      expect(closed!.flags & PhisBillingNumberSeriesFlag.Closed).toBeTruthy();
      expect(await refusal(editPhisBillingSeries(site.id, second.id, { label: "Changed" }, [ISSUER]))).toBe("invalid_state");
    });

    it("lets a used series only gain kinds", async () => {
      const series = await createPhisBillingSeries(site.id, { key: "growing", label: "Growing", template: "G-{x}", reset: "none", kinds: ["invoice"], sources: [ISSUER] }, [ISSUER]);
      expect((await editPhisBillingSeries(site.id, series.id, { kinds: ["reminder"] }, [ISSUER]))!.kinds).toEqual(["reminder"]);
      await editPhisBillingSeries(site.id, series.id, { kinds: ["invoice"] }, [ISSUER]);
      await issue({ series: "growing" });
      const used = (await listPhisBillingSeriesRecords(site.id)).find(entry => entry.id === series.id)!;
      expect(used.flags & PhisBillingNumberSeriesFlag.Used).toBeTruthy();
      expect(used.next).toBe("G-2");
      expect(await refusal(editPhisBillingSeries(site.id, series.id, { kinds: ["reminder"] }, [ISSUER]))).toBe("invalid_state");
      expect((await editPhisBillingSeries(site.id, series.id, { kinds: ["invoice", "credit-note"], label: "Growing more" }, [ISSUER]))!.kinds).toEqual(["invoice", "credit-note"]);
    });
  });

  describe("issuing", () => {
    it("numbers concurrent issues without a gap, and a rolled-back serial leaves none", async () => {
      const series = await createPhisBillingSeries(site.id, { key: "burst", label: "Burst", template: "B-{xxx}", reset: "none", kinds: ["invoice"], sources: [ISSUER] }, [ISSUER]);
      const documents = await Promise.all(Array.from({ length: 20 }, () => issue({ series: "burst" })));
      expect(documents.map(document => document.number).sort()).toEqual(Array.from({ length: 20 }, (_, index) => `B-${String(index + 1).padStart(3, "0")}`));
      const pool = await requirePhiTestDatabase();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        expect(await takePhisBillingSerial(client, series.id, 0)).toBe(BigInt(21));
        await client.query("ROLLBACK");
      } finally { client.release(); }
      expect((await issue({ series: "burst" })).number).toBe("B-021");
    });

    it("counts a yearly series per issue year", async () => {
      expect((await issue({ issuedAt: "2027-01-15T10:00:00Z" })).number).toBe("INV-2027-0001");
      expect((await issue({ issuedAt: "2027-02-15T10:00:00Z" })).number).toBe("INV-2027-0002");
      const thisYear = await issue({ issuedAt: "2025-03-01T10:00:00Z" });
      expect(thisYear.number).toBe("INV-2025-0001");
      expect(thisYear.retainUntil).toBe("2036-01-01T00:00:00.000Z");
    });

    it("is idempotent on its key and refuses other content under it", async () => {
      const input = issueInput();
      const first = await issuePhisBillingDocument(issuerActor(), input, rules);
      const again = await issuePhisBillingDocument(issuerActor(), structuredClone(input), rules);
      expect(again.id).toBe(first.id);
      expect(again.number).toBe(first.number);
      expect(await refusal(issuePhisBillingDocument(issuerActor(), { ...input, label: "Other" }, rules))).toBe("idempotency_conflict");
    });

    it("refuses a source the operator did not allow, a kind the manifest does not declare, and a sale not naming it", async () => {
      expect(await refusal(issuePhisBillingDocument(addonActor(OTHER), issueInput(), rules))).toBe("forbidden");
      expect(await refusal(issuePhisBillingDocument(issuerActor(), issueInput(), { ...rules, declaredKinds: ["receipt"] }))).toBe("forbidden");
      expect(await refusal(issue({ consumerAddonId: OTHER }))).toBe("forbidden");
      expect(await refusal(issue({ series: "nope" }))).toBe("forbidden");
      expect(await refusal(issue({ kind: "receipt", series: "invoice", file: "none" }))).toBe("invalid_input");
      expect(await refusal(issue({ file: "none" }))).toBe("invalid_input");
      expect(await refusal(issue({ subject: "sub_aaaaaaaaaaaaaaaaaaaaaaaa" }))).toBe("invalid_input");
      expect(await refusal(issue({ payment: { paymentId: randomUUID(), refundId: null } }))).toBe("invalid_input");
    });

    it("issues a receipt or confirmation without a file as available, numbered by the issuer", async () => {
      const receipt = await issue({ kind: "receipt", series: undefined, number: "R-1", file: "none" });
      expect(receipt).toMatchObject({ status: "available", number: "R-1", file: null, paymentState: null });
      const confirmation = await issue({ kind: "confirmation", series: undefined, file: "none" });
      expect(confirmation).toMatchObject({ status: "available", number: null });
      expect(await refusal(issue({ kind: "receipt", series: undefined, number: "R-1", file: "none" }))).toBe("invalid_input");
    });

    it("credits an invoice up to its total, then refuses, and marks it Credited", async () => {
      const invoice = await issue();
      const credit = (minor: string) => issue({ kind: "credit-note", correctsId: invoice.id, content: chf(minor) as PhisBillingDocumentIssueInput["content"] });
      expect((await credit("2000")).number).toMatch(/^INV-2026-/u);
      expect((await readPhisBillingDocument(await requirePhiTestDatabase(), site.id, invoice.id))!.record.flags & PhisBillingDocumentFlag.Credited).toBe(0);
      await credit("1600");
      expect((await readPhisBillingDocument(await requirePhiTestDatabase(), site.id, invoice.id))!.record.flags & PhisBillingDocumentFlag.Credited).toBeTruthy();
      expect(await refusal(credit("1"))).toBe("invalid_input");
      expect(await refusal(issue({ kind: "reminder" }))).toBe("invalid_input");
      expect(await refusal(issue({ kind: "invoice", correctsId: invoice.id }))).toBe("invalid_input");
      expect((await issue({ kind: "reminder", correctsId: invoice.id })).correctsId).toBe(invoice.id);
    });
  });

  describe("the file, voiding and payment state", () => {
    it("takes the declared PDF once, refusing another size or digest", async () => {
      const invoice = await issue();
      expect(invoice.status).toBe("pending");
      const bytes = new TextEncoder().encode("%PDF-1.7 pgtest invoice");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const body = () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
      const attach = (byteSize: number, digest: string) => attachPhisBillingFile(issuerActor(), { documentId: invoice.id, contentType: "application/pdf", byteSize, sha256: digest, body: body() });
      expect(await refusal(attach(bytes.byteLength, "0".repeat(64)))).toBe("invalid_input");
      expect(await refusal(attach(bytes.byteLength + 1, sha256))).toBe("invalid_input");
      expect(await refusal(attach(bytes.byteLength - 1, sha256))).toBe("invalid_input");
      expect(await refusal(attachPhisBillingFile(addonActor(OTHER), { documentId: invoice.id, contentType: "application/pdf", byteSize: bytes.byteLength, sha256, body: body() }))).toBe("not_found");
      const available = await attach(bytes.byteLength, sha256);
      expect(available).toMatchObject({ status: "available", file: { contentType: "application/pdf", byteSize: bytes.byteLength, sha256 } });
      expect(await refusal(attach(bytes.byteLength, sha256))).toBe("invalid_state");
      const stored = await readPhisBillingDocument(await requirePhiTestDatabase(), site.id, invoice.id);
      const stream = await readPhisBillingFile(site.id, site.key, stored!.storageKey!);
      expect(Buffer.from(await new Response(stream).arrayBuffer()).toString()).toBe("%PDF-1.7 pgtest invoice");
      expect(await refusal(voidPhisBillingDocument(issuerActor(), { documentId: invoice.id, reason: "wrong" }))).toBe("invalid_state");
    });

    it("voids a pending document, keeping its number, and the job voids one left without its file", async () => {
      const pending = await issue();
      const voided = await voidPhisBillingDocument(issuerActor(), { documentId: pending.id, reason: "withdrawn" });
      expect(voided).toMatchObject({ status: "voided", number: pending.number });
      expect(voided.flags & PhisBillingDocumentFlag.Voided).toBeTruthy();
      const stale = await issue();
      const pool = await requirePhiTestDatabase();
      await pool.query("UPDATE phis.billing_documents SET created_at = NOW() - INTERVAL '25 hours' WHERE id = $1", [stale.id]);
      const fresh = await issue();
      expect(await voidIncompletePhisBillingDocuments(listeners, 1000)).toBeGreaterThanOrEqual(1);
      const after = await readPhisBillingDocument(pool, site.id, stale.id);
      expect(after!.record.status).toBe("voided");
      expect(after!.voidReason).toBe("not completed");
      expect((await readPhisBillingDocument(pool, site.id, fresh.id))!.record.status).toBe("pending");
    });

    it("records a merchant invoice's payment state, by its issuer only", async () => {
      const invoice = await issue();
      const paid = await setPhisBillingPaymentState(issuerActor(), { documentId: invoice.id, state: "paid", paidMinor: "3600", at: "2026-06-10T00:00:00Z" });
      expect(paid.paymentState).toEqual({ state: "paid", paidMinor: "3600", at: "2026-06-10T00:00:00.000Z" });
      expect(await refusal(setPhisBillingPaymentState(addonActor(SELLER), { documentId: invoice.id, state: "open", paidMinor: "0", at: "2026-06-10T00:00:00Z" }))).toBe("not_found");
      const receipt = await issue({ kind: "receipt", series: undefined, file: "none" });
      expect(await refusal(setPhisBillingPaymentState(issuerActor(), { documentId: receipt.id, state: "paid", paidMinor: "1", at: "2026-06-10T00:00:00Z" }))).toBe("invalid_state");
    });
  });

  describe("reading and opening", () => {
    it("lets a person read and open their own, staff everything, an Add-on what it issued or sold", async () => {
      const own = await issue({ kind: "confirmation", series: undefined, file: "none", reference: "S-ACCESS" });
      const listOwn = await listPhisBillingDocumentsFor(personActor(owner), { subject: ownerSubject });
      expect(listOwn.documents.some(document => document.id === own.id)).toBe(true);
      expect(await refusal(listPhisBillingDocumentsFor(personActor(stranger), { subject: ownerSubject }))).toBe("forbidden");
      expect((await listPhisBillingDocumentsFor(personActor(stranger, true), { subject: ownerSubject })).documents.length).toBeGreaterThan(0);
      expect(await getPhisBillingDocumentFor(personActor(stranger), own.id)).toBeNull();
      expect((await getPhisBillingDocumentFor(personActor(owner), own.id))!.id).toBe(own.id);
      expect((await getPhisBillingDocumentFor(addonActor(SELLER), own.id))!.id).toBe(own.id);
      expect(await getPhisBillingDocumentFor(addonActor(OTHER), own.id)).toBeNull();
      expect((await listPhisBillingDocumentsFor(addonActor(OTHER), {})).documents).toEqual([]);
      expect((await listPhisBillingDocumentsFor(addonActor(SELLER), { references: ["S-ACCESS"] })).documents.map(document => document.id)).toEqual([own.id]);
      const opened = await openPhisBillingDocument(personActor(owner), { documentId: own.id, disposition: "inline" });
      const url = new URL(opened.url);
      expect(url.pathname).toBe(`/api/site/billing-documents/${own.id}/file`);
      expect(verifyPhisBillingOpen(site.id, own.id, { d: url.searchParams.get("d"), e: url.searchParams.get("e"), s: url.searchParams.get("s") })).toBe("inline");
      expect(await refusal(openPhisBillingDocument(personActor(stranger), { documentId: own.id, disposition: "inline" }))).toBe("not_found");
      expect((await openPhisBillingDocument(personActor(stranger, true), { documentId: own.id, disposition: "attachment", ttlSeconds: 900 })).url).toContain("d=attachment");
      expect(await refusal(openPhisBillingDocument(personActor(owner), { documentId: own.id, disposition: "inline", ttlSeconds: 901 }))).toBe("invalid_input");
      expect(await refusal(openPhisBillingDocument(addonActor(SELLER), { documentId: own.id, disposition: "inline" }))).toBe("not_found");
      const pending = await issue();
      expect(await refusal(openPhisBillingDocument(personActor(owner), { documentId: pending.id, disposition: "inline" }))).toBe("invalid_state");
    });

    it("pages newest first with a cursor and filters by kind", async () => {
      const first = await listPhisBillingDocumentsFor(addonActor(ISSUER), { limit: 2 });
      expect(first.documents).toHaveLength(2);
      expect(first.cursor).not.toBeNull();
      const second = await listPhisBillingDocumentsFor(addonActor(ISSUER), { limit: 2, cursor: first.cursor });
      expect(second.documents.some(document => first.documents.some(other => other.id === document.id))).toBe(false);
      expect((await listPhisBillingDocumentsFor(addonActor(ISSUER), { kinds: ["receipt"] })).documents.every(document => document.kind === "receipt")).toBe(true);
      expect(await refusal(listPhisBillingDocumentsFor(addonActor(ISSUER), { limit: 101 }))).toBe("invalid_input");
    });

    it("owes billing-document.changed to the source and the seller that listen", async () => {
      const pool = await requirePhiTestDatabase();
      const document = await issue({ kind: "confirmation", series: undefined, file: "none", reference: "S-EVENT" });
      const { rows } = await pool.query<{ addon_id: string; subject_kind: string; payload: { documentId: string; reference: string; version: number } }>(
        "SELECT addon_id, subject_kind, payload FROM phis.addon_event_outbox WHERE site_id = $1 AND event = 'billing-document.changed' AND payload->>'documentId' = $2 ORDER BY addon_id",
        [site.id, document.id]);
      expect(rows.map(row => row.addon_id)).toEqual([ISSUER, SELLER]);
      expect(rows[0]).toMatchObject({ subject_kind: "billing-document", payload: { documentId: document.id, reference: "S-EVENT", version: 1 } });
    });
  });

  describe("detaching and retention", () => {
    it("detaches a person's documents when they are deleted, and on request", async () => {
      const pool = await requirePhiTestDatabase();
      const theirs = await issue({ kind: "confirmation", series: undefined, file: "none", subject: leavingSubject });
      await deleteUserAccount(leaving);
      const detached = await readPhisBillingDocument(pool, site.id, theirs.id);
      expect(detached!.subjectId).toBeNull();
      expect(detached!.record.subject).toBeNull();
      expect(detached!.record.flags & PhisBillingDocumentFlag.Detached).toBeTruthy();
      const mine = await issue({ kind: "confirmation", series: undefined, file: "none" });
      const client = await pool.connect();
      try { expect(await detachPhisBillingDocumentsOfUser(client, site.id, owner, listeners)).toBeGreaterThan(0); } finally { client.release(); }
      expect((await listPhisBillingDocumentsFor(personActor(owner), { subject: ownerSubject })).documents.some(document => document.id === mine.id)).toBe(false);
      expect(await getPhisBillingDocumentFor(personActor(owner), mine.id)).toBeNull();
      expect((await getPhisBillingDocumentFor(personActor(stranger, true), mine.id))!.flags & PhisBillingDocumentFlag.Detached).toBeTruthy();
    });

    it("removes a document whose retention has ended, but not an invoice a kept credit note refers to", async () => {
      const pool = await requirePhiTestDatabase();
      const old = await issue({ kind: "confirmation", series: undefined, file: "none", subject: null });
      const invoice = await issue({ subject: null });
      await issue({ kind: "credit-note", correctsId: invoice.id, subject: null, content: chf("100") as PhisBillingDocumentIssueInput["content"] });
      await pool.query("UPDATE phis.billing_documents SET retain_until = NOW() - INTERVAL '1 day' WHERE id = ANY($1::uuid[])", [[old.id, invoice.id]]);
      expect(await removeExpiredPhisBillingDocuments(1000)).toBeGreaterThanOrEqual(1);
      expect(await readPhisBillingDocument(pool, site.id, old.id)).toBeNull();
      expect(await readPhisBillingDocument(pool, site.id, invoice.id)).not.toBeNull();
    });
  });

  describe("a Site purge", () => {
    it("removes a Site's documents with it, credit notes and the invoices they correct alike", async () => {
      const pool = await requirePhiTestDatabase();
      const purged = await createPhiTestSite("billing-purge");
      await pool.query(`INSERT INTO phis.site_server_addons (site_id, addon_id, configuration_status) VALUES ($1, $2, 'ready')`, [purged.id, ISSUER]);
      await allowPhisBillingSource(pool, purged.id, ISSUER, ALL_KINDS);
      await createPhisBillingSeries(purged.id, { key: "invoice", label: "Invoices", template: "P-{x}", reset: "none", kinds: ["invoice", "credit-note"], sources: [ISSUER] }, [ISSUER]);
      const actor: PhisBillingActor = { siteId: purged.id, addonId: ISSUER, actorUserId: null, billingStaff: async () => false, listeners };
      const invoice = await issuePhisBillingDocument(actor, issueInput({ subject: null, consumerAddonId: undefined }), rules);
      await issuePhisBillingDocument(actor, issueInput({ subject: null, consumerAddonId: undefined, kind: "credit-note", correctsId: invoice.id,
        content: chf("100") as PhisBillingDocumentIssueInput["content"] }), rules);
      await pool.query("DELETE FROM phis.addon_event_outbox WHERE site_id = $1", [purged.id]);
      await pool.query("DELETE FROM phis.sites WHERE id = $1", [purged.id]);
      expect((await pool.query("SELECT 1 FROM phis.billing_documents WHERE site_id = $1", [purged.id])).rowCount).toBe(0);
    });
  });

  describe("the Provider's documents", () => {
    it("archives what is ready, asks again for what is pending, collects a refund's credit note, and fails what was given up", async () => {
      const pool = await requirePhiTestDatabase();
      await pool.query(`INSERT INTO phis.payment_profiles (site_id, key, provider_addon_id, draft, merchant_identity)
        VALUES ($1, 'docs', $2, $3::jsonb, 'acct_docs')`, [site.id, PROVIDER, JSON.stringify({ key: "docs", providerKey: `${PROVIDER}/test`, mode: "test", credentialReferences: {}, grants: [] })]);
      const paymentId = randomUUID();
      const features = { captureModes: ["automatic"], checkoutKinds: ["redirect"], flags: 0, pricing: { bases: ["final"], tax: ["none"], maxDiscounts: 0, promotionCodes: "none", flags: 0, merchantOfRecord: null },
        stored: null, checkoutExpiry: null, collection: null,
        currency: { amounts: "single", conversion: "none", conversionCurrencies: [], conversionCost: null, settlementCurrencies: [], flags: 0 },
        documents: { kinds: [
          { kind: "invoice", flags: PhisPaymentDocumentFeatureFlag.Fetchable | PhisPaymentDocumentFeatureFlag.Delayed },
          { kind: "receipt", flags: PhisPaymentDocumentFeatureFlag.Fetchable },
          { kind: "credit-note", flags: PhisPaymentDocumentFeatureFlag.Fetchable },
        ], issuer: { kind: "provider", name: "Link, LLC", taxId: null } } };
      const record = { id: paymentId, reference: "2611-DOCS", profileKey: "docs", mode: "test", amount: { currency: "CHF", minor: "1900" }, pricing: { basis: "final", tax: "none" },
        totals: null, captureMode: "automatic", status: "captured", authorizedMinor: "0", capturedMinor: "1900", refundedMinor: "500", authorizationExpiresAt: null,
        checkout: null, flags: 0, version: 3, lastObservedAt: null, initiator: "customer", storedMethodId: null, subscriptionId: null, periodIndex: null };
      await pool.query(`INSERT INTO phis.payments (id, site_id, consumer_addon_id, profile_key, provider_key, merchant_identity, profile_revision, currency_exponent,
          method_features, binding, record, document_subject, document_label)
        VALUES ($1, $2, $3, 'docs', $4, 'acct_docs', 1, 2, $5::jsonb, $6::jsonb, $7::jsonb, $8, 'Order 2611-DOCS')`,
      [paymentId, site.id, SELLER, `${PROVIDER}/test`, JSON.stringify(features), JSON.stringify({ reference: "cs_docs", data: {} }), JSON.stringify(record), ownerSubject]);
      const refundId = randomUUID();
      await pool.query(`INSERT INTO phis.payment_refunds (id, payment_id, remote_reference, binding, record) VALUES ($1, $2, 're_docs', $3::jsonb, $4::jsonb)`,
        [refundId, paymentId, JSON.stringify({ reference: "re_docs", data: {} }), JSON.stringify({ id: refundId, paymentId, amount: { currency: "CHF", minor: "500" }, additions: null, status: "succeeded" })]);

      const listed = new Map<string, PhisPaymentProviderDocument>();
      const put = (reference: string, kind: PhisPaymentProviderDocument["kind"], state: "ready" | "pending", refund: string | null = null) => listed.set(reference, {
        reference, kind, number: `${kind}-1`, issuer: { kind: "provider", name: "Link, LLC", taxId: "CHE-999" }, issuedAt: "2026-11-27T10:00:00Z",
        total: { currency: "CHF", minor: refund ? "500" : "1900" }, presentment: refund ? null : { currency: "EUR", minor: "2060" }, state, refund: refund ? { reference: refund, data: {} } : null,
      });
      put("in_1", "invoice", "pending"); put("ch_1", "receipt", "ready");
      const fetched: string[] = [];
      const provider = {
        listDocuments: async () => [...listed.values()],
        fetchDocument: async ({ reference }: { reference: string }) => {
          fetched.push(reference);
          const bytes = new TextEncoder().encode(`%PDF ${reference}`);
          return { contentType: "application/pdf" as const, byteSize: null, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
        },
      } as unknown as PhisPaymentProviderV1;
      const collect = phisProviderDocumentCollector(listeners);
      const payment = (await readPhisPayment(pool, site.id, paymentId))!;
      const profile = (await readPhisPaymentProfile(pool, site.id, "docs"))!;
      const task = (refund: string | null) => ({ id: "0", siteId: site.id, siteKey: site.key, consumerAddonId: SELLER, paymentId, refundId: refund, kind: "documents" as const,
        attempts: 0, createdAt: new Date().toISOString(), leaseToken: randomUUID() });
      const run = (refund: string | null) => collect({ task: task(refund), payment, profile, provider, signal: new AbortController().signal });

      expect(await run(null)).toBe("partial");
      expect(fetched).toEqual(["ch_1"]);
      put("in_1", "invoice", "ready");
      expect(await run(null)).toBe("done");
      expect(fetched).toEqual(["ch_1", "in_1"]);
      expect(await run(null)).toBe("done");
      expect(fetched).toHaveLength(2);
      const archived = await listPhisBillingDocumentsFor(personActor(owner, true), { paymentId });
      expect(archived.documents.map(document => [document.kind, document.status]).sort()).toEqual([["invoice", "available"], ["receipt", "available"]]);
      const invoice = archived.documents.find(document => document.kind === "invoice")!;
      expect(invoice).toMatchObject({ source: { kind: "provider", addonId: PROVIDER }, consumerAddonId: SELLER, reference: "2611-DOCS", label: "Order 2611-DOCS",
        subject: ownerSubject, presentment: { currency: "EUR", minor: "2060" }, issuer: { kind: "provider", name: "Link, LLC" } });
      const { rows } = await pool.query<{ addon_id: string }>("SELECT DISTINCT addon_id FROM phis.addon_event_outbox WHERE site_id = $1 AND payload->>'documentId' = $2", [site.id, invoice.id]);
      expect(rows.map(row => row.addon_id)).toEqual([SELLER]);

      expect(await run(refundId)).toBe("partial");
      put("cn_1", "credit-note", "pending", "re_docs");
      expect(await run(refundId)).toBe("partial");
      await failPhisProviderDocuments(site.id, paymentId, refundId, listeners);
      const failed = (await listPhisBillingDocumentsFor(personActor(owner, true), { paymentId, kinds: ["credit-note"] })).documents[0]!;
      expect(failed.status).toBe("failed");
      expect((await retryPhisProviderDocument(site.id, failed.id, listeners))!.status).toBe("pending");
      put("cn_1", "credit-note", "ready", "re_docs");
      expect(await run(refundId)).toBe("done");
      expect((await getPhisBillingDocumentFor(personActor(owner), failed.id))!.status).toBe("available");
    });
  });
});
