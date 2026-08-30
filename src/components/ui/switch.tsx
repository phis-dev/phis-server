import type { InputHTMLAttributes } from "react";

export function Switch({
  label,
  hint,
  className,
  disabled,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label: string;
  hint?: string;
}) {
  const rootClassName = className ? `ui_switch ${className}` : "ui_switch";

  return (
    <label className={rootClassName} data-disabled={disabled ? "true" : "false"}>
      <span className="ui_switch_copy">
        <span className="ui_switch_label">{label}</span>
        {hint ? <span className="ui_switch_hint">{hint}</span> : null}
      </span>
      <span className="ui_switch_control">
        <input {...props} disabled={disabled} className="ui_switch_input" type="checkbox" />
        <span className="ui_switch_track" aria-hidden="true">
          <span className="ui_switch_thumb" />
        </span>
      </span>
    </label>
  );
}
