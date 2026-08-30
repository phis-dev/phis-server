"use client";

import type { ReactNode } from "react";
import { useState } from "react";

import { useMenuNavigation } from "./use-menu-navigation";

type SelectMenuOption = {
  value: string;
  label: string;
};

export function SelectMenu({
  label,
  labelAddon,
  value,
  options,
  onChange,
  buttonClassName,
  rootClassName,
}: {
  label: string;
  labelAddon?: ReactNode;
  value: string;
  options: SelectMenuOption[];
  onChange: (value: string) => void;
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
  const selectedOption =
    options.find((option) => option.value === value) ?? options[0];
  const hasLabelRow = Boolean(label) || Boolean(labelAddon);
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
    getInitialFocusIndex: () =>
      Math.max(
        options.findIndex((option) => option.value === value),
        0,
      ),
    onActivate: (index) => {
      const optionValue = options[index]?.value;
      if (optionValue && optionValue !== value) {
        onChange(optionValue);
      }
    },
  });

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
        <span>{selectedOption?.label ?? value}</span>
        <span className="ui_menu_chevron" aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="ui_menu_popover ui_surface_popover"
          role="listbox"
          aria-label={label || selectedOption?.label || "Select option"}
        >
          {options.map((option, index) => {
            const selected = option.value === value;

            return (
              <button
                key={option.value}
                ref={(element) => setOptionRef(index, element)}
                type="button"
                className="ui_menu_option"
                data-selected={selected ? "true" : "false"}
                onClick={() => handleOptionClick(index)}
                onKeyDown={(event) => handleOptionKeyDown(event, index)}
              >
                <span>{option.label}</span>
                {selected ? (
                  <span className="ui_menu_check" aria-hidden="true">
                    ✓
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
