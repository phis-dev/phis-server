import "server-only";

import type { PhisResourceLinksCapabilityV1 } from "./contract.ts";
import {
  deleteResourceLink,
  listResourceLinksByExternalId,
  getResourceLinkThreadId,
  listResourceLinks,
  resolveSubjectThreadId,
  setResourceLinkState,
  upsertResourceLink,
} from "@/db/resource-links";
import { getThreadDetail, isThreadOwnedByProvider } from "@/db/threads";

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
  /** True when nobody authenticated and no signature stood in for them -- an unverified hook. */
  unauthenticated?: boolean;
}): PhisResourceLinksCapabilityV1 {
  const { addonId, siteId, actorUserId } = input;

  /*
   * An unverified hook reaches none of this, reads included.
   *
   * A link is the record of what an Add-on may later touch without anybody behind it. Letting whoever
   * found an unsigned address read that list would hand them the map, and letting them change a state
   * on it would let them move a ticket somebody else's work depends on.
   */
  const requireBelievableCaller = (call: string) => {
    if (input.unauthenticated) {
      throw new PhisAddonResourceLinksError(
        `${addonId} called resourceLinks.${call} from an unverified hook; a hook that touches links declares how its caller can be believed.`,
      );
    }
  };

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
      requireBelievableCaller("list");
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
      requireBelievableCaller("link");
      /*
       * A link is a person's consent -- except on what the Add-on opened itself.
       *
       * Its own thread it reaches by ownership already, so a link there grants nothing new and needs
       * nobody to agree to it: a ticket opened for an issue that arrived from outside is linked to that
       * issue by the integration that opened it, as a forwarded ticket is linked by the Supporter who
       * forwarded it. Anything else still needs an actor who can see it.
       */
      const userId = actorUserId;
      if (userId == null) {
        const threadId = await resolveSubjectThreadId(siteId, linkInput.subject);
        if (threadId == null || !await isThreadOwnedByProvider(siteId, threadId, addonId)) {
          requireActor("link");
        }
      } else {
        await requireReachableSubject("link", linkInput.subject, userId);
      }
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
      requireBelievableCaller("setState");
      /*
       * The reach `unlink` asks for, for the same reason: by id, a signed-in person driving the Add-on
       * could otherwise move the state of a link on a conversation they cannot see. A run with nobody
       * behind it -- a job, an event handler -- acts on the Add-on's own authority over its links.
       */
      if (actorUserId != null) {
        const threadId = await getResourceLinkThreadId({ siteId, providerId: addonId, linkId: stateInput.linkId });
        if (threadId == null) {
          return false;
        }
        const detail = await getThreadDetail(siteId, { kind: "user", userId: actorUserId }, threadId);
        if (!detail) {
          throw new PhisAddonResourceLinksError(
            `${addonId} called resourceLinks.setState for a subject its actor cannot reach.`,
          );
        }
      }
      return setResourceLinkState({
        siteId,
        providerId: addonId,
        linkId: stateInput.linkId,
        state: stateInput.state,
      });
    },

    async unlink(linkId) {
      requireBelievableCaller("unlink");
      const userId = requireActor("unlink");
      /*
       * The same reach `link` asks for, asked of the link's own subject. Without it any signed-in
       * person driving the Add-on could remove, by id, a link somebody else made to a conversation
       * they cannot see -- withdrawing the Add-on's consent to it and emitting the removal event.
       */
      const threadId = await getResourceLinkThreadId({ siteId, providerId: addonId, linkId });
      if (threadId == null) {
        return false;
      }
      const detail = await getThreadDetail(siteId, { kind: "user", userId }, threadId);
      if (!detail) {
        throw new PhisAddonResourceLinksError(
          `${addonId} called resourceLinks.unlink for a subject its actor cannot reach.`,
        );
      }
      return deleteResourceLink({ siteId, providerId: addonId, linkId });
    },

    async listByExternalId(findInput) {
      requireBelievableCaller("listByExternalId");
      return listResourceLinksByExternalId({
        siteId,
        providerId: addonId,
        type: findInput.type,
        externalId: findInput.externalId,
      });
    },
  } satisfies PhisResourceLinksCapabilityV1);
}
