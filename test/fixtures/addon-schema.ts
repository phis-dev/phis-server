import type { PhiServerAddonSchemaDescriptor } from "@/lib/addons/contract";

/**
 * A descriptor with enough shape to be worth testing: a Site-scoped table, a reference into Core, a
 * reference between two of the Add-on's own tables, and one constraint of every structured kind.
 */
export const incidentSchemaDescriptor: PhiServerAddonSchemaDescriptor = {
  descriptorVersion: 1,
  version: 1,
  tables: [
    {
      name: "incident",
      siteScoped: true,
      columns: [
        { name: "id", type: "identity" },
        { name: "title", type: "string", maxLength: 200 },
        { name: "state", type: "string", maxLength: 32, default: { kind: "literal", value: "open" } },
        { name: "severity", type: "smallInteger" },
        { name: "reported_by", references: "core.user", onDelete: "setNull", nullable: true },
        { name: "external_ref", type: "string", maxLength: 64, nullable: true },
        { name: "internal_ref", type: "string", maxLength: 64, nullable: true },
        { name: "opened_at", type: "instant", default: { kind: "now" } },
        { name: "closed_at", type: "instant", nullable: true },
      ],
      primaryKey: ["id"],
      indexes: [
        { name: "by_state", columns: ["state"] },
        { name: "by_external", columns: ["external_ref"], unique: true },
      ],
      constraints: [
        { kind: "enumeration", name: "state", column: "state", values: ["open", "ack", "closed"] },
        { kind: "range", name: "severity", column: "severity", min: 1, max: 5 },
        { kind: "notEmpty", name: "title", column: "title" },
        {
          kind: "columnComparison",
          name: "closed_after_opened",
          left: "opened_at",
          operator: "<=",
          right: "closed_at",
        },
        {
          kind: "nullCardinality",
          name: "one_reference",
          columns: ["external_ref", "internal_ref"],
          nonNullCount: 1,
        },
      ],
    },
    {
      name: "incident_note",
      // Site-scoped because it points at one that is: Core binds the reference to the Site, and a table
      // without one has no Site to bind it to.
      siteScoped: true,
      columns: [
        { name: "id", type: "identity" },
        { name: "incident_id", references: { table: "incident" }, onDelete: "cascade" },
        { name: "body", type: "text" },
        { name: "written_at", type: "instant", default: { kind: "now" } },
      ],
      primaryKey: ["id"],
      indexes: [{ name: "by_incident", columns: ["incident_id"] }],
    },
  ],
};
