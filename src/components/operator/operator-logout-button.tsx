"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function OperatorLogoutButton({ label }: { label: string }) {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);

  async function handleClick() {
    setIsPending(true);

    try {
      await fetch("/api/operator/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });
    } finally {
      router.replace("/operator/login");
      router.refresh();
      setIsPending(false);
    }
  }

  return (
    <button
      type="button"
      className="ui_icon_button operator-header_logout"
      aria-label={label}
      title={label}
      onClick={handleClick}
      disabled={isPending}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" className="operator-header_logout-icon">
        <path
          d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M10 17l5-5-5-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M15 12H4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
