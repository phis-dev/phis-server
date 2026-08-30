"use client";

import type { InputHTMLAttributes, ReactNode } from "react";

export function Checkbox({
  label,
  hint,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label: ReactNode;
  hint?: ReactNode;
}) {
  const rootClassName = className ? `ui_checkbox ${className}` : "ui_checkbox";

  return (
    <label className={rootClassName}>
      <span className="ui_checkbox_row">
        <span className="ui_checkbox_control">
          <input {...props} className="ui_checkbox_input" type="checkbox" />
          <span className="ui_checkbox_box" aria-hidden="true">
            <span className="ui_checkbox_check">✓</span>
          </span>
        </span>
        <span className="ui_checkbox_label">{label}</span>
      </span>
      {hint ? <span className="ui_checkbox_hint">{hint}</span> : null}
    </label>
  );
}
