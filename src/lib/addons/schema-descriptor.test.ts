import { describe, expect, it } from "vitest";

import { validatePhiServerAddonSchemaDescriptor } from "./schema-descriptor.ts";
import { derivePhiServerAddonSchemaName } from "./schema-name.ts";
import { incidentSchemaDescriptor } from "../../../test/fixtures/addon-schema.ts";

function validate(value: unknown) {
  const issues: string[] = [];
  const descriptor = validatePhiServerAddonSchemaDescriptor(value, "schema", issues);
  return { descriptor, issues };
}

function withTable(mutate: (table: Record<string, unknown>) => void) {
  const copy = structuredClone(incidentSchemaDescriptor) as unknown as {
    tables: Record<string, unknown>[];
  };
  mutate(copy.tables[0]);
  return copy;
}

describe("schema name derivation", () => {
  it("prefixes and flattens the logical id", () => {
    expect(derivePhiServerAddonSchemaName("@acme/github")).toBe("phis_addon_acme_github");
    expect(derivePhiServerAddonSchemaName("@phis/storage-s3")).toBe("phis_addon_phis_storage_s3");
  });

  it("is lossy in exactly the way the unique index has to catch", () => {
    expect(derivePhiServerAddonSchemaName("@acme-a/b")).toBe(
      derivePhiServerAddonSchemaName("@acme/a-b"),
    );
  });

  it("refuses an id that is not an npm name without the postfix", () => {
    expect(() => derivePhiServerAddonSchemaName("acme/github")).toThrow(/valid Add-on id/);
    expect(() => derivePhiServerAddonSchemaName("@acme/git_hub")).toThrow(/valid Add-on id/);
    expect(() => derivePhiServerAddonSchemaName("@acme/git.hub")).toThrow(/valid Add-on id/);
  });

  it("refuses a name it would otherwise have to truncate", () => {
    const long = `@${"a".repeat(30)}/${"b".repeat(30)}`;
    expect(() => derivePhiServerAddonSchemaName(long)).toThrow(/exceeds 63/);
  });
});

describe("schema descriptor validation", () => {
  it("accepts a descriptor that uses every structured constraint", () => {
    const { descriptor, issues } = validate(incidentSchemaDescriptor);
    expect(issues).toEqual([]);
    expect(descriptor).not.toBeNull();
  });

  it.each([
    ["site_id", "siteScoped"],
    ["group_id", "groupScoped"],
    ["owner_user_id", "ownerScoped"],
  ])("refuses %s, which Core writes itself", (columnName, scope) => {
    const { issues } = validate(
      withTable((table) => {
        (table.columns as Record<string, unknown>[]).push({ name: columnName, type: "integer" });
      }),
    );
    expect(issues.join("\n")).toMatch(
      new RegExp(`"${columnName}", which Core writes itself\\. Declare ${scope} instead\\.`),
    );
  });

  it("accepts the owner and group scopes on a Site-scoped table", () => {
    const { issues } = validate(
      withTable((table) => {
        table.ownerScoped = true;
        table.groupScoped = true;
      }),
    );
    expect(issues).toEqual([]);
  });

  it("refuses a table that does not say whether it is Site-scoped", () => {
    /*
     * Not a formality. Everywhere else in this descriptor an absent field means the safe reading, because
     * Core supplies the boundary and the Add-on cannot forget it. Here Core cannot supply it, so silence
     * would mean the instance-wide table -- the one place where saying nothing is the permissive answer.
     */
    const { issues } = validate(
      withTable((table) => {
        delete table.siteScoped;
      }),
    );
    expect(issues.join("\n")).toMatch(/siteScoped must be stated as a boolean/);
  });

  it("takes false for an answer, because a table may belong to the Add-on", () => {
    // A category list, a currency table, a set of country codes: the rows are the Add-on's and no Site's.
    const { issues } = validate({
      descriptorVersion: 1,
      version: 1,
      tables: [{
        name: "currency",
        siteScoped: false,
        columns: [
          { name: "id", type: "identity" },
          { name: "code", type: "string", maxLength: 3, unique: true },
        ],
        primaryKey: ["id"],
      }],
    });
    expect(issues).toEqual([]);
  });

  it("refuses ownerScoped without siteScoped, because Core weighs a person on a Site", () => {
    // The pair would otherwise come apart: the same account reaching a row from a Site it was never
    // admitted to, on a comparison that looked at nothing but a user id.
    const { issues } = validate(
      withTable((table) => {
        table.siteScoped = false;
        table.ownerScoped = true;
      }),
    );
    expect(issues.join("\n")).toMatch(/ownerScoped requires siteScoped/);
  });

  it("refuses groupScoped without siteScoped", () => {
    const { issues } = validate(
      withTable((table) => {
        table.siteScoped = false;
        table.groupScoped = true;
      }),
    );
    expect(issues.join("\n")).toMatch(/groupScoped requires siteScoped/);
  });

  it("refuses a reference into a Site-scoped table from one that is not", () => {
    // `incident_note` points at `incident`. Without a Site of its own it has none to bind the reference
    // to, and a note would be free to name an incident of any Site on the instance.
    const copy = structuredClone(incidentSchemaDescriptor) as unknown as {
      tables: Record<string, unknown>[];
    };
    copy.tables[1]!.siteScoped = false;
    expect(validate(copy).issues.join("\n")).toMatch(/must be siteScoped too/);
  });

  it("refuses setNull on such a reference, which would clear the Site column too", () => {
    const copy = structuredClone(incidentSchemaDescriptor) as unknown as {
      tables: { columns: Record<string, unknown>[] }[];
    };
    const column = copy.tables[1]!.columns.find((entry) => entry.name === "incident_id")!;
    column.onDelete = "setNull";
    column.nullable = true;
    expect(validate(copy).issues.join("\n")).toMatch(/must use onDelete "cascade"/);
  });

  it("refuses a group reference on a table that is not Site-scoped", () => {
    const { issues } = validate(
      withTable((table) => {
        table.siteScoped = false;
        (table.columns as Record<string, unknown>[]).push({
          name: "audience", references: "core.group", onDelete: "cascade",
        });
      }),
    );
    expect(issues.join("\n")).toMatch(/so the table must be siteScoped/);
  });

  it("refuses setNull on a group reference, which would clear the Site column too", () => {
    const { issues } = validate(
      withTable((table) => {
        (table.columns as Record<string, unknown>[]).push({
          name: "audience", references: "core.group", onDelete: "setNull", nullable: true,
        });
      }),
    );
    expect(issues.join("\n")).toMatch(/must use onDelete "cascade"/);
  });

  it("refuses setNull on a column that cannot be null", () => {
    const { issues } = validate(
      withTable((table) => {
        const columns = table.columns as Record<string, unknown>[];
        const reference = columns.find((column) => column.name === "reported_by")!;
        reference.nullable = false;
      }),
    );
    expect(issues.join("\n")).toMatch(/onDelete "setNull" but is not nullable/);
  });

  it("refuses a reference column that states a type", () => {
    const { issues } = validate(
      withTable((table) => {
        const columns = table.columns as Record<string, unknown>[];
        columns.find((column) => column.name === "reported_by")!.type = "integer";
      }),
    );
    expect(issues.join("\n")).toMatch(/must not state a type/);
  });

  it("refuses a reference to a table the Add-on does not declare", () => {
    const copy = structuredClone(incidentSchemaDescriptor) as unknown as {
      tables: Record<string, unknown>[];
    };
    const columns = copy.tables[1].columns as Record<string, unknown>[];
    columns.find((column) => column.name === "incident_id")!.references = { table: "absent" };
    expect(validate(copy).issues.join("\n")).toMatch(/which this Add-on does not declare/);
  });

  it("refuses a constraint on a column that is not there", () => {
    const { issues } = validate(
      withTable((table) => {
        (table.constraints as Record<string, unknown>[])[0].column = "absent";
      }),
    );
    expect(issues.join("\n")).toMatch(/does not name a column of incident/);
  });

  it("refuses an identity column that is not the whole primary key", () => {
    const { issues } = validate(
      withTable((table) => {
        table.primaryKey = ["id", "title"];
      }),
    );
    expect(issues.join("\n")).toMatch(/must be the whole primary key/);
  });

  it("refuses a composed index name that would not fit an identifier", () => {
    const { issues } = validate(
      withTable((table) => {
        (table.indexes as Record<string, unknown>[])[0].name = "a".repeat(60);
      }),
    );
    expect(issues.join("\n")).toMatch(/exceeds 63 characters/);
  });

  it("refuses a version that does not fit the column it is stored in", () => {
    const copy = structuredClone(incidentSchemaDescriptor) as unknown as { version: number };
    copy.version = 40_000;
    expect(validate(copy).issues.join("\n")).toMatch(/SMALLINT/);
  });

  it("refuses a range constraint that states no bound", () => {
    const { issues } = validate(
      withTable((table) => {
        const constraints = table.constraints as Record<string, unknown>[];
        const range = constraints.find((constraint) => constraint.kind === "range")!;
        delete range.min;
        delete range.max;
      }),
    );
    expect(issues.join("\n")).toMatch(/states neither min nor max/);
  });
});
