/**
 * A timestamp column as the ISO string the records hand out, or null where the column is empty.
 *
 * `pg` answers a `timestamptz` with a `Date`, but a value that went through `to_json`, a CTE or a text
 * cast arrives as Postgres' own string form, which is not ISO. Both are normalized, so a record never
 * carries whichever shape its query happened to produce; one copy of this passed strings through as
 * they came.
 */
export function toPhiIsoString(value: string | Date | null | undefined) {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
