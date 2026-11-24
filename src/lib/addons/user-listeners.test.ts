import { describe, expect, it } from "vitest";

import { PHIS_CORE_CAPABILITIES } from "@phis/contracts/addon";

import { listUserListenersOf } from "./commerce-listeners.ts";

/** A person's events reach an Add-on that may read people at all, never one that merely listens. */
describe("user event listeners", () => {
  const entry = (enabled: boolean, required: string[], events: string[]) => ({
    enabled,
    manifest: { requiredCoreCapabilities: required, eventHandlers: events.map((event) => ({ id: event, event, handler: event })) },
  });

  it("are the enabled Add-ons requiring users:v1 that declare a handler for the event", () => {
    const entries = {
      "@acme/crm": entry(true, [PHIS_CORE_CAPABILITIES.users], ["user.registered", "user.changed"]),
      "@acme/listener": entry(true, [], ["user.registered"]),
      "@acme/off": entry(false, [PHIS_CORE_CAPABILITIES.users], ["user.registered"]),
      "@acme/changes": entry(true, [PHIS_CORE_CAPABILITIES.users], ["user.changed"]),
    } as never;
    expect(listUserListenersOf(entries, "user.registered")).toEqual(["@acme/crm"]);
    expect(listUserListenersOf(entries, "user.changed")).toEqual(["@acme/crm", "@acme/changes"]);
  });
});
