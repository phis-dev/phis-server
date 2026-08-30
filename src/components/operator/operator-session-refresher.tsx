"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

const REFRESH_INTERVAL_MS = 1000 * 60 * 5;

export function OperatorSessionRefresher() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!pathname.startsWith("/operator") || pathname === "/operator/login") {
      return;
    }

    let cancelled = false;

    async function refreshSession() {
      try {
        const response = await fetch("/api/operator/auth/refresh", {
          method: "POST",
          credentials: "same-origin",
        });

        if (!response.ok && !cancelled) {
          router.refresh();
        }
      } catch {
        if (!cancelled) {
          router.refresh();
        }
      }
    }

    void refreshSession();
    const intervalId = window.setInterval(refreshSession, REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [pathname, router]);

  return null;
}
