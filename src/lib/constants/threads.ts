/*
 * The thread vocabulary itself lives in `@phis/contracts/threads`: the Site UI renders the same flags
 * this server stores, and an Add-on reads them through the ABI, so one spelling has to serve all three.
 * What stays here is what only this server needs -- the column values behind the projections, the page
 * sizes, and the one mapping from a thread's kind to the Site flag that decides whether it is offered.
 */

export {
  PhisSiteThreadKindFlag,
  PhisThreadFlag,
  PhisThreadKind,
  PhisThreadMessageFlag,
  PhisThreadParticipantFlag,
  PhisThreadStatus,
} from "@phis/contracts/threads";

import {
  PhisSiteThreadKindFlag,
  PhisThreadKind,
  type PhisThreadKindValue,
} from "@phis/contracts/threads";

/** `thread_participants.participant_kind`. */
export const PHIS_THREAD_PARTICIPANT_KIND_USER = 0;
export const PHIS_THREAD_PARTICIPANT_KIND_GROUP = 1;

/** `thread_messages.author_kind`. */
export const PHIS_THREAD_AUTHOR_KIND_USER = 0;
export const PHIS_THREAD_AUTHOR_KIND_INTEGRATION = 1;
export const PHIS_THREAD_AUTHOR_KIND_SYSTEM = 2;

/** `thread_message_refs.flags`. */
export const PHIS_THREAD_MESSAGE_REF_IMPORTED = 1;
export const PHIS_THREAD_MESSAGE_REF_EXPORTED = 2;

export const PHIS_THREAD_MESSAGE_PAGE_SIZE = 200;
export const PHIS_THREAD_MESSAGE_MAX_PAGE_SIZE = 500;

/**
 * The Site flag that decides whether a thread of this kind is offered.
 *
 * Two closed vocabularies that have to line up, mapped once: a kind nobody maps answers `0`, which
 * makes an unknown kind unavailable rather than universally available.
 */
export function siteThreadKindFlagOf(kind: PhisThreadKindValue) {
  switch (kind) {
    case PhisThreadKind.Direct:
      return PhisSiteThreadKindFlag.Direct;
    case PhisThreadKind.Group:
      return PhisSiteThreadKindFlag.Group;
    case PhisThreadKind.CrossGroup:
      return PhisSiteThreadKindFlag.CrossGroup;
    case PhisThreadKind.Support:
      return PhisSiteThreadKindFlag.Support;
    default:
      return 0;
  }
}

/**
 * How many files one message carries.
 *
 * A bound rather than a policy: what each file may weigh is `site_media_config.max_object_bytes`, one
 * number per Site. This stops one message turning into a folder, which is what a second message is for.
 */
export const PHIS_THREAD_MESSAGE_MAX_ASSETS = 10;
