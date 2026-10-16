import "server-only";

import {
  PhisSupportTicketStatus,
  type PhisSupportForwardingAdapterV1,
  type PhisSupportForwardingServiceContext,
  type PhisSupportForwardResult,
  type PhisSupportLinkResult,
} from "@phis/contracts/support";

import {
  readSupportTicketForForward,
  recordSupportTicketForward,
  SupportAdministrationError,
} from "@/db/support";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";

/*
 * Handing a Support ticket's work to another system: `@phis/server/service/support-forwarding`.
 *
 * Several implementations may be installed, and a Supporter chooses one per forward -- unlike translation,
 * which an operator selects once. So nothing is configured here: a target is any installed implementation
 * that resolves for this Site and says it is usable.
 */

const PROBE_TIMEOUT_MS = 5_000;
const LINK_TIMEOUT_MS = 20_000;
const FORWARD_TIMEOUT_MS = 20_000;

export class SupportForwardError extends Error {
  constructor(
    readonly code: "unknown-target" | "unknown-reference" | "refused" | "unusable" | "failed" | "not-found" | "finished",
    message: string,
  ) {
    super(message);
  }
}

/** One implementation, built for one Site. */
type ForwardingTarget = {
  providerKey: string;
  providerId: string;
  adapter: PhisSupportForwardingAdapterV1;
};

/**
 * Where the implementations come from: the installed Add-ons in production, a list a test hands in.
 *
 * The resolver loads Add-on code and checks the registry; a test of what Core does around a forward has
 * no business doing either.
 */
export type SupportForwardingTargetSource = (site: { id: number; key: string }) => Promise<ForwardingTarget[]>;

const installedTargets: SupportForwardingTargetSource = async (site) => {
  // Imported here rather than at the top, as the other service kinds do: the resolver reaches the
  // installed manifest, the registry and the database, and most requests never forward anything.
  const { listPhisServiceProviders, resolvePhisServiceProvider } = await import("@/lib/addons/services");
  const { PHIS_SERVICE_KINDS } = await import("@/lib/addons/core-services");
  const { getPhisAddonInstalledManifest } = await import("@/lib/addons/installed");
  const { buildPhisAddonSecretsCapability } = await import("@/lib/addons/secrets-capability");
  const { buildPhisAddonSettingsCapability } = await import("@/lib/addons/settings-capability");

  const targets: ForwardingTarget[] = [];
  for (const provider of listPhisServiceProviders(PHIS_SERVICE_KINDS.supportForwarding)) {
    if (!provider.enabled || !provider.interfaceCurrent) continue;
    try {
      const resolved = await resolvePhisServiceProvider(
        PHIS_SERVICE_KINDS.supportForwarding,
        provider.providerKey,
        { siteId: site.id },
      );
      // The implementation's own configuration on this Site, read the way its hooks and jobs read it.
      const context: PhisSupportForwardingServiceContext = {
        providerId: resolved.addonId,
        siteKey: site.key,
        secrets: buildPhisAddonSecretsCapability({ addonId: resolved.addonId, siteKey: site.key }),
        settings: buildPhisAddonSettingsCapability({
          addonId: resolved.addonId,
          siteId: site.id,
          declared: getPhisAddonInstalledManifest()[resolved.addonId]?.manifest.settings ?? [],
        }),
      };
      const adapter = resolved.factory(null, context) as PhisSupportForwardingAdapterV1;
      if (
        typeof adapter?.forward !== "function"
        || typeof adapter?.probe !== "function"
        || typeof adapter?.lookup !== "function"
        || typeof adapter?.linked !== "function"
      ) {
        throw new Error(`${resolved.addonId} built something that is not a forwarding adapter.`);
      }
      targets.push({ providerKey: provider.providerKey, providerId: resolved.addonId, adapter });
    } catch (error) {
      // Not offered, and said where an operator looks: a Supporter can do nothing about it.
      logRuntimeEvent("warn", "support.forward.target_unavailable", {
        message: "A support forwarding add-on could not be used on this Site.",
        siteKey: site.key,
        error: normalizeLogThrowable(error),
        meta: { providerKey: provider.providerKey },
      });
    }
  }
  return targets;
};

let targetSource: SupportForwardingTargetSource = installedTargets;

/** For tests: answer with these implementations instead of the installed ones. Null restores them. */
export function setSupportForwardingTargetSourceForTests(source: SupportForwardingTargetSource | null) {
  targetSource = source ?? installedTargets;
}

async function probe(target: ForwardingTarget) {
  try {
    return await target.adapter.probe({ signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (error) {
    // A probe that throws has said "not usable" less clearly than it should have.
    logRuntimeEvent("warn", "support.forward.probe_failed", {
      message: "A support forwarding add-on did not answer its probe.",
      error: normalizeLogThrowable(error),
      meta: { providerKey: target.providerKey },
    });
    return null;
  }
}

/**
 * One target as a single value: the implementation and its own key for the place, `<providerKey>#<key>`.
 *
 * One value because that is what a Supporter chooses and a ticket type remembers. The provider key comes
 * first and never contains `#`; the target key is the implementation's own and is split off at the first.
 */
export function formatSupportForwardTarget(providerKey: string, key: string) {
  return `${providerKey}#${key}`;
}

function parseSupportForwardTarget(value: string) {
  const at = value.indexOf("#");
  return at <= 0 || at === value.length - 1
    ? null
    : { providerKey: value.slice(0, at), key: value.slice(at + 1) };
}

/**
 * Where this Site's tickets may go right now: every target of every implementation that resolves here and
 * answers its probe with `usable`, by the name the implementation gives it.
 */
export async function listSupportForwardTargets(site: { id: number; key: string }) {
  const implementations = await targetSource(site);
  const probed = await Promise.all(
    implementations.map(async (implementation) => ({ implementation, answer: await probe(implementation) })),
  );
  return probed.flatMap(({ implementation, answer }) =>
    answer?.usable
      ? answer.targets.map((target) => ({
        target: formatSupportForwardTarget(implementation.providerKey, target.key),
        label: target.label,
      }))
      : []);
}

function readForwardResult(value: PhisSupportForwardResult | null | undefined) {
  if (
    !value
    || !Number.isInteger(value.type)
    || typeof value.externalId !== "string"
    || !value.externalId.trim()
    || value.externalId.length > 256
  ) {
    return null;
  }
  return {
    type: value.type,
    externalId: value.externalId,
    url: typeof value.url === "string" && value.url ? value.url : null,
    state: Number.isInteger(value.state) ? value.state : null,
  };
}

/**
 * Hands one ticket's work to one implementation, and writes down what it answered.
 *
 * The implementation is asked first and Core writes afterwards, so nothing is recorded for a hand-over
 * that did not happen. The other order of failure -- the external record exists and the write after it
 * fails -- leaves a record nothing here points at; it is logged with its address so it can be linked or
 * closed by hand, which is the better of the two ways to be wrong: no ticket claims work that does not
 * exist.
 */
export async function forwardSupportTicket(input: {
  site: { id: number; key: string };
  ticketId: number;
  /** `<providerKey>#<key>`, as `listSupportForwardTargets` names it. */
  target: string;
  title: string | null;
  actorUserId: number;
}) {
  const ticket = await readSupportTicketForForward(input.site.id, input.ticketId);
  if (!ticket) {
    throw new SupportForwardError("not-found", "This Site has no such ticket.");
  }
  if (ticket.status === PhisSupportTicketStatus.Closed) {
    throw new SupportForwardError("finished", "A closed ticket has no work left to hand over.");
  }

  const chosen = parseSupportForwardTarget(input.target);
  const target = chosen
    ? (await targetSource(input.site)).find((candidate) => candidate.providerKey === chosen.providerKey)
    : undefined;
  if (!chosen || !target) {
    throw new SupportForwardError("unknown-target", "That is not somewhere this Site can forward to.");
  }
  const answer = await probe(target);
  const place = answer?.usable ? answer.targets.find((candidate) => candidate.key === chosen.key) : undefined;
  if (!place) {
    throw new SupportForwardError("unusable", "That target cannot take work right now.");
  }

  const title = input.title?.trim() || ticket.subject;
  let result: ReturnType<typeof readForwardResult>;
  try {
    result = readForwardResult(await target.adapter.forward({
      target: place.key,
      ticket: { id: ticket.id, threadId: ticket.threadId, subject: ticket.subject, typeKey: ticket.typeKey },
      task: { title },
      mirror: ticket.mirror,
      body: ticket.body,
      actor: { userId: input.actorUserId, displayName: null },
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    }));
  } catch (error) {
    logRuntimeEvent("warn", "support.forward.failed", {
      message: "A support forwarding add-on did not take the work.",
      siteKey: input.site.key,
      error: normalizeLogThrowable(error),
      meta: { target: input.target, ticketId: input.ticketId },
    });
    throw new SupportForwardError("failed", `${place.label} did not take the work.`);
  }
  if (!result) {
    throw new SupportForwardError("failed", `${place.label} answered without saying where the work went.`);
  }

  return recordHandOver({
    site: input.site,
    ticketId: input.ticketId,
    providerId: target.providerId,
    title,
    link: result,
    byUserId: input.actorUserId,
    meta: { target: input.target },
  });
}

/**
 * Writes down work that now lives elsewhere: an engineering task of the ticket, linked to the record.
 *
 * Called once the other system has answered, by forwarding and by linking alike, so a hand-over that did
 * not happen leaves nothing behind. Where the write fails after the record exists, the record is logged
 * with its address so it can be linked or closed by hand -- no ticket claims work that does not exist.
 */
async function recordHandOver(input: {
  site: { id: number; key: string };
  ticketId: number;
  providerId: string;
  title: string;
  link: NonNullable<ReturnType<typeof readForwardResult>>;
  byUserId: number;
  meta: Record<string, unknown>;
}) {
  try {
    return await recordSupportTicketForward({
      siteId: input.site.id,
      ticketId: input.ticketId,
      providerId: input.providerId,
      title: input.title,
      link: input.link,
      byUserId: input.byUserId,
    });
  } catch (error) {
    logRuntimeEvent("error", "support.forward.unrecorded", {
      message: "Work was handed to another system and could not be recorded on the ticket.",
      siteKey: input.site.key,
      error: normalizeLogThrowable(error),
      meta: { ...input.meta, ticketId: input.ticketId, externalId: input.link.externalId, url: input.link.url },
    });
    // What the write refuses -- the record is linked to something already -- is said as it is.
    if (error instanceof SupportAdministrationError) {
      throw new SupportForwardError("refused", error.message);
    }
    throw error;
  }
}

/**
 * Links a record that already exists elsewhere to the ticket, as if the ticket had forwarded it there.
 *
 * Every implementation is asked in turn, and the first that recognises the reference answers for it: a
 * Supporter pastes what they have, a URL or `owner/name#12`, and does not say whose it is. A record may be
 * the work of several tickets -- the same bug, reported twice -- and the write refuses it only where it is
 * already this ticket's.
 */
export async function linkSupportTicket(input: {
  site: { id: number; key: string };
  ticketId: number;
  reference: string;
  actorUserId: number;
}) {
  const ticket = await readSupportTicketForForward(input.site.id, input.ticketId);
  if (!ticket) {
    throw new SupportForwardError("not-found", "This Site has no such ticket.");
  }
  if (ticket.status === PhisSupportTicketStatus.Closed) {
    throw new SupportForwardError("finished", "A closed ticket has no work left to link.");
  }

  for (const implementation of await targetSource(input.site)) {
    let answer: PhisSupportLinkResult;
    try {
      answer = await implementation.adapter.lookup({
        reference: input.reference,
        signal: AbortSignal.timeout(LINK_TIMEOUT_MS),
      });
    } catch (error) {
      // One implementation failing is not an answer about the reference; the next may know it.
      logRuntimeEvent("warn", "support.link.failed", {
        message: "A support forwarding add-on could not look up a reference.",
        siteKey: input.site.key,
        error: normalizeLogThrowable(error),
        meta: { providerKey: implementation.providerKey, ticketId: input.ticketId },
      });
      continue;
    }
    if (answer?.status === "refused") {
      throw new SupportForwardError(
        "refused",
        typeof answer.reason === "string" && answer.reason ? answer.reason : "That record cannot take work.",
      );
    }
    if (answer?.status !== "linkable") continue;

    const record = readForwardResult(answer.record);
    if (!record) {
      throw new SupportForwardError("failed", "The record was found, but without saying what it is.");
    }
    const title = (typeof answer.title === "string" ? answer.title.trim() : "").slice(0, 200) || ticket.subject;
    const detail = await recordHandOver({
      site: input.site,
      ticketId: input.ticketId,
      providerId: implementation.providerId,
      title,
      link: record,
      byUserId: input.actorUserId,
      meta: { providerKey: implementation.providerKey, reference: input.reference },
    });
    // Only now is the record told, so a link the write refused leaves nothing said there. The link stands
    // whether or not the record hears of it.
    try {
      await implementation.adapter.linked({
        record,
        ticket: { id: ticket.id, threadId: ticket.threadId, subject: ticket.subject, typeKey: ticket.typeKey },
        actor: { userId: input.actorUserId, displayName: null },
        signal: AbortSignal.timeout(LINK_TIMEOUT_MS),
      });
    } catch (error) {
      logRuntimeEvent("warn", "support.link.unannounced", {
        message: "Work was linked to a ticket, and the record could not be told where from.",
        siteKey: input.site.key,
        error: normalizeLogThrowable(error),
        meta: { providerKey: implementation.providerKey, ticketId: input.ticketId, externalId: record.externalId },
      });
    }
    return detail;
  }
  throw new SupportForwardError("unknown-reference", "Nothing this Site is connected to knows that reference.");
}
