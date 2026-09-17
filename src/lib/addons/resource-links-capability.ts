import "server-only";

import type { PhisResourceLinksCapabilityV1 } from "./contract.ts";
import {
  deleteResourceLink,
  findResourceLinkByExternalId,
  listResourceLinks,
  resolveSubjectThreadId,
  setResourceLinkState,
  upsertResourceLink,
} from "@/db/resource-links";
import { getThreadDetail } from "@/db/threads";

export class PhisAddonResourceLinksError extends Error {}

/**
 * References from a Phi record into this Add-on's own system: `@phis/server/resource-links:v1`.
 *
 * Bounded twice. The provider is closed over, so an Add-on reads and writes its own links and cannot
 * see another's. And a subject has to be one the acting user may reach, which is asked of the subject's
 * thread -- there is one answer to "may this person see this conversation", and a second one taken from
 * the ticket row would eventually disagree with it.
 *
 * **Writing needs an actor.** A link is a person saying these two things belong together, and it is
 * that statement the Add-on's later actorless reach rests on; a hook that could write its own would be
 * granting itself the access the link is supposed to confer. Reading is offered without one, because a
 * job settling what it recorded earlier has to be able to find it.
 */
export function buildPhisAddonResourceLinksCapability(input: {
  addonId: string;
  siteId: number;
  actorUserId: number | null;
}): PhisResourceLinksCapabilityV1 {
  const { addonId, siteId, actorUserId } = input;

  const requireActor = (call: string) => {
    if (actorUserId == null) {
      throw new PhisAddonResourceLinksError(
        `${addonId} called resourceLinks.${call} with no acting user; a link is a person's statement that two records belong together.`,
      );
    }
    return actorUserId;
  };

  const requireReachableSubject = async (
    call: string,
    subject: Parameters<PhisResourceLinksCapabilityV1["list"]>[0],
    userId: number,
  ) => {
    const threadId = await resolveSubjectThreadId(siteId, subject);
    if (threadId == null) {
      throw new PhisAddonResourceLinksError(
        `${addonId} called resourceLinks.${call} for a subject that is not on site ${siteId}.`,
      );
    }
    const detail = await getThreadDetail(siteId, { kind: "user", userId }, threadId);
    if (!detail) {
      throw new PhisAddonResourceLinksError(
        `${addonId} called resourceLinks.${call} for a subject its actor cannot reach.`,
      );
    }
    return threadId;
  };

  return Object.freeze({
    async list(subject) {
      if (actorUserId != null) {
        const threadId = await resolveSubjectThreadId(siteId, subject);
        if (threadId == null) {
          return [];
        }
        const detail = await getThreadDetail(siteId, { kind: "user", userId: actorUserId }, threadId);
        if (!detail) {
          return [];
        }
      }
      return listResourceLinks({ siteId, providerId: addonId, subject });
    },

    async link(linkInput) {
      const userId = requireActor("link");
      await requireReachableSubject("link", linkInput.subject, userId);
      return upsertResourceLink({
        siteId,
        providerId: addonId,
        subject: linkInput.subject,
        type: linkInput.type,
        externalId: linkInput.externalId,
        url: linkInput.url ?? null,
        state: linkInput.state ?? null,
        flags: linkInput.flags ?? 0,
        createdByUserId: userId,
      });
    },

    async setState(stateInput) {
      return setResourceLinkState({
        siteId,
        providerId: addonId,
        linkId: stateInput.linkId,
        state: stateInput.state,
      });
    },

    async unlink(linkId) {
      requireActor("unlink");
      return deleteResourceLink({ siteId, providerId: addonId, linkId });
    },

    async findByExternalId(findInput) {
      return findResourceLinkByExternalId({
        siteId,
        providerId: addonId,
        type: findInput.type,
        externalId: findInput.externalId,
      });
    },
  } satisfies PhisResourceLinksCapabilityV1);
}
