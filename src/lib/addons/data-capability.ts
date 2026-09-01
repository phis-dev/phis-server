import "server-only";

import type { PoolClient } from "pg";

import type {
  PhiServerAddonManifestV1,
  PhiServerAddonQueryArguments,
  PhiServerAddonQueryPageRequest,
  PhiServerAddonQueryRow,
  PhiServerDataCapabilityV1,
  PhiServerDataTransactionV1,
} from "./contract.ts";
import {
  compilePhiServerAddonQueries,
  type PhiServerAddonCompiledQuery,
} from "./query-sql.ts";
import {
  decodePhiServerAddonCursor,
  encodePhiServerAddonCursor,
} from "./query-cursor.ts";
import { derivePhiServerAddonSchemaName } from "./schema-name.ts";
import { getPool } from "@/lib/db";

/**
 * Running an Add-on's declared queries.
 *
 * Two things happen here that the Add-on cannot influence. Core substitutes its own Site and actor
 * wherever a compiled statement asks for them, so no argument can aim a query at another tenant. And a
 * mutation is refused before it runs unless the row-level authority allows it -- the ladder is applied
 * by the write path rather than left to the Add-on to consult, because a check that has to be
 * remembered is one that eventually is not. An insert that names a group is refused the same way when
 * the actor does not stand in it.
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
  /** Whether the actor stands in the group an insert names. Injected for the same reason as above. */
  mayUseGroup: (groupId: unknown) => Promise<boolean>;
  /** Whether the actor holds one of this Add-on's declared roles. Injected, like the two above. */
  hasRole: (role: string) => Promise<boolean>;
  /** True when nobody authenticated at all, which is the case for a hook and for nothing else. */
  unauthenticated: boolean;
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
  bindings: PhiServerAddonCompiledQuery["bindings"],
  bound: Bound,
  args: PhiServerAddonQueryArguments,
  descriptorParameters: { id?: string; group?: string },
  page: { size: number; keys: string[] },
) {
  return bindings.map((binding) => {
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
      case "cursor":
        return page.keys[binding.index]!;
      case "limit":
        // One more than the page, which is how "is there another one" is answered without a count.
        return page.size + 1;
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
    requiresRole: descriptor.requiresRole,
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

/**
 * How large a page actually is: the smallest of what was asked, what the Add-on allows, and the ceiling.
 *
 * A request that asks for nothing gets the Add-on's own limit, which is what an unpaged call used to
 * return and keeps the ordinary case unchanged. A request for zero or nonsense gets one row rather than
 * an error -- the page size is a wish, and a wish that cannot be granted is narrowed, not refused.
 */
function pageSize(requested: number | undefined, allowed: number) {
  if (requested === undefined || !Number.isFinite(requested)) {
    return allowed;
  }
  return Math.max(1, Math.min(Math.floor(requested), allowed));
}

async function run(
  db: Queryable,
  bound: Bound,
  name: string,
  kind: PhiServerAddonCompiledQuery["kind"],
  args: PhiServerAddonQueryArguments,
  request: PhiServerAddonQueryPageRequest = {},
) {
  const query = requireQuery(bound, name, kind);
  const parameters = descriptorParametersFor(bound.manifest, name);

  if (bound.unauthenticated && kind !== "select") {
    /*
     * No actor at all, no writing -- and said before the ladder rather than after, so all three
     * mutations answer the same way. The ladder would refuse an update and a delete on its own, but
     * silently, with a zero that means "no row for you"; here there is no row-level question to be
     * ambiguous about, because this caller may change nothing whatever the row is. An insert has no row
     * to judge at all, and is the one that would otherwise go through.
     *
     * Narrower than "no user": an operator and an internal caller both have a null user id, and a job
     * has none either, while none of the three is anonymous. Only a caller who never identified
     * themselves lands here -- today that is a hook, and nothing else.
     */
    throw new PhiServerAddonQueryError(
      `Query "${name}" changes rows, and this request has no actor behind it.`,
    );
  }

  if (parameters.requiresRole) {
    /*
     * Before everything else, including the read of the row: whether this caller may run this query at
     * all is a question that does not depend on which row they aimed it at, and answering it first is
     * what stops a refusal from telling them a row exists.
     *
     * Refused loudly, unlike the ladder. A missing role is not "no row for you" -- there is nothing to
     * withhold, and an Add-on that offered the action to the wrong person wants to hear so.
     */
    if (!await bound.hasRole(parameters.requiresRole)) {
      throw new PhiServerAddonQueryError(
        `Query "${name}" requires the role "${parameters.requiresRole}", which this actor does not hold.`,
      );
    }
  }

  if (kind === "update" || kind === "delete") {
    // Before the statement, never after: a refused write must not have happened.
    const id = readArgument(args, parameters.id!, name);
    if (!await bound.mayActOnRow({ table: query.table, id, intent: kind })) {
      return { rows: [] as PhiServerAddonQueryRow[], rowCount: 0, cursor: null };
    }
  }

  if (kind === "insert" && parameters.group) {
    /*
     * The group is the only scope column an insert names, because a row may belong to any group the
     * actor is in. That makes it the only way an insert could reach outside the actor's standing, so it
     * is checked rather than trusted -- Core writes the Site and the owner itself, and this is what
     * keeps the group as narrow as they are.
     *
     * Refused loudly, unlike the ladder above. There a silent zero is the point, because it does not say
     * whether the row exists; here there is nothing to withhold, and a swallowed insert would look to
     * the Add-on exactly like one that happened.
     */
    const groupId = readArgument(args, parameters.group, name);
    if (!await bound.mayUseGroup(groupId)) {
      throw new PhiServerAddonQueryError(
        `Query "${name}" names a group the acting user does not stand in.`,
      );
    }
  }

  if (!query.paging) {
    const result = await db.query(
      query.sql,
      resolveBindings(query, query.bindings, bound, args, parameters, { size: 0, keys: [] }),
    );
    return {
      rows: result.rows as PhiServerAddonQueryRow[],
      rowCount: result.rowCount ?? 0,
      cursor: null,
    };
  }

  /*
   * Every select is paged, and the page is the whole of what a caller can reach in one call. The first
   * page runs the plain statement; every page after it runs the one with the keyset clause, whose
   * comparison values come out of the cursor rather than out of the arguments -- an Add-on cannot aim a
   * page at a row it did not just read.
   */
  const { paging } = query;
  const keys = request.cursor
    ? decodePhiServerAddonCursor(name, paging.ordering, request.cursor)
    : [];
  const size = pageSize(request.limit, paging.limit);
  /*
   * Called with text and values, never with a `name`, and that is load-bearing rather than a style.
   *
   * A declared optional filter compiles to `($n::TYPE IS NULL OR col = $n)`, and an unnamed statement is
   * planned at bind time with the real values: PostgreSQL folds the null test away and `col = 'x'` goes
   * into the index condition, exactly as a hand-written filter would. Give this call a `name` and it
   * becomes a prepared statement that may be planned generically -- measured on 200k rows, the index
   * condition disappears and 2475 rows are read and discarded to return 25.
   *
   * So: no `name` here, and no prepared-statement layer above it. The server-side `plan_cache_mode` does
   * not reach this -- that one governs the cache for prepared statements, and there is none.
   */
  const result = await db.query(
    keys.length > 0 ? paging.sql : query.sql,
    resolveBindings(
      query,
      keys.length > 0 ? paging.bindings : query.bindings,
      bound,
      args,
      parameters,
      { size, keys },
    ),
  );

  // The extra row is read and then dropped: it was never part of the answer, only of the question
  // whether there is one after it.
  const rows = (result.rows as PhiServerAddonQueryRow[]).slice(0, size);
  const more = result.rows.length > size;
  return {
    rows,
    rowCount: rows.length,
    cursor: more && rows.length > 0
      ? encodePhiServerAddonCursor(name, paging.ordering, rows[rows.length - 1]!)
      : null,
  };
}

function buildOperations(db: Queryable, bound: Bound): PhiServerDataTransactionV1 {
  return Object.freeze({
    async select(name, args = {}, page = {}) {
      const result = await run(db, bound, name, "select", args, page);
      return { rows: result.rows, cursor: result.cursor };
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
  mayUseGroup: Bound["mayUseGroup"];
  hasRole: Bound["hasRole"];
  unauthenticated: boolean;
}): PhiServerDataCapabilityV1 {
  const bound: Bound = {
    manifest: input.manifest,
    catalog: resolveCatalog(input.manifest, input.manifestDigest),
    siteId: input.siteId,
    actorUserId: input.actorUserId,
    mayActOnRow: input.mayActOnRow,
    mayUseGroup: input.mayUseGroup,
    hasRole: input.hasRole,
    unauthenticated: input.unauthenticated,
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
