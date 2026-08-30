import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost";

function buildButtonClassName(
  variant: ButtonVariant,
  className: string | undefined,
) {
  const baseClassName = `ui_button ui_control ui_control_pill ui_button-${variant}`;
  return className ? `${baseClassName} ${className}` : baseClassName;
}

export function Button({
  variant = "primary",
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  children: ReactNode;
}) {
  return (
    <button
      {...props}
      className={buildButtonClassName(variant, className)}
    >
      <span className="ui_button_label">{children}</span>
    </button>
  );
}
