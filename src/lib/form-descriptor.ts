import { isPhiRecord } from "@/lib/helpers/record";

export const PHI_FORM_DESCRIPTOR_SCHEMA_VERSION = 1 as const;

export type PhiFormDescriptor = {
  schemaVersion: typeof PHI_FORM_DESCRIPTOR_SCHEMA_VERSION;
  key: string;
  labelSetKey?: string;
  fields: readonly Record<string, unknown>[];
  actions: readonly Record<string, unknown>[];
  layout?: Record<string, unknown>;
};

function readRequiredString(value: unknown, path: string) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return normalized;
}

function readProviderKey(value: unknown, path: string) {
  const key = readRequiredString(value, path);
  if (!key.includes("/")) {
    throw new Error(`${path} must use a namespaced package/key form.`);
  }
  return key;
}

function validateTextDescriptor(value: unknown, path: string) {
  if (!isPhiRecord(value)) {
    throw new Error(`${path} must be a Form text descriptor.`);
  }
  if (value.kind === "literal" && typeof value.value === "string") {
    return;
  }
  if (
    value.kind === "label" &&
    typeof value.key === "string" &&
    value.key.trim() &&
    typeof value.fallback === "string"
  ) {
    return;
  }
  throw new Error(`${path} is not a valid Form text descriptor.`);
}

function validateOptionalRecord(value: unknown, path: string) {
  if (value != null && !isPhiRecord(value)) {
    throw new Error(`${path} must be an object.`);
  }
}

function validateGridPlacement(value: unknown, path: string) {
  if (value == null) return;
  if (!isPhiRecord(value)) throw new Error(`${path} must be an object.`);
  const span = value.span;
  const offset = value.offset;
  const order = value.order;
  if (span != null && (!Number.isInteger(span) || Number(span) < 1 || Number(span) > 24)) {
    throw new Error(`${path}.span must be an integer from 1 to 24.`);
  }
  if (offset != null && (!Number.isInteger(offset) || Number(offset) < 0 || Number(offset) > 23)) {
    throw new Error(`${path}.offset must be an integer from 0 to 23.`);
  }
  if (order != null && !Number.isInteger(order)) {
    throw new Error(`${path}.order must be an integer.`);
  }
  if (typeof span === "number" && typeof offset === "number" && span + offset > 24) {
    throw new Error(`${path}.span plus offset must not exceed 24.`);
  }
}

function validateResponsiveGridPlacement(value: unknown, path: string) {
  if (value == null) return;
  if (!isPhiRecord(value)) throw new Error(`${path} must be an object.`);
  for (const breakpoint of ["compact", "medium", "wide"] as const) {
    validateGridPlacement(value[breakpoint], `${path}.${breakpoint}`);
  }
}

function validateLayout(value: unknown) {
  if (value == null) return;
  if (!isPhiRecord(value)) throw new Error("Form descriptor layout must be an object.");
  if (value.columns != null) {
    if (!isPhiRecord(value.columns)) throw new Error("descriptor.layout.columns must be an object.");
    for (const breakpoint of ["compact", "medium", "wide"] as const) {
      const column = value.columns[breakpoint];
      if (column != null && column !== 1 && column !== 2 && column !== 3 && column !== 4) {
        throw new Error(`descriptor.layout.columns.${breakpoint} must be 1, 2, 3, or 4.`);
      }
    }
  }
  if (value.labelPlacement != null && value.labelPlacement !== "top" && value.labelPlacement !== "side") {
    throw new Error("descriptor.layout.labelPlacement must be top or side.");
  }
  if (value.labelAlign != null && value.labelAlign !== "start" && value.labelAlign !== "end") {
    throw new Error("descriptor.layout.labelAlign must be start or end.");
  }
  if (value.actionsAlign != null && !["start", "center", "end"].includes(String(value.actionsAlign))) {
    throw new Error("descriptor.layout.actionsAlign must be start, center, or end.");
  }
  validateResponsiveGridPlacement(value.labelGrid, "descriptor.layout.labelGrid");
  validateResponsiveGridPlacement(value.controlGrid, "descriptor.layout.controlGrid");
  validateResponsiveGridPlacement(value.actionsGrid, "descriptor.layout.actionsGrid");
}

function assertUniqueKeys(items: readonly Record<string, unknown>[], path: string) {
  const keys = new Set<string>();
  for (const [index, item] of items.entries()) {
    const key = readRequiredString(item.key, `${path}[${index}].key`);
    if (keys.has(key)) {
      throw new Error(`${path} contains duplicate key "${key}".`);
    }
    keys.add(key);
  }
}

export function parsePhiFormDescriptor(value: unknown): PhiFormDescriptor {
  if (!isPhiRecord(value)) {
    throw new Error("Form descriptor must be an object.");
  }
  if (value.schemaVersion !== PHI_FORM_DESCRIPTOR_SCHEMA_VERSION) {
    throw new Error(`Form descriptor schemaVersion must be ${PHI_FORM_DESCRIPTOR_SCHEMA_VERSION}.`);
  }
  const key = readRequiredString(value.key, "descriptor.key");
  if (!Array.isArray(value.fields) || !value.fields.every(isPhiRecord)) {
    throw new Error("Form descriptor fields must be an array of objects.");
  }
  if (!Array.isArray(value.actions) || !value.actions.every(isPhiRecord)) {
    throw new Error("Form descriptor actions must be an array of objects.");
  }
  assertUniqueKeys(value.fields, "descriptor.fields");
  assertUniqueKeys(value.actions, "descriptor.actions");

  for (const [index, field] of value.fields.entries()) {
    readProviderKey(field.fieldProviderKey, `descriptor.fields[${index}].fieldProviderKey`);
    for (const textKey of ["label", "controlLabel", "description", "placeholder"] as const) {
      if (field[textKey] != null) {
        validateTextDescriptor(field[textKey], `descriptor.fields[${index}].${textKey}`);
      }
    }
    if (field.autoComplete != null && typeof field.autoComplete !== "string") {
      throw new Error(`descriptor.fields[${index}].autoComplete must be a string.`);
    }
    validateOptionalRecord(field.config, `descriptor.fields[${index}].config`);
    validateOptionalRecord(field.optionsProvider, `descriptor.fields[${index}].optionsProvider`);
    if (field.options != null) {
      if (!Array.isArray(field.options) || !field.options.every(isPhiRecord)) {
        throw new Error(`descriptor.fields[${index}].options must be an array of objects.`);
      }
      const optionValues = new Set<string>();
      for (const [optionIndex, option] of field.options.entries()) {
        const optionValue = readRequiredString(
          option.value,
          `descriptor.fields[${index}].options[${optionIndex}].value`,
        );
        if (optionValues.has(optionValue)) {
          throw new Error(`descriptor.fields[${index}].options contains duplicate value "${optionValue}".`);
        }
        optionValues.add(optionValue);
        validateTextDescriptor(option.label, `descriptor.fields[${index}].options[${optionIndex}].label`);
        if (option.description != null) {
          validateTextDescriptor(
            option.description,
            `descriptor.fields[${index}].options[${optionIndex}].description`,
          );
        }
      }
    }
    if (field.placement != null) {
      if (!isPhiRecord(field.placement)) {
        throw new Error(`descriptor.fields[${index}].placement must be an object.`);
      }
      validateResponsiveGridPlacement(field.placement.cell, `descriptor.fields[${index}].placement.cell`);
      validateResponsiveGridPlacement(field.placement.label, `descriptor.fields[${index}].placement.label`);
      validateResponsiveGridPlacement(field.placement.control, `descriptor.fields[${index}].placement.control`);
    }
    if (field.validation != null) {
      if (!Array.isArray(field.validation) || !field.validation.every(isPhiRecord)) {
        throw new Error(`descriptor.fields[${index}].validation must be an array of objects.`);
      }
      for (const [ruleIndex, rule] of field.validation.entries()) {
        readProviderKey(
          rule.providerKey,
          `descriptor.fields[${index}].validation[${ruleIndex}].providerKey`,
        );
        if (rule.message != null) {
          validateTextDescriptor(
            rule.message,
            `descriptor.fields[${index}].validation[${ruleIndex}].message`,
          );
        }
        validateOptionalRecord(
          rule.config,
          `descriptor.fields[${index}].validation[${ruleIndex}].config`,
        );
      }
    }
  }

  let submitCount = 0;
  for (const [index, action] of value.actions.entries()) {
    if (action.behavior !== "submit" && action.behavior !== "reset") {
      throw new Error(`descriptor.actions[${index}].behavior is invalid.`);
    }
    if (action.behavior === "submit") {
      submitCount += 1;
    }
    if (action.presentation != null && !["primary", "secondary", "text", "link"].includes(String(action.presentation))) {
      throw new Error(`descriptor.actions[${index}].presentation is invalid.`);
    }
    validateTextDescriptor(action.label, `descriptor.actions[${index}].label`);
    if (action.pendingLabel != null) {
      validateTextDescriptor(action.pendingLabel, `descriptor.actions[${index}].pendingLabel`);
    }
  }
  if (submitCount !== 1) {
    throw new Error("Form descriptor must declare exactly one submit action.");
  }
  if (value.labelSetKey != null) {
    readProviderKey(value.labelSetKey, "descriptor.labelSetKey");
  }
  validateLayout(value.layout);

  return {
    schemaVersion: PHI_FORM_DESCRIPTOR_SCHEMA_VERSION,
    key,
    labelSetKey: typeof value.labelSetKey === "string" ? value.labelSetKey : undefined,
    fields: value.fields,
    actions: value.actions,
    layout: isPhiRecord(value.layout) ? value.layout : undefined,
  };
}
