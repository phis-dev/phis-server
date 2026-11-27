import type { Pool } from "pg";
import type { PhisBillingDocumentKind } from "@phis/contracts/billing";
import { PhisAddonInstallationFlag } from "@phis/contracts/addon";

import {
  allowPhisBillingSource, denyPhisBillingSource, listPhisBillingDocuments, listPhisBillingSources, readPhisBillingDocument, writePhisBillingDocument,
} from "../db/billing.mts";
import { retryPhisPaymentRecordTasks } from "../db/payment-records.mts";
import { closePhisBillingSeriesOf, createPhisBillingSeriesOf, editPhisBillingSeriesOf, listPhisBillingSeriesOf, previewPhisBillingSeriesOf } from "../lib/billing/series.ts";
import { PHIS_BILLING_KINDS, PhisBillingError } from "../lib/billing/validation.ts";
import { withPoolTransaction } from "../lib/db-transaction.ts";
import { readAddonDesiredState } from "./addons.mts";

type Flags = Map<string, string | boolean>;

export const PHIS_BILLING_USAGE = `Use:
  phis billing source list  --site <site key>
  phis billing source allow --site <site key> --addon <@scope/name> --kinds <invoice,credit-note,reminder,receipt,confirmation>
  phis billing source deny  --site <site key> --addon <@scope/name>
  phis billing series list    --site <site key>
  phis billing series preview --site <site key> --template <text> --reset <none|yearly>
  phis billing series add     --site <site key> --key <slug> --label <text> --template <text> --reset <none|yearly> --kinds <...> [--sources <@a/b,...>] [--replaces <series id>]
  phis billing series edit    --site <site key> --id <series id> [--label <text>] [--kinds <...>] [--sources <@a/b,...>]
  phis billing series close   --site <site key> --id <series id>
  phis billing documents list  --site <site key> [--failed] [--limit <n>]
  phis billing documents retry --site <site key> --id <document id>`;

function flag(flags: Flags, key: string) {
  const value = flags.get(key);
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing --${key}.\n${PHIS_BILLING_USAGE}`);
  return value.trim();
}

function optional(flags: Flags, key: string) {
  const value = flags.get(key);
  return typeof value === "string" ? value.trim() : undefined;
}

const list = (value: string) => [...new Set(value.split(",").map(entry => entry.trim()).filter(Boolean))];

async function site(pool: Pool, key: string) {
  const row = (await pool.query<{ id: number; key: string; time_zone: string }>("SELECT id, key, time_zone FROM phis.sites WHERE key = $1", [key])).rows[0];
  if (!row) throw new Error(`Site ${key} does not exist.`);
  return row;
}

/** The installed Add-ons whose manifest declares that they issue documents: the only ones a source or series may name. */
function issuers(root: string) {
  return readAddonDesiredState(root).addons
    .filter(addon => (addon.flags & PhisAddonInstallationFlag.Enabled) !== 0 && (addon.manifest.billing?.issues?.length ?? 0) > 0)
    .map(addon => addon.addonId);
}

/** What `phis billing ...` does, as data plus the lines to print. Refusals of `billing:v1` read as errors. */
export async function runPhisBillingCommand(root: string, pool: Pool, words: readonly string[], flags: Flags) {
  try {
    return await run(root, pool, words, flags);
  } catch (error) {
    if (error instanceof PhisBillingError) throw new Error(`${error.code}: ${error.message}`);
    throw error;
  }
}

async function run(root: string, pool: Pool, words: readonly string[], flags: Flags) {
  const selected = await site(pool, flag(flags, "site").toLowerCase());
  const [group, command] = words;

  if (group === "source") {
    if (command === "list") {
      const sources = await listPhisBillingSources(pool, selected.id);
      return { data: { site: selected.key, sources },
        lines: sources.length ? sources.map(source => `${source.addonId}  ${source.kinds.join(",")}  ${source.grantedAt}`) : [`No source may issue billing documents at ${selected.key}.`] };
    }
    const addonId = flag(flags, "addon");
    if (command === "deny") {
      const changed = await denyPhisBillingSource(pool, selected.id, addonId);
      return { data: { site: selected.key, addonId, changed }, lines: [changed ? `${addonId} issues no more documents at ${selected.key}.` : `No change: ${addonId} was not allowed.`] };
    }
    if (command !== "allow") throw new Error(PHIS_BILLING_USAGE);
    const installed = readAddonDesiredState(root).addons.find(addon => addon.addonId === addonId);
    if (!installed) throw new Error(`${addonId} is not an installed Add-on.`);
    const kinds = list(flag(flags, "kinds"));
    if (kinds.some(kind => !PHIS_BILLING_KINDS.includes(kind as PhisBillingDocumentKind))) throw new Error(`--kinds is a list of ${PHIS_BILLING_KINDS.join(", ")}.`);
    // What the operator allows is at most what the manifest says it issues, which is what the operator was shown.
    const declared = installed.manifest.billing?.issues ?? [];
    const undeclared = kinds.filter(kind => !declared.includes(kind as PhisBillingDocumentKind));
    if (undeclared.length) throw new Error(`${addonId} does not declare that it issues ${undeclared.join(", ")} (billing.issues: ${declared.join(", ") || "none"}).`);
    await allowPhisBillingSource(pool, selected.id, addonId, kinds as PhisBillingDocumentKind[]);
    return { data: { site: selected.key, addonId, kinds }, lines: [`${addonId} may issue ${kinds.join(", ")} at ${selected.key}.`] };
  }

  if (group === "series") {
    const timeZone = selected.time_zone;
    const describe = (series: Awaited<ReturnType<typeof listPhisBillingSeriesOf>>[number]) =>
      `${series.id}  ${series.key}  ${series.template} (${series.reset})  next ${series.next}  ${series.kinds.join(",")}  sources ${series.sources.join(",") || "-"}`
      + `${series.closedAt ? `  closed ${series.closedAt}` : ""}  ${series.label}`;
    if (command === "list") {
      const series = await listPhisBillingSeriesOf(pool, selected.id, timeZone);
      return { data: { site: selected.key, series }, lines: series.length ? series.map(describe) : [`${selected.key} has no number series.`] };
    }
    if (command === "preview") {
      const preview = await previewPhisBillingSeriesOf(pool, selected.id, timeZone, { template: flag(flags, "template"), reset: flag(flags, "reset") });
      return { data: { site: selected.key, ...preview }, lines: [`next ${preview.next}`] };
    }
    if (command === "add") {
      const series = await createPhisBillingSeriesOf(pool, selected.id, timeZone, {
        key: flag(flags, "key"), label: flag(flags, "label"), template: flag(flags, "template"), reset: flag(flags, "reset"), kinds: list(flag(flags, "kinds")),
        sources: optional(flags, "sources") === undefined ? [] : list(optional(flags, "sources")!), replaces: optional(flags, "replaces"),
      }, issuers(root));
      return { data: { site: selected.key, series }, lines: [`Added: ${describe(series)}`] };
    }
    if (command === "edit") {
      const series = await editPhisBillingSeriesOf(pool, selected.id, timeZone, flag(flags, "id"), {
        label: optional(flags, "label"), kinds: optional(flags, "kinds") === undefined ? undefined : list(optional(flags, "kinds")!),
        sources: optional(flags, "sources") === undefined ? undefined : list(optional(flags, "sources")!),
      }, issuers(root));
      if (!series) throw new Error("No such series.");
      return { data: { site: selected.key, series }, lines: [`Changed: ${describe(series)}`] };
    }
    if (command === "close") {
      const series = await closePhisBillingSeriesOf(pool, selected.id, timeZone, flag(flags, "id"));
      if (!series) throw new Error("No such series.");
      return { data: { site: selected.key, series }, lines: [`Closed: ${describe(series)}`] };
    }
    throw new Error(PHIS_BILLING_USAGE);
  }

  if (group === "documents") {
    if (command === "list") {
      const limit = optional(flags, "limit") === undefined ? 50 : Number(optional(flags, "limit"));
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("--limit is 1 to 100.");
      const page = await listPhisBillingDocuments(pool, { siteId: selected.id, statuses: flags.get("failed") === true ? ["failed"] : null }, { cursor: null, limit });
      const documents = page.documents.map(document => document.record);
      return { data: { site: selected.key, documents },
        lines: documents.length ? documents.map(document => `${document.id}  ${document.issuedAt}  ${document.kind}  ${document.number ?? "-"}  ${document.status}`
          + `  ${document.issuer.name}  ${document.total.currency} ${document.total.minor}  ${document.reference}  ${document.label}`) : ["No documents."] };
    }
    if (command === "retry") {
      const id = flag(flags, "id");
      const document = await withPoolTransaction(pool, async db => {
        const current = await readPhisBillingDocument(db, selected.id, id, true);
        if (!current) throw new Error("No such document.");
        if (current.record.source.kind !== "provider" || current.record.status !== "failed" || !current.record.payment) {
          throw new Error("Only a Provider's document whose fetching was given up is retried.");
        }
        // The event is owed to the source and the seller; the server's job delivers it. The CLI writes none of it, the job re-records it.
        current.record.status = "pending"; current.record.version += 1;
        await writePhisBillingDocument(db, current);
        await retryPhisPaymentRecordTasks(db, selected.id, current.record.payment.paymentId, "documents");
        return current.record;
      });
      return { data: { site: selected.key, document }, lines: [`${document.id} is pending again; payments.records.collect asks the Provider at its next run.`] };
    }
  }
  throw new Error(PHIS_BILLING_USAGE);
}
