import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PhisAddonManifestV1 } from "./contract.ts";

const mocks = vi.hoisted(() => ({ getPool: vi.fn() }));

vi.mock("@/lib/db", async () => {
  const { withPoolTransaction } = await import("@/lib/db-transaction");
  return {
    getPool: mocks.getPool,
    withTransaction: (body: Parameters<typeof withPoolTransaction>[1]) =>
      withPoolTransaction(mocks.getPool(), body),
  };
});

import { buildPhisAddonDataCapability } from "./data-capability";

/*
 * An Add-on never holds a database handle. Not a pool, not a client, not inside a transaction, not for
 * an instant -- SERVER_ADDONS.md section 15: an Add-on describes the tables it needs and the queries it
 * runs, and Core derives the statements. A handle would undo all of it at once: the row-level ladder,
 * the Site scope, the schema isolation, and the promise that an Add-on outlives a change of database.
 *
 * The capability is built by closing over the queryable, so the guarantee is the absence of a property
 * rather than a check anything performs. Absence is what a refactor takes away silently, so it is
 * asserted as an exact key set: something newly exposed fails here rather than shipping.
 */

const PHI_DATA_OPERATIONS = ["aggregate", "delete", "insert", "select", "update"];
const PHI_FORBIDDEN_MEMBERS = ["query", "execute", "connect", "release", "end", "pool", "client", "db"];

function poolDouble() {
  const client = {
    // `command` mirrors what pg answers, and using the argument keeps the call typed as one string.
    query: vi.fn(async (text: string) => ({ rows: [], rowCount: 0, command: text })),
    release: vi.fn(),
  };
  mocks.getPool.mockReturnValue({
    query: vi.fn(async (text: string) => ({ rows: [], rowCount: 0, command: text })),
    connect: vi.fn(async () => client),
  });
  return client;
}

function capability() {
  return buildPhisAddonDataCapability({
    // No schema and no queries: the catalog is then empty, which is all this needs -- the question is
    // what the handle exposes, not what a query does.
    manifest: { addonId: "pgtest/handle" } as unknown as PhisAddonManifestV1,
    manifestDigest: "handle-test",
    siteId: 1,
    actorUserId: null,
    mayActOnRow: async () => false,
    mayUseGroup: async () => false,
    hasRole: async () => false,
    unauthenticated: true,
  });
}

beforeEach(() => {
  mocks.getPool.mockReset();
});

describe("The data capability an Add-on receives", () => {
  it("offers the declared operations and a transaction, and nothing else", () => {
    poolDouble();
    const data = capability();
    expect(Object.keys(data).sort()).toEqual([...PHI_DATA_OPERATIONS, "transaction"].sort());
  });

  it("exposes no way to reach the database itself", () => {
    poolDouble();
    const data = capability() as unknown as Record<string, unknown>;
    for (const member of PHI_FORBIDDEN_MEMBERS) {
      expect(data[member], `data:v1 must not expose "${member}"`).toBeUndefined();
    }
  });

  it("hands a transaction body the same operations, without the client it runs on", async () => {
    poolDouble();
    const data = capability();
    const keys = await data.transaction(async (handle) => {
      const members = handle as unknown as Record<string, unknown>;
      for (const member of PHI_FORBIDDEN_MEMBERS) {
        expect(members[member], `a transaction handle must not expose "${member}"`).toBeUndefined();
      }
      return Object.keys(handle).sort();
    });
    expect(keys).toEqual(PHI_DATA_OPERATIONS);
  });

  it("keeps the transaction's own boundaries out of the Add-on's reach", async () => {
    // Returning ends it and throwing undoes it. An Add-on that could commit or roll back would decide
    // when Core's checks stop applying, so those statements stay with the caller of the body.
    const client = poolDouble();
    const data = capability();
    await data.transaction(async () => null);
    const issued = client.query.mock.calls.map(([text]) => text);
    expect(issued).toEqual(["BEGIN", "COMMIT"]);

    client.query.mockClear();
    await expect(data.transaction(async () => {
      throw new Error("the Add-on failed");
    })).rejects.toThrow("the Add-on failed");
    expect(client.query.mock.calls.map(([text]) => text)).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("cannot be extended by the Add-on that holds it", () => {
    poolDouble();
    const data = capability() as unknown as Record<string, unknown>;
    expect(Object.isFrozen(data)).toBe(true);
    expect(() => {
      "use strict";
      data.query = () => null;
    }).toThrow();
  });
});
