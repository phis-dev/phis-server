/** Whether a value is a string with something other than whitespace in it. */
export function isPhiNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * A required string field of stored or submitted JSON, trimmed, or an error naming the field.
 *
 * For readers that stop at the first bad field. The validators that collect every issue for one answer
 * ask `isPhiNonBlankString` themselves and word their own message.
 */
export function requirePhiString(value: unknown, label: string) {
  if (!isPhiNonBlankString(value)) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}
