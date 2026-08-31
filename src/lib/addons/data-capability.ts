import "server-only";

import type { PoolClient } from "pg";

import type {
  PhiServerAddonManifestV1,
  PhiServerAddonQueryArguments,
  PhiServerAddonQueryRow,
  PhiServerDataCapabilityV1,
  PhiServerDataTransactionV1,
} from "./contract.ts";
import {
  compilePhiServerAddonQueries,
  type PhiServerAddonCompiledQuery,
} from "./query-sql.ts";
import { derivePhiServerAddonSchemaName } from "./schema-name.ts";
import { getPool } from "@/lib/db";

/**
 * Running an Add-on's declared queries.
 *
 * Two things happen here that the Add-on cannot influence. Core substitutes its own Site and actor
 * wherever a compiled statement asks for them, so no argument can aim a query at another tenant. And a
 * mutation is refused before it runs unless the row-level authority allows it -- the ladder is applied
 * by the write path rather than left to the Add-on to consult, because a check that has to be
 * remembered is one that eventually is not.
 *
 * `mayActOnRow` on the authorization capability answers the same question. It is for deciding what to
 * offer a user; this is what actually holds.
 */

/** The compiled catalog per Add-on build, keyed by manifest digest so a changed build recompiles. */
const compiledCatalogs = new Map<string, Map<string, PhiServerAddonCompiledQuery>>();

function resolveCatalog(manifest: PhiServerAddonManifestV1, manifestDigest: string) {
  const cached = compiledCatalogs.get(manifestDigest);
  if (cached) {
    return cached;
  }
  const compiled = manifest.schema && manifest.queries
    ? compilePhiServerAddonQueries(
      derivePhiServerAddonSchemaName(manifest.addonId),
      manifest.schema,
      manifest.queries,
    )
    : new Map<string, PhiServerAddonCompiledQuery>();
  compiledCatalogs.set(manifestDigest, compiled);
  return compiled;
}

export class PhiServerAddonQueryError extends Error {}

type Queryable = Pick<PoolClient, "query">;

type Bound = {
  manifest: PhiServerAddonManifestV1;
  catalog: Map<string, PhiServerAddonCompiledQuery>;
  siteId: number;
  actorUserId: number | null;
  mayActOnRow: (input: { table: string; id: unknown; intent: "update" | "delete" }) => Promise<boolean>;
};

function readArgument(
  args: PhiServerAddonQueryArguments,
  name: string,
  queryName: string,
) {
  if (!(name in args)) {
    throw new PhiServerAddonQueryError(`Query "${queryName}" needs an argument named "${name}".`);
  }
  return args[name] ?? null;
}

/**
 * Turns the compiled bindings into the values one call passes.
 *
 * `site` and `actor` never come from the arguments. That is the whole reason bindings are a list of
 * sources rather than a list of names: the Add-on has no way to supply a value for either.
 */
function resolveBindings(
  query: PhiServerAddonCompiledQuery,
  bound: Bound,
  args: PhiServerAddonQueryArguments,
  descriptorParameters: { id?: string; group?: string; offset?: string },
) {
  return query.bindings.map((binding) => {
    switch (binding.from) {
      case "parameter":
        return readArgument(args, binding.name, query.name);
      case "literal":
        return binding.value;
      case "actor":
        return bound.actorUserId;
      case "site":
        return bound.siteId;
      case "id":
        return readArgument(args, descriptorParameters.id!, query.name);
      case "group":
        return readArgument(args, descriptorParameters.group!, query.name);
      case "offset":
        return readArgument(args, descriptorParameters.offset!, query.name);
    }
  });
}

function descriptorParametersFor(manifest: PhiServerAddonManifestV1, name: string) {
  const descriptor = manifest.queries?.queries.find((entry) => entry.name === name);
  if (!descriptor) {
    return {};
  }
  return {
    id: descriptor.kind === "update" || descriptor.kind === "delete"
      ? descriptor.idParameter
      : undefined,
    group: descriptor.kind === "insert" ? descriptor.groupParameter : undefined,
    offset: descriptor.kind === "select" ? descriptor.offsetParameter : undefined,
  };
}

function requireQuery(bound: Bound, name: string, kind: PhiServerAddonCompiledQuery["kind"]) {
  const query = bound.catalog.get(name);
  if (!query) {
    throw new PhiServerAddonQueryError(`No declared query named "${name}".`);
  }
  if (query.kind !== kind) {
    throw new PhiServerAddonQueryError(`Query "${name}" is a ${query.kind}, not a ${kind}.`);
  }
  return query;
}

async function run(
  db: Queryable,
  bound: Bound,
  name: string,
  kind: PhiServerAddonCompiledQuery["kind"],
  args: PhiServerAddonQueryArguments,
) {
  const query = requireQuery(bound, name, kind);
  const parameters = descriptorParametersFor(bound.manifest, name);

  if (kind === "update" || kind === "delete") {
    // Before the statement, never after: a refused write must not have happened.
    const id = readArgument(args, parameters.id!, name);
    if (!await bound.mayActOnRow({ table: query.table, id, intent: kind })) {
      return { rows: [] as PhiServerAddonQueryRow[], rowCount: 0 };
    }
  }

  const result = await db.query(query.sql, resolveBindings(query, bound, args, parameters));
  return { rows: result.rows as PhiServerAddonQueryRow[], rowCount: result.rowCount ?? 0 };
}

function buildOperations(db: Queryable, bound: Bound): PhiServerDataTransactionV1 {
  return Object.freeze({
    async select(name, args = {}) {
      return (await run(db, bound, name, "select", args)).rows;
    },
    async insert(name, args = {}) {
      return (await run(db, bound, name, "insert", args)).rows[0] ?? null;
    },
    async update(name, args = {}) {
      return (await run(db, bound, name, "update", args)).rowCount;
    },
    async delete(name, args = {}) {
      return (await run(db, bound, name, "delete", args)).rowCount;
    },
  } satisfies PhiServerDataTransactionV1);
}

export function buildPhiServerAddonDataCapability(input: {
  manifest: PhiServerAddonManifestV1;
  manifestDigest: string;
  siteId: number;
  actorUserId: number | null;
  mayActOnRow: Bound["mayActOnRow"];
}): PhiServerDataCapabilityV1 {
  const bound: Bound = {
    manifest: input.manifest,
    catalog: resolveCatalog(input.manifest, input.manifestDigest),
    siteId: input.siteId,
    actorUserId: input.actorUserId,
    mayActOnRow: input.mayActOnRow,
  };
  // The pool itself is queryable in the same way a client is; only the transaction needs a client.
  const pooled = buildOperations(getPool() as unknown as Queryable, bound);
  return Object.freeze({
    ...pooled,
    async transaction(body) {
      const client = await getPool().connect();
      try {
        await client.query("BEGIN");
        // The handle offers the four operations and nothing else, so an Add-on has no way to commit,
        // roll back, or leave the transaction open. Returning ends it; throwing undoes it.
        const result = await body(buildOperations(client, bound));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  } satisfies PhiServerDataCapabilityV1);
}
