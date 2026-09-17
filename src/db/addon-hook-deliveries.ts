import "server-only";

import { getPool } from "@/lib/db";

/**
 * The record of which signed deliveries this server has already taken.
 *
 * A sender retries whenever it is unsure a delivery arrived, and the retry carries the first attempt's
 * id. Recognising it here is what keeps one webhook from becoming two messages in somebody's thread,
 * and it is done once for every Add-on rather than in each handler.
 */

/**
 * Takes the delivery, or reports that it was already taken.
 *
 * The insert is the claim. Two instances handed the same retry at the same moment both reach this
 * statement, and exactly one of them inserts a row -- which is the answer the primary key gives for
 * free and that a read followed by a write would not.
 */
export async function claimPhisAddonHookDelivery(addonId: string, deliveryId: string) {
  const { rowCount } = await getPool().query(
    `INSERT INTO phis.addon_hook_deliveries (addon_id, delivery_id)
     VALUES ($1, $2)
     ON CONFLICT (addon_id, delivery_id) DO NOTHING`,
    [addonId, deliveryId],
  );
  return (rowCount ?? 0) > 0;
}

/*
 * What removes these rows is `phis maintain`, not anything here.
 *
 * Cleanup nobody is waiting for is the operator's, and the task states its own retention window beside
 * the other ones an operator reads in a single report. A prune function here would be the second place
 * that window is written down.
 */
