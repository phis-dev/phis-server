import "server-only";

import { logRuntimeEvent } from "@/lib/log";

export function logFormAbuse(
  request: Request,
  form: "@phis/ui/modules/public/forms/contact" | "@phis/ui/modules/auth/forms/registration",
  reason: string,
  details?: Record<string, string | number | boolean | null>,
) {
  const forwardedFor = request.headers.get("x-forwarded-for");
  const realIp = request.headers.get("x-real-ip");
  const userAgent = request.headers.get("user-agent");
  const referer = request.headers.get("referer");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");

  logRuntimeEvent("warn", "form.abuse.detected", {
    message: `${form} form abuse detected.`,
    meta: {
      form,
      reason,
      ip: forwardedFor?.split(",")[0]?.trim() || realIp || null,
      userAgent: userAgent || null,
      referer: referer || null,
      host: host || null,
      ...details,
    },
  });
}
