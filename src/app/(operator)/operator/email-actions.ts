"use server";

import { redirect } from "next/navigation";

import { getSiteConfigBySiteId } from "@/db/site-config";
import { getSiteByKey } from "@/db/sites";
import { getPhisConfigSync, isBootstrapEnabled } from "@/lib/config";
import { getDefaultServerPhiRoot } from "@/lib/config-files";
import type { PhiEmailTestRecord } from "@/lib/email-test-record";
import { sendPhiTestEmail } from "@/lib/email-test";
import type { PhiMailDeliveryReport } from "@/lib/email-transport";
import { getOperatorSession } from "@/lib/operator-auth";

export type OperatorTestEmailState = {
  error: string | null;
  report: PhiMailDeliveryReport | null;
  record: PhiEmailTestRecord | null;
};

/**
 * "Send test email" in the Infrastructure section: `phis email test` from the console, with the
 * configuration the server sends with (the cached one, as `sendEmail` reads it) and, for a Site, the
 * sender the notification drain gives that Site's mail. The recipient defaults to the signed-in operator.
 */
export async function sendOperatorTestEmail(
  _previous: OperatorTestEmailState,
  formData: FormData,
): Promise<OperatorTestEmailState> {
  if (isBootstrapEnabled()) {
    redirect("/setup");
  }
  const session = await getOperatorSession();
  if (!session) {
    redirect("/operator/login");
  }

  const to = String(formData.get("to") ?? "").trim() || session.email;
  const siteKey = String(formData.get("siteKey") ?? "").trim();

  try {
    let site: Parameters<typeof sendPhiTestEmail>[0]["site"] = null;
    if (siteKey) {
      const record = await getSiteByKey(siteKey);
      const siteConfig = record ? await getSiteConfigBySiteId(record.id) : null;
      if (!record || !siteConfig) {
        return { error: `Site ${siteKey} is not active or has no mail configuration.`, report: null, record: null };
      }
      site = { key: record.key, sender: { mailFrom: siteConfig.mailFrom, mailFromName: siteConfig.mailFromName } };
    }

    const result = await sendPhiTestEmail({
      root: getDefaultServerPhiRoot(),
      emailConfig: getPhisConfigSync().email,
      to,
      site,
      via: "operator",
    });
    return { error: null, report: result.report, record: result.record };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), report: null, record: null };
  }
}
