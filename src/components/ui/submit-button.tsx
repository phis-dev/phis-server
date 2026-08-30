"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "./button";

type SubmitButtonVariant = "primary" | "secondary" | "ghost";

export function SubmitButton({
  idleLabel,
  pendingLabel = "Working...",
  variant = "primary",
  className,
  disabled,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "children"> & {
  idleLabel: ReactNode;
  pendingLabel?: ReactNode;
  variant?: SubmitButtonVariant;
}) {
  const { pending } = useFormStatus();

  return (
    <Button
      {...props}
      type="submit"
      variant={variant}
      className={className}
      disabled={disabled || pending}
      aria-busy={pending}
      data-pending={pending ? "true" : "false"}
    >
      {pending ? pendingLabel : idleLabel}
    </Button>
  );
}
