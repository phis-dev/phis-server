import "server-only";

import type { PoolClient } from "pg";

import { PHIS_ADDON_QUERY_MAX_LIST } from "./contract.ts";
import type {
  PhisAddonManifestV1,
  PhisAddonQueryArguments,
  PhisAddonQueryPageRequest,
  PhisAddonQueryRow,
  PhisDataCapabilityV1,
  PhisDataTransactionV1,
} from "./contract.ts";
import {
  compilePhisAddonQueries,
  cursorColumnName,
  type PhisAddonCompiledQuery,
} from "./query-sql.ts";
import {
  decodePhisAddonCursor,
  encodePhisAddonCursor,
} from "./query-cursor.ts";
import { derivePhisAddonSchemaName } from "./schema-name.ts";
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
const compiledCatalogs = new Map<string, Map<string, PhisAddonCompiledQuery>>();

function resolveCatalog(manifest: PhisAddonManifestV1, manifestDigest: string) {
  const cached = compiledCatalogs.get(manifestDigest);
  if (cached) {
    return cached;
  }
  const compiled = manifest.schema && manifest.queries
    ? compilePhisAddonQueries(
      derivePhisAddonSchemaName(manifest.addonId),
      manifest.schema,
      manifest.queries,
    )
    : new Map<string, PhisAddonCompiledQuery>();
  compiledCatalogs.set(manifestDigest, compiled);
  return compiled;
}

export class PhisAddonQueryError extends Error {}

type Queryable = Pick<PoolClient, "query">;

type Bound = {
  manifest: PhisAddonManifestV1;
  catalog: Map<string, PhisAddonCompiledQuery>;
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
  args: PhisAddonQueryArguments,
  name: string,
  queryName: string,
) {
  if (!(name in args)) {
    throw new PhisAddonQueryError(`Query "${queryName}" needs an argument named "${name}".`);
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
  query: PhisAddonCompiledQuery,
  bindings: PhisAddonCompiledQuery["bindings"],
  bound: Bound,
  args: PhisAddonQueryArguments,
  descriptorParameters: { id?: string; group?: string },
  page: { size: number; keys: string[] },
) {
  return bindings.map((binding) => {
    switch (binding.from) {
      case "parameter": {
        const value = readArgument(args, binding.name, query.name);
        if (!binding.json || value === null) {
          return value;
        }
        // Serialised here rather than left to `pg`, which turns an object into JSON and an array into a
        // PostgreSQL array literal. `undefined` comes back for a value JSON cannot carry.
        const document = JSON.stringify(value);
        if (document === undefined) {
          throw new PhisAddonQueryError(
            `Query "${query.name}" was given a value for "${binding.name}" that is not a document.`,
          );
        }
        return document;
      }
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

function descriptorParametersFor(manifest: PhisAddonManifestV1, name: string) {
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
    alsoAllowedByRole: descriptor.alsoAllowedByRole,
    lists: (manifest.queries?.parameters[name] ?? [])
      .filter((parameter) => parameter.list === true)
      .map((parameter) => parameter.name),
  };
}

/**
 * The one argument a caller controls the size of.
 *
 * Everything else in this vocabulary is bounded by the descriptor: a page has a ceiling, a condition has
 * a fixed shape, a value is one value. A list is the exception, so it gets the bound here rather than
 * being trusted -- an unbounded list is the unbounded read paging removed, arriving through a parameter.
 *
 * Refused rather than shortened. A truncated list answers about some of the rows and reports it as an
 * answer about all of them, which is the failure the cursor exists to prevent in the other direction.
 */
function requireList(
  args: PhisAddonQueryArguments,
  name: string,
  queryName: string,
) {
  const value = args[name];
  if (value === undefined || value === null) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new PhisAddonQueryError(
      `Query "${queryName}" declares "${name}" as a list, and this call passed a single value.`,
    );
  }
  if (value.length > PHIS_ADDON_QUERY_MAX_LIST) {
    throw new PhisAddonQueryError(
      `Query "${queryName}" was given ${value.length} values for "${name}", ` +
      `and a list carries at most ${PHIS_ADDON_QUERY_MAX_LIST}.`,
    );
  }
}

function requireQuery(bound: Bound, name: string, kind: PhisAddonCompiledQuery["kind"]) {
  const query = bound.catalog.get(name);
  if (!query) {
    throw new PhisAddonQueryError(`No declared query named "${name}".`);
  }
  if (query.kind !== kind) {
    throw new PhisAddonQueryError(`Query "${name}" is a ${query.kind}, not a ${kind}.`);
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
  kind: PhisAddonCompiledQuery["kind"],
  args: PhisAddonQueryArguments,
  request: PhisAddonQueryPageRequest = {},
) {
  const query = requireQuery(bound, name, kind);
  const parameters = descriptorParametersFor(bound.manifest, name);

  for (const list of parameters.lists ?? []) {
    requireList(args, list, name);
  }

  if (bound.unauthenticated && kind !== "select" && kind !== "aggregate") {
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
    throw new PhisAddonQueryError(
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
      throw new PhisAddonQueryError(
        `Query "${name}" requires the role "${parameters.requiresRole}", which this actor does not hold.`,
      );
    }
  }

  if ((kind === "update" || kind === "delete") && query.scoped) {
    /*
     * Before the statement, never after: a refused write must not have happened.
     *
     * Only asked where there is something to ask about. A table with no owner and no group carries no
     * row authority, so the ladder answers no to every row in it -- and putting that question to it
     * anyway would make the role guard above decorative, allowing the attempt and then refusing it with
     * a silent zero. Such a table's writes must state a role, which validation enforces, and that role
     * is then the whole of the authority rather than half of it.
     */
    const id = readArgument(args, parameters.id!, name);
    if (!await bound.mayActOnRow({ table: query.table, id, intent: kind })) {
      /*
       * The declared bypass, and the only thing that is asked after the row rather than before it.
       *
       * Order is the whole of it. The role stands in for an authority the row did not grant, so it can
       * only be weighed once the row has answered -- ask it first and the owner's own path stops being
       * reachable without it. And the refusal stays the ladder's: a caller with neither the row nor the
       * role gets the same silent zero as before, because the alternative would turn a moderation query
       * into a way of asking whether a row exists.
       */
      if (!parameters.alsoAllowedByRole || !await bound.hasRole(parameters.alsoAllowedByRole)) {
        return { rows: [] as PhisAddonQueryRow[], rowCount: 0, cursor: null };
      }
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
      throw new PhisAddonQueryError(
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
      rows: result.rows as PhisAddonQueryRow[],
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
    ? decodePhisAddonCursor(name, paging.ordering, request.cursor)
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
  const raw = (result.rows as PhisAddonQueryRow[]).slice(0, size);
  const more = result.rows.length > size;
  const last = raw[raw.length - 1];
  const cursor = more && last
    ? encodePhisAddonCursor(
      name,
      paging.ordering,
      paging.ordering.map((_, index) => last[cursorColumnName(index)]),
    )
    : null;
  /*
   * The cursor columns are Core's and leave with Core. An Add-on that saw them would start reading
   * them, and then the way a cursor is carried would be part of the contract instead of an
   * implementation detail -- the same reason the cursor itself is opaque.
   */
  const rows = raw.map((row) => {
    const projected: Record<string, unknown> = { ...row };
    for (let index = 0; index < paging.ordering.length; index += 1) {
      delete projected[cursorColumnName(index)];
    }
    return projected as PhisAddonQueryRow;
  });
  return { rows, rowCount: rows.length, cursor };
}

function buildOperations(db: Queryable, bound: Bound): PhisDataTransactionV1 {
  return Object.freeze({
    async select(name, args = {}, page = {}) {
      const result = await run(db, bound, name, "select", args, page);
      return { rows: result.rows, cursor: result.cursor };
    },
    async aggregate(name, args = {}, page = {}) {
      const result = await run(db, bound, name, "aggregate", args, page);
      return { rows: result.rows, cursor: result.cursor };
    },
    async insert(name, args = {}) {
      return (await run(db, bound, name, "insert", args)).rows[0] ?? null;
    },
    async update(name, args = {}) {
      // The row as it stands after the write. A refusal comes back as an empty result and so answers
      // null, which is what a row that was never there answers too.
      return (await run(db, bound, name, "update", args)).rows[0] ?? null;
    },
    async delete(name, args = {}) {
      // The removed row, not a count. A refusal comes back as an empty result and so answers null, which
      // is what a row that was never there answers too.
      return (await run(db, bound, name, "delete", args)).rows[0] ?? null;
    },
  } satisfies PhisDataTransactionV1);
}

export function buildPhisAddonDataCapability(input: {
  manifest: PhisAddonManifestV1;
  manifestDigest: string;
  siteId: number;
  actorUserId: number | null;
  mayActOnRow: Bound["mayActOnRow"];
  mayUseGroup: Bound["mayUseGroup"];
  hasRole: Bound["hasRole"];
  unauthenticated: boolean;
}): PhisDataCapabilityV1 {
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
  } satisfies PhisDataCapabilityV1);
}
