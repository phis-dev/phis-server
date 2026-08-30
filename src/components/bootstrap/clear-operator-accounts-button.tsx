"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export function ClearOperatorAccountsButton({
  label,
  pendingLabel,
  warning,
  confirmMessage,
  cancelLabel,
}: {
  label: string;
  pendingLabel: string;
  warning: string;
  confirmMessage: string;
  cancelLabel: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isPending, startTransition] = useTransition();

  function clearAccounts() {
    startTransition(async () => {
      setError(null);

      const response = await fetch("/api/setup/platform-super-users/clear", {
        method: "POST",
      });

      if (!response.ok) {
        setError("Clearing operator accounts failed.");
        return;
      }

      setShowConfirm(false);
      router.refresh();
    });
  }

  return (
    <div className="ui_notice_inline">
      <Button
        type="button"
        variant="ghost"
        onClick={() => setShowConfirm(true)}
        disabled={isPending}
      >
        {isPending ? pendingLabel : label}
      </Button>
      <p className="ui_notice_inline_text">{warning}</p>
      {error ? <p className="ui_notice_inline_error">{error}</p> : null}
      {showConfirm ? (
        <ConfirmDialog
          title={label}
          description={confirmMessage}
          cancelLabel={cancelLabel}
          confirmLabel={label}
          confirmPendingLabel={pendingLabel}
          cancelVariant="primary"
          confirmVariant="secondary"
          defaultAction="cancel"
          onClose={() => setShowConfirm(false)}
          action={async () => clearAccounts()}
        />
      ) : null}
    </div>
  );
}
