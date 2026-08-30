"use client";

import type { Dispatch, KeyboardEvent as ReactKeyboardEvent, SetStateAction } from "react";
import { useEffect, useRef } from "react";

type MenuNavigationItem = {
  label: string;
  disabled?: boolean;
};

export function useMenuNavigation({
  items,
  open,
  setOpen,
  getInitialFocusIndex,
  onActivate,
  closeOnActivate = true,
}: {
  items: MenuNavigationItem[];
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  getInitialFocusIndex: () => number;
  onActivate: (index: number) => void;
  closeOnActivate?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const typeaheadRef = useRef("");
  const typeaheadTimeoutRef = useRef<number | null>(null);
  const pendingFocusIndexRef = useRef<number | null>(null);

  function clearTypeahead() {
    typeaheadRef.current = "";
    if (typeaheadTimeoutRef.current !== null) {
      window.clearTimeout(typeaheadTimeoutRef.current);
      typeaheadTimeoutRef.current = null;
    }
  }

  function scheduleTypeaheadReset() {
    if (typeaheadTimeoutRef.current !== null) {
      window.clearTimeout(typeaheadTimeoutRef.current);
    }

    typeaheadTimeoutRef.current = window.setTimeout(() => {
      typeaheadRef.current = "";
      typeaheadTimeoutRef.current = null;
    }, 700);
  }

  function focusOption(index: number) {
    requestAnimationFrame(() => {
      optionRefs.current[index]?.focus();
    });
  }

  function getFirstEnabledIndex() {
    return items.findIndex((item) => item.disabled !== true);
  }

  function getNearestEnabledIndex(preferredIndex: number) {
    if (preferredIndex >= 0 && items[preferredIndex]?.disabled !== true) {
      return preferredIndex;
    }

    return getFirstEnabledIndex();
  }

  function getNextEnabledIndex(startIndex: number, step: 1 | -1) {
    if (items.length === 0) {
      return -1;
    }

    let index = startIndex;
    for (let count = 0; count < items.length; count += 1) {
      index = (index + step + items.length) % items.length;
      if (items[index]?.disabled !== true) {
        return index;
      }
    }

    return -1;
  }

  function focusInitialOption() {
    const nextIndex = getNearestEnabledIndex(getInitialFocusIndex());
    if (nextIndex >= 0) {
      pendingFocusIndexRef.current = nextIndex;
    }
  }

  function findOptionIndexByPrefix(prefix: string) {
    const normalizedPrefix = prefix.trim().toLowerCase();
    if (!normalizedPrefix) {
      return -1;
    }

    return items.findIndex(
      (item) =>
        item.disabled !== true &&
        item.label.trim().toLowerCase().startsWith(normalizedPrefix),
    );
  }

  function handleTypeaheadInput(character: string) {
    typeaheadRef.current = `${typeaheadRef.current}${character.toLowerCase()}`;
    scheduleTypeaheadReset();

    const nextIndex = findOptionIndexByPrefix(typeaheadRef.current);
    if (nextIndex < 0) {
      return;
    }

    if (!open) {
      setOpen(true);
    }

    pendingFocusIndexRef.current = nextIndex;
  }

  function closeMenuAndReturnFocus() {
    clearTypeahead();
    setOpen(false);
    buttonRef.current?.focus();
  }

  function handleButtonClick() {
    setOpen((current) => {
      const next = !current;
      if (next) {
        focusInitialOption();
      } else {
        clearTypeahead();
      }
      return next;
    });
  }

  function handleButtonKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
      }
      focusInitialOption();
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleButtonClick();
      return;
    }

    if (
      event.key.length === 1 &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      handleTypeaheadInput(event.key);
    }
  }

  function handleOptionKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const nextIndex = getNextEnabledIndex(index, 1);
      if (nextIndex >= 0) {
        focusOption(nextIndex);
      }
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      const nextIndex = getNextEnabledIndex(index, -1);
      if (nextIndex >= 0) {
        focusOption(nextIndex);
      }
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      const nextIndex = getFirstEnabledIndex();
      if (nextIndex >= 0) {
        focusOption(nextIndex);
      }
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      const nextIndex = getNextEnabledIndex(0, -1);
      if (nextIndex >= 0) {
        focusOption(nextIndex);
      }
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeMenuAndReturnFocus();
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onActivate(index);
      if (closeOnActivate) {
        closeMenuAndReturnFocus();
      }
      return;
    }

    if (
      event.key.length === 1 &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      handleTypeaheadInput(event.key);
    }
  }

  function handleOptionClick(index: number) {
    onActivate(index);
    if (closeOnActivate) {
      closeMenuAndReturnFocus();
    }
  }

  function setOptionRef(index: number, element: HTMLButtonElement | null) {
    optionRefs.current[index] = element;
  }

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        clearTypeahead();
        setOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        clearTypeahead();
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
      clearTypeahead();
    };
  }, [setOpen]);

  useEffect(() => {
    if (!open) {
      pendingFocusIndexRef.current = null;
      return;
    }

    if (pendingFocusIndexRef.current === null) {
      return;
    }

    focusOption(pendingFocusIndexRef.current);
    pendingFocusIndexRef.current = null;
  }, [open]);

  return {
    rootRef,
    buttonRef,
    setOptionRef,
    handleButtonClick,
    handleButtonKeyDown,
    handleOptionClick,
    handleOptionKeyDown,
  };
}
