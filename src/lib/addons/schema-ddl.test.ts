import { describe, expect, it } from "vitest";

import { buildPhisAddonSchemaStatements } from "./schema-ddl.ts";
import type { PhisAddonSchemaDescriptor } from "./contract.ts";
import { incidentSchemaDescriptor } from "../../../test/fixtures/addon-schema.ts";

const SCHEMA = "phis_addon_acme_incidents";

function statements() {
  return buildPhisAddonSchemaStatements(SCHEMA, incidentSchemaDescriptor);
}

function sqlFor(summary: string) {
  const statement = statements().find((entry) => entry.summary === summary);
  if (!statement) {
    throw new Error(`No statement summarised as "${summary}".`);
  }
  return statement.sql;
}

describe("schema DDL generation", () => {
  it("qualifies every table with the Add-on's schema", () => {
    for (const statement of statements()) {
      expect(statement.sql).toContain(`"${SCHEMA}".`);
    }
  });

  it("writes the Site column itself rather than expecting the Add-on to", () => {
    const sql = sqlFor("create table incident");
    expect(sql).toContain('"site_id" SMALLINT NOT NULL');
    expect(sqlFor("bind incident to its Site")).toContain(
      'REFERENCES phis.sites(id) ON DELETE CASCADE',
    );
    expect(sqlFor("index incident by Site")).toContain('("site_id")');
  });

  it("writes the owner column nullable, so a deleted user leaves the rows behind", () => {
    const scoped = buildPhisAddonSchemaStatements(SCHEMA, {
      ...incidentSchemaDescriptor,
      tables: incidentSchemaDescriptor.tables.map((table, index) =>
        index === 0 ? { ...table, ownerScoped: true } : table,
      ),
    });
    const create = scoped.find((entry) => entry.summary === "create table incident")!.sql;
    expect(create).toContain('"owner_user_id" INTEGER NULL');
    expect(scoped.find((entry) => entry.summary === "bind incident to its owner")!.sql).toContain(
      "REFERENCES phis.user_accounts(id) ON DELETE SET NULL",
    );
    expect(scoped.some((entry) => entry.summary === "index incident by owner")).toBe(true);
  });

  it("binds a group together with its Site rather than by id alone", () => {
    const scoped = buildPhisAddonSchemaStatements(SCHEMA, {
      ...incidentSchemaDescriptor,
      tables: incidentSchemaDescriptor.tables.map((table, index) =>
        index === 0 ? { ...table, groupScoped: true } : table,
      ),
    });
    expect(scoped.find((entry) => entry.summary === "create table incident")!.sql).toContain(
      '"group_id" INTEGER NOT NULL',
    );
    expect(scoped.find((entry) => entry.summary === "bind incident to its group")!.sql).toContain(
      'FOREIGN KEY ("group_id", "site_id") REFERENCES phis.site_groups(id, site_id) ON DELETE CASCADE',
    );
  });

  it("gives a plain group reference the same composite binding", () => {
    const [first, ...rest] = incidentSchemaDescriptor.tables;
    const withAudience = buildPhisAddonSchemaStatements(SCHEMA, {
      ...incidentSchemaDescriptor,
      tables: [
        {
          ...first!,
          columns: [
            ...first!.columns,
            { name: "audience", references: "core.group", onDelete: "cascade" } as const,
          ],
        },
        ...rest,
      ],
    });
    expect(withAudience.find(
      (entry) => entry.summary === "point incident.audience at core.group within its Site",
    )!.sql).toContain('FOREIGN KEY ("audience", "site_id") REFERENCES phis.site_groups(id, site_id)');
  });

  it("resolves a symbolic Core reference to a table an Add-on never names", () => {
    const sql = sqlFor("point incident.reported_by at core.user");
    expect(sql).toContain("REFERENCES phis.user_accounts");
    expect(sql).toContain("ON DELETE SET NULL");
    expect(sqlFor("create table incident")).toContain('"reported_by" INTEGER NULL');
  });

  it("gives a reference column the type of what it points at", () => {
    // `incident.id` is an identity column, so the column pointing at it is a plain BIGINT.
    expect(sqlFor("create table incident_note")).toContain('"incident_id" BIGINT NOT NULL');
    expect(sqlFor("point incident_note.incident_id at incident within its Site"))
      .toContain("ON DELETE CASCADE");
  });

  it("carries the Site into a reference between two Site-scoped tables", () => {
    /*
     * The id alone would let a note of one Site name an incident of another, and nothing about the
     * declaration would show it: the column reads the same and the constraint still holds. This is the
     * group reference's rule applied to an Add-on's own tables, where it matters more -- both rows are
     * the Add-on's, and a query would read across the boundary Core puts into every statement.
     */
    const sql = sqlFor("point incident_note.incident_id at incident within its Site");
    expect(sql).toContain('FOREIGN KEY ("incident_id", "site_id")');
    expect(sql).toContain('REFERENCES "phis_addon_acme_incidents"."incident"("id", "site_id")');
  });

  it("lays down the key such a reference needs, and only where one points", () => {
    // PostgreSQL accepts `(column, site_id)` only against a unique key covering exactly those; the
    // primary key alone is not it.
    const key = sqlFor("key incident by Site for references");
    expect(key).toContain('UNIQUE ("id", "site_id")');
    expect(statements().some((entry) => entry.summary === "key incident_note by Site for references"))
      .toBe(false);
  });

  it("keys a referenced table before anything points at it", () => {
    const all = statements();
    const key = all.findIndex((entry) => entry.summary.startsWith("key "));
    const firstReference = all.findIndex((entry) => entry.summary.startsWith("point "));
    expect(key).toBeGreaterThanOrEqual(0);
    expect(key).toBeLessThan(firstReference);
  });

  it("renders every structured constraint as a check", () => {
    const sql = sqlFor("create table incident");
    expect(sql).toContain(`"state" IN ('open', 'ack', 'closed')`);
    expect(sql).toContain('"severity" >= 1 AND "severity" <= 5');
    expect(sql).toContain('length(trim("title")) > 0');
    expect(sql).toContain('"opened_at" <= "closed_at"');
    expect(sql).toContain(
      '(("external_ref" IS NOT NULL)::int + ("internal_ref" IS NOT NULL)::int) = 1',
    );
  });

  it("prefixes an index name with its table, because PostgreSQL scopes them per schema", () => {
    expect(sqlFor("index incident by state")).toContain('"incident_by_state_idx"');
    expect(sqlFor("index incident_note by incident_id")).toContain('"incident_note_by_incident_idx"');
  });

  it("creates every table before any foreign key, so a descriptor may be in any order", () => {
    const all = statements();
    const lastTable = all.findLastIndex((entry) => entry.summary.startsWith("create table"));
    const firstKey = all.findIndex((entry) => entry.summary.startsWith("point "));
    expect(firstKey).toBeGreaterThan(lastTable);
  });

  it("escapes a literal rather than trusting it", () => {
    const escaped = buildPhisAddonSchemaStatements(SCHEMA, {
      descriptorVersion: 1,
      version: 1,
      tables: [
        {
          name: "quoted",
          siteScoped: false,
          columns: [
            { name: "id", type: "identity" },
            { name: "label", type: "string", maxLength: 32, default: { kind: "literal", value: "it's" } },
          ],
          primaryKey: ["id"],
        },
      ],
    });
    expect(escaped[0].sql).toContain("DEFAULT 'it''s'");
  });

  it("scopes a unique index to the Site, because unique means unique in here", () => {
    expect(sqlFor("index incident by site_id, external_ref")).toContain(
      'UNIQUE INDEX "incident_by_external_idx"',
    );
    expect(sqlFor("index incident by site_id, external_ref")).toContain('("site_id", "external_ref")');
  });

  it("leaves a plain index alone, since it is an access path and not a rule", () => {
    expect(sqlFor("index incident by state")).toContain('("state")');
    expect(sqlFor("index incident by state")).not.toContain("site_id");
  });

  it("turns a unique column on a Site-scoped table into a Site-scoped constraint", () => {
    const sql = buildPhisAddonSchemaStatements(SCHEMA, {
      descriptorVersion: 1,
      version: 1,
      tables: [
        {
          name: "offering",
          siteScoped: true,
          columns: [
            { name: "id", type: "identity" },
            { name: "slug", type: "string", maxLength: 64, unique: true },
          ],
          primaryKey: ["id"],
        },
      ],
    })[0].sql;
    expect(sql).toContain('CONSTRAINT "offering_slug_uq" UNIQUE ("site_id", "slug")');
    expect(sql).not.toContain('"slug" VARCHAR(64) NOT NULL UNIQUE');
  });

  it("keeps plain uniqueness where there is no Site to scope it to", () => {
    const sql = buildPhisAddonSchemaStatements(SCHEMA, {
      descriptorVersion: 1,
      version: 1,
      tables: [
        {
          name: "licence_key",
          siteScoped: false,
          columns: [
            { name: "id", type: "identity" },
            { name: "value", type: "string", maxLength: 64, unique: true },
          ],
          primaryKey: ["id"],
        },
      ],
    })[0].sql;
    expect(sql).toContain('"value" VARCHAR(64) NOT NULL UNIQUE');
    expect(sql).not.toContain("_uq");
  });
});

/**
 * The table Core adds beside one that declares files.
 *
 * It exists so that the answer to "which objects still matter" is a `SELECT` rather than a guess. Every
 * property tested here serves that: the cascade, so removing a row removes what described its files; the
 * partial uniqueness, so a replacement can be uploaded before the file it replaces is given up; and the
 * expiry index, so an abandoned transfer is findable without listing a bucket.
 */
describe("the asset table", () => {
  const withAssets: PhisAddonSchemaDescriptor = {
    ...incidentSchemaDescriptor,
    tables: incidentSchemaDescriptor.tables.map((table, index) =>
      index === 0
        ? {
            ...table,
            assets: [
              { name: "report", cardinality: "one" as const, maxBytes: 1_000, contentTypes: ["application/pdf"] },
              { name: "photos", cardinality: "many" as const, maxBytes: 2_000, contentTypes: ["image/png"] },
            ],
          }
        : table,
    ),
  };

  function assetSql(summary: string) {
    const built = buildPhisAddonSchemaStatements(SCHEMA, withAssets);
    const statement = built.find((entry) => entry.summary === summary);
    if (!statement) {
      throw new Error(`No statement summarised as "${summary}". Got: ${built.map((e) => e.summary).join(", ")}`);
    }
    return statement.sql;
  }

  it("is added only for a table that asked for it", () => {
    expect(statements().some((entry) => entry.summary.includes("incident_assets"))).toBe(false);
    expect(assetSql("create table incident_assets")).toContain('"incident_assets"');
  });

  it("takes the parent's key type rather than assuming one", () => {
    // `identity` on the parent is `BIGINT` on the side that points at it.
    expect(assetSql("create table incident_assets")).toContain('"owner_id" BIGINT NOT NULL');
  });

  it("cascades from the parent, and carries the Site into the reference", () => {
    const sql = assetSql("create table incident_assets");
    expect(sql).toContain(
      'FOREIGN KEY ("owner_id", "site_id") REFERENCES "phis_addon_acme_incidents"."incident"("id", "site_id") ON DELETE CASCADE',
    );
  });

  it("keys the parent by Site even though nothing the Add-on declared points at it", () => {
    // Without this the composite foreign key above has no unique key to reference and PostgreSQL
    // refuses it -- and the statement that would fail comes after tables have already been created.
    const built = buildPhisAddonSchemaStatements(SCHEMA, withAssets);
    const keyed = built.findIndex((entry) => entry.summary === "key incident by Site for references");
    const created = built.findIndex((entry) => entry.summary === "create table incident_assets");
    expect(keyed).toBeGreaterThanOrEqual(0);
    expect(keyed).toBeLessThan(created);
  });

  it("writes the slot vocabulary into the database, not only into the manifest", () => {
    expect(assetSql("create table incident_assets")).toContain(
      `CHECK ("slot" IN ('report', 'photos'))`,
    );
  });

  it("holds a single-valued slot to one file, and leaves the accumulating one alone", () => {
    // Plainly unique, because every row here is a finished file. It was partial while a transfer in
    // flight lived in this table too; that record is Core's upload session now.
    const sql = assetSql("hold incident_assets to one file per slot");
    expect(sql).toContain("CREATE UNIQUE INDEX");
    expect(sql).toContain(`WHERE "slot" IN ('report')`);
    expect(sql).not.toContain("photos");
  });

  it("leaves the uniqueness rule out entirely when every slot accumulates", () => {
    const many = buildPhisAddonSchemaStatements(SCHEMA, {
      ...withAssets,
      tables: withAssets.tables.map((table, index) =>
        index === 0
          ? { ...table, assets: table.assets!.filter((slot) => slot.cardinality === "many") }
          : table,
      ),
    });
    expect(many.some((entry) => entry.summary.includes("one finished file"))).toBe(false);
  });

  it("refuses two rows on one file", () => {
    expect(assetSql("create table incident_assets")).toContain('UNIQUE ("media_asset_id")');
  });

  it("holds a link and none of the facts, which live once in media_assets", () => {
    /*
     * Two records of one thing eventually disagree. Where the object is, how big it turned out and
     * which digest it carries are Core's answers already, for every upload it has ever handled.
     */
    const sql = assetSql("create table incident_assets");
    for (const copied of ["storage_key", "byte_size", "content_type", "checksum_value"]) {
      expect(sql).not.toContain(copied);
    }
    expect(sql).toContain(
      'FOREIGN KEY ("media_asset_id", "site_id") REFERENCES phis.media_assets(id, site_id) ON DELETE CASCADE',
    );
  });
});
