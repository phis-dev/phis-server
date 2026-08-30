"use client";

import type { ReactNode } from "react";
import { useMemo, useState } from "react";

import { useMenuNavigation } from "./use-menu-navigation";

type MultiSelectMenuOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export function MultiSelectMenu({
  label,
  labelAddon,
  value,
  options,
  onChange,
  placeholder = "Select",
  buttonClassName,
  rootClassName,
}: {
  label: string;
  labelAddon?: ReactNode;
  value: string[];
  options: MultiSelectMenuOption[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  buttonClassName?: string;
  rootClassName?: string;
}) {
  const resolvedRootClassName = ["ui_menu", rootClassName].filter(Boolean).join(" ");
  const resolvedButtonClassName = [
    "ui_control",
    "ui_control_pill",
    "ui_menu_button",
    buttonClassName,
  ]
    .filter(Boolean)
    .join(" ");
  const [open, setOpen] = useState(false);
  const normalizedValue = useMemo(
    () => Array.from(new Set(value.map((entry) => entry.trim().toLowerCase()).filter(Boolean))),
    [value],
  );
  const hasLabelRow = Boolean(label) || Boolean(labelAddon);

  function toggleOption(optionValue: string, disabled: boolean) {
    if (disabled) {
      return;
    }

    const selected = normalizedValue.includes(optionValue);
    const next = selected
      ? normalizedValue.filter((entry) => entry !== optionValue)
      : [...normalizedValue, optionValue];
    onChange(next);
  }
  const {
    rootRef,
    buttonRef,
    setOptionRef,
    handleButtonClick,
    handleButtonKeyDown,
    handleOptionClick,
    handleOptionKeyDown,
  } = useMenuNavigation({
    items: options,
    open,
    setOpen,
    getInitialFocusIndex: () => options.findIndex((option) => !option.disabled),
    onActivate: (index) => {
      const option = options[index];
      if (!option) {
        return;
      }
      toggleOption(option.value, option.disabled === true);
    },
    closeOnActivate: false,
  });

  const selectedLabels = options
    .filter((option) => normalizedValue.includes(option.value))
    .map((option) => option.label);

  const summary =
    selectedLabels.length === 0
      ? placeholder
      : selectedLabels.length <= 3
        ? selectedLabels.join(", ")
        : `${selectedLabels.length} selected`;

  return (
    <div className={resolvedRootClassName} ref={rootRef}>
      {hasLabelRow ? (
        <div className="ui_menu_label_row">
          {label ? <label className="ui_field_label">{label}</label> : null}
          {labelAddon}
        </div>
      ) : null}
      <button
        ref={buttonRef}
        type="button"
        className={resolvedButtonClassName}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={handleButtonClick}
        onKeyDown={handleButtonKeyDown}
      >
        <span className="ui_menu_summary">{summary}</span>
        <span className="ui_menu_chevron" aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="ui_menu_popover ui_menu_popover--multiselect ui_surface_popover"
          role="listbox"
          aria-label={label || placeholder}
        >
          {options.map((option, index) => {
            const selected = normalizedValue.includes(option.value);
            const disabled = option.disabled === true;

            return (
              <button
                key={option.value}
                ref={(element) => setOptionRef(index, element)}
                type="button"
                className="ui_menu_option ui_menu_option--multiselect"
                data-selected={selected ? "true" : "false"}
                data-disabled={disabled ? "true" : "false"}
                disabled={disabled}
                onClick={() => handleOptionClick(index)}
                onKeyDown={(event) => handleOptionKeyDown(event, index)}
              >
                <span>{option.label}</span>
                <span className="ui_menu_check ui_menu_check--checkbox" aria-hidden="true">
                  {selected ? "✓" : ""}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
