"use client";

import type { ReactNode } from "react";
import { useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";

type ConfirmDialogAction = (formData: FormData) => void | Promise<void>;

export function ConfirmDialog({
  title,
  description,
  cancelLabel,
  confirmLabel,
  confirmPendingLabel,
  cancelVariant = "secondary",
  confirmVariant = "primary",
  defaultAction = "confirm",
  onClose,
  action,
  fields = {},
  children,
}: {
  title: string;
  description: ReactNode;
  cancelLabel: string;
  confirmLabel: string;
  confirmPendingLabel?: string;
  cancelVariant?: "primary" | "secondary" | "ghost";
  confirmVariant?: "primary" | "secondary" | "ghost";
  defaultAction?: "cancel" | "confirm";
  onClose: () => void;
  action: ConfirmDialogAction;
  fields?: Record<string, string | number>;
  children?: ReactNode;
}) {
  const mounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );

  useEffect(() => {
    if (!mounted) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mounted, onClose]);

  if (!mounted) {
    return null;
  }

  return createPortal(
    <div className="ui_overlay" role="presentation" onClick={onClose}>
      <div
        className="ui_dialog ui_dialog_panel ui_dialog_panel--confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ui-confirm-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ui_dialog_header">
          <p className="ui_section_title" id="ui-confirm-dialog-title">
            {title}
          </p>
          <Button
            variant="ghost"
            type="button"
            className="ui_icon_button operator-icon_button ui_dialog_close"
            aria-label={cancelLabel}
            title={cancelLabel}
            onClick={onClose}
          >
            ×
          </Button>
        </div>

        <p className="ui_section_body ui_dialog_subtitle">{description}</p>
        {children}

        <form className="ui_dialog_footer" action={action}>
          {Object.entries(fields).map(([key, value]) => (
            <input key={key} type="hidden" name={key} value={String(value)} />
          ))}
          <Button
            variant={cancelVariant}
            type="button"
            onClick={onClose}
            autoFocus={defaultAction === "cancel"}
          >
            {cancelLabel}
          </Button>
          <SubmitButton
            idleLabel={confirmLabel}
            pendingLabel={confirmPendingLabel ?? confirmLabel}
            variant={confirmVariant}
            autoFocus={defaultAction === "confirm"}
          />
        </form>
      </div>
    </div>,
    document.body,
  );
}
