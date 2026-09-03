import "server-only";

import { getSiteConfigBySiteId } from "@/db/site-config";
import { getPhisConfigSync } from "@/lib/config";

export async function getFormGuardSecret(siteId: number) {
  const siteConfig = await getSiteConfigBySiteId(siteId);
  if (!siteConfig) {
    throw new Error(`Missing site config for site_id=${String(siteId)}`);
  }
  return siteConfig.formGuardSecret;
}

export function getFormTimingWindow(form: string) {
  void form;
  const config = getPhisConfigSync();
  const timing = config.forms?.timeouts;
  const minAgeMs = Number(timing?.minSubmitMs ?? 2000);
  const maxAgeMs = Number(timing?.maxSubmitMs ?? 7_200_000);

  return { minAgeMs, maxAgeMs };
}

export async function getSiteMailConfig(siteId: number) {
  const siteConfig = await getSiteConfigBySiteId(siteId);
  if (!siteConfig) {
    throw new Error(`Missing site config for site_id=${String(siteId)}`);
  }

  return siteConfig;
}
