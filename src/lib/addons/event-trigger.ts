import "server-only";

/**
 * Asking for the outbox to be drained, from below the Add-on machinery.
 *
 * The thread writer is the thing that knows a commit happened, and it lives in `src/db`. The deliverer
 * needs the loaded runtime and the capability builder, which reach back into `src/db/threads` -- so an
 * import from there to the deliverer would close a cycle through five modules. The import is made when
 * the drain runs instead, which is also the only moment the Add-on machinery is wanted at all.
 *
 * Nothing waits for it and nothing sees it fail. The row is already in the outbox; this is the attempt
 * that saves a person from waiting for the next `phis addon job run`, not the one that has to succeed.
 */
export function schedulePhisAddonEventDelivery(siteId: number) {
  void (async () => {
    const { drainPhisAddonEventsForSite } = await import("./event-delivery.ts");
    await drainPhisAddonEventsForSite(siteId);
  })().catch(() => {
    // `drainPhisAddonEventsForSite` logs its own failures; what is left here is the import itself
    // failing, which would mean this build has no Add-on machinery at all.
  });
}
