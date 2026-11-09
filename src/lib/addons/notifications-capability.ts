import "server-only";

import { createHash } from "node:crypto";

import type {
  PhisAddonOccasionDescriptor,
  PhisNotificationInput,
  PhisNotificationsCapabilityV1,
} from "./contract.ts";
import { enqueuePhiNotification } from "@/db/notifications";
import { getUserSiteMembership } from "@/db/user-site-memberships";
import { attemptPhiNotificationNow } from "@/lib/notifications/deliver";
import { PHIS_ADDON_DEDUPE_KEY_MAX_LENGTH } from "@/lib/constants/server-addons";

/**
 * Writing to a person on an Add-on's behalf.
 *
 * The call names who and what happened. Everything else -- the address, the language, the words'
 * frame, the sender, the transport, the retry -- is Core's, which is what the design in
 * `design/NOTIFICATIONS.md` asked for and what keeps an Add-on from ever composing a mail. The occasion
 * must be one the manifest declared, so its words were sealed by the digest at install; the parameters
 * must be exactly the ones it declared, so nothing is inserted that nobody named.
 *
 * A `contact` recipient is the one place an Add-on hands Core an address, and the conditions are
 * narrow: the person gave the Add-on that address for this purpose and has no account to resolve, the
 * occasion is one their own action asked for, and the locale is stated because there is no profile.
 * The address is kept on the outbox row for as long as the message is owed and is cleared with the
 * other parameters once it is settled.
 */

const ADDRESS_PATTERN = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const LOCALE_PATTERN = /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;
const TEXT_MAX_LENGTH = 2000;
const PATH_MAX_LENGTH = 1024;
const NAME_MAX_LENGTH = 200;

class PhisNotificationError extends Error {}

function refuse(message: string): never {
  throw new PhisNotificationError(message);
}

function validateParams(
  occasion: PhisAddonOccasionDescriptor,
  params: PhisNotificationInput["params"],
) {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    refuse("params must be an object.");
  }
  const declared = new Map(occasion.parameters.map((parameter) => [parameter.name, parameter.type]));
  for (const name of Object.keys(params)) {
    if (!declared.has(name)) {
      refuse(`Occasion "${occasion.name}" declares no parameter "${name}".`);
    }
  }
  const values: Record<string, string> = {};
  for (const [name, type] of declared) {
    const value = params[name];
    if (typeof value !== "string") {
      refuse(`Parameter "${name}" of occasion "${occasion.name}" is missing or not a string.`);
    }
    if (type === "path") {
      /*
       * A path, never a URL: Core builds the link on the Site's own public address, so an occasion cannot
       * put somebody else's host into a Site's outgoing mail. `//` would be read as a host by a browser,
       * which is the one spelling a relative path must not have.
       */
      if (
        !value.startsWith("/") ||
        value.startsWith("//") ||
        value.length > PATH_MAX_LENGTH ||
        /[\s\u0000-\u001f\u007f]/.test(value)
      ) {
        refuse(`Parameter "${name}" of occasion "${occasion.name}" is not a Site-relative path.`);
      }
    } else if (value.length > TEXT_MAX_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
      refuse(`Parameter "${name}" of occasion "${occasion.name}" is too long or carries control characters.`);
    }
    values[name] = value;
  }
  return values;
}

function validateLocale(locale: unknown, required: boolean) {
  if (locale === undefined || locale === null) {
    if (required) refuse("A contact recipient must state a locale.");
    return null;
  }
  if (typeof locale !== "string" || !LOCALE_PATTERN.test(locale)) {
    refuse("The recipient's locale is not a language tag.");
  }
  return locale;
}

export function buildPhisAddonNotificationsCapability(input: {
  addonId: string;
  siteId: number;
  declared: readonly PhisAddonOccasionDescriptor[];
  unauthenticated: boolean;
}): PhisNotificationsCapabilityV1 {
  const { addonId, siteId, declared, unauthenticated } = input;
  const byName = new Map(declared.map((occasion) => [occasion.name, occasion]));

  return Object.freeze({
    async notify(call) {
      if (unauthenticated) {
        refuse("An unverified hook may not write to anybody.");
      }
      if (typeof call !== "object" || call === null) {
        refuse("notify takes an object.");
      }
      const occasion = typeof call.occasion === "string" ? byName.get(call.occasion) : undefined;
      if (!occasion) {
        refuse(`${addonId} declares no occasion "${String(call.occasion)}".`);
      }
      const params = validateParams(occasion, call.params);

      const recipient = call.recipient;
      if (typeof recipient !== "object" || recipient === null) {
        refuse("notify names a recipient.");
      }

      let row: Parameters<typeof enqueuePhiNotification>[0]["recipient"];
      if (recipient.kind === "user") {
        if (!Number.isSafeInteger(recipient.userId) || recipient.userId <= 0) {
          refuse("A user recipient names a user id.");
        }
        /*
         * Checked here rather than left to the foreign key: the key would refuse with a constraint error
         * an Add-on cannot read, and the answer it needs is that this person is not on this Site.
         */
        const membership = await getUserSiteMembership(recipient.userId, siteId);
        if (!membership || !membership.enabled) {
          refuse("The user is not a member of this Site.");
        }
        row = { userId: recipient.userId, locale: validateLocale(recipient.locale, false) };
      } else if (recipient.kind === "contact") {
        if (
          typeof recipient.address !== "string" ||
          recipient.address.length > 320 ||
          !ADDRESS_PATTERN.test(recipient.address)
        ) {
          refuse("The contact's address is not an email address.");
        }
        if (recipient.name !== undefined && recipient.name !== null) {
          if (typeof recipient.name !== "string" || recipient.name.length > NAME_MAX_LENGTH) {
            refuse("The contact's name must be a short string when it is given.");
          }
        }
        row = { address: recipient.address, locale: validateLocale(recipient.locale, true)! };
      } else {
        refuse("A recipient is a user or a contact.");
      }

      let dedupeKey: string | null = null;
      if (call.dedupeKey !== undefined && call.dedupeKey !== null) {
        if (typeof call.dedupeKey !== "string" || !call.dedupeKey || call.dedupeKey.length > PHIS_ADDON_DEDUPE_KEY_MAX_LENGTH) {
          refuse("dedupeKey must be a non-empty string of at most 200 characters.");
        }
        // The key is unique within the Site across every sender, so the Add-on's is kept in its own
        // namespace by digesting it with the Add-on id -- two Add-ons choosing "order-1" do not collide.
        dedupeKey = `addon:${createHash("sha256").update(`${addonId}\u0000${call.dedupeKey}`).digest("hex")}`;
      }

      const name = recipient.kind === "contact" && recipient.name ? recipient.name : null;
      const id = await enqueuePhiNotification({
        siteId,
        occasion: occasion.name,
        recipient: row,
        providerId: addonId,
        // Every declared occasion is asked-for this release, which is why no consent is weighed here.
        flags: 0,
        params: name ? { ...params, recipientName: name } : params,
        dedupeKey,
      });

      if (id) {
        // The one attempt the writing request makes itself, as Core's own messages do. Best effort: the
        // row is the record, and what this leaves behind the drain reaches.
        await attemptPhiNotificationNow(id);
      }

      return { notificationId: id };
    },
  } satisfies PhisNotificationsCapabilityV1);
}
