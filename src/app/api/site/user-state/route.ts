import { NextRequest, NextResponse } from "next/server";

import {
  PHIS_USER_STATE_MAX_SERIALIZED_BYTES,
  PHIS_USER_STATE_MAX_SET_LIMIT,
  isPhisUserStateKey,
  isPhisUserStateShape,
  readPhisUserStateWrite,
  type PhisUserStateShape,
  type PhisUserStateStoredValue,
  type PhisUserStateWriteShape,
} from "@phis/contracts/user-state";

import {
  clearPhiUserModuleStateKey,
  getPhiUserModuleState,
  setPhiUserModuleStateKey,
} from "@/db/user-site-memberships";
import {
  listPhiSiteActiveModuleIds,
  resolvePhiUserStateKeyOwner,
} from "@/db/site-active-modules";
import { requireSiteAuthenticatedApiContext } from "@/lib/guards/site-admin-api";
import { requireJsonObjectBody } from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

/**
 * What a Module may keep about the person asking, and nothing about anybody else.
 *
 * The user id is never read from the request, only from the session, which is what makes every route
 * here the actor's own. Authorization beyond that is the key's prefix: a key is `<module id>/<key>`, and
 * it may be written when an active Module of this Site owns that prefix. Nothing else is checked,
 * because there is nothing else to protect -- this holds somebody's own decisions, never a permission,
 * and a signed-in person writing their own preferences is the intended use rather than a threat.
 *
 * The shape travels with the write instead of being declared to this side. A Module calling one key a
 * flag today and a marker tomorrow corrupts only its own data, so the shape is checked for what it
 * promises (a marker never moves backwards, a set stays under its limit) and not for who said so.
 */
type UserStateWritePayload = {
  key?: unknown;
  shape?: unknown;
  value?: unknown;
  limit?: unknown;
};

function readWritePayload(body: Record<string, unknown>) {
  const { key, shape, value, limit } = body as UserStateWritePayload;
  if (!isPhisUserStateKey(key)) {
    return { issue: "key must be a `<module id>/<key>` identifier." as const };
  }
  if (!isPhisUserStateShape(shape)) {
    return { issue: "shape must be one of flag, marker, value, set." as const };
  }
  if (limit !== undefined && (!Number.isSafeInteger(limit) || (limit as number) <= 0)) {
    return { issue: "limit must be a positive integer." as const };
  }
  return { key, shape: shape as PhisUserStateShape, value, limit: limit as number | undefined };
}

/**
 * What this side checks against, taken from the write rather than from a declaration it does not have.
 *
 * `limit` is the one field that arrives from outside and therefore the one that is clamped: a Module may
 * keep its own set smaller than the ceiling, never larger.
 */
function describeWrite(shape: PhisUserStateShape, limit: number | undefined): PhisUserStateWriteShape {
  return shape === "set"
    ? { shape, limit: Math.min(limit ?? PHIS_USER_STATE_MAX_SET_LIMIT, PHIS_USER_STATE_MAX_SET_LIMIT) }
    : { shape };
}

/**
 * How much one Module's namespace would weigh once this write landed.
 *
 * Measured per Module rather than per key, because splitting a large value across ten keys is the
 * obvious way around a per-key limit. The row is read on its own by whoever renders with it, so the
 * ceiling protects that read rather than the session.
 */
function measureNamespaceBytes(
  state: Record<string, unknown>,
  ownerModuleId: string,
  key: string,
  nextValue: unknown,
) {
  const namespace: Record<string, unknown> = {};
  for (const [storedKey, storedValue] of Object.entries(state)) {
    if (storedKey !== key && storedKey.startsWith(`${ownerModuleId}/`)) {
      namespace[storedKey] = storedValue;
    }
  }
  if (nextValue !== undefined) {
    namespace[key] = nextValue;
  }
  return Buffer.byteLength(JSON.stringify(namespace), "utf8");
}

async function resolveActor(request: NextRequest) {
  const { context, error } = await requireSiteAuthenticatedApiContext(request);
  if (error || !context?.site || !context.session) {
    return {
      error: error ?? NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    };
  }
  return { site: context.site, session: context.session };
}

/** Everything this Site's active Modules kept about the person asking. */
export async function GET(request: NextRequest) {
  const actor = await resolveActor(request);
  if (actor.error) {
    return actor.error;
  }
  const { site, session } = actor;

  const [state, activeModuleIds] = await Promise.all([
    getPhiUserModuleState(session.userId, site.id),
    listPhiSiteActiveModuleIds(site.id),
  ]);
  if (!state) {
    return NextResponse.json({ state: {} });
  }

  /*
   * A Module that is switched off keeps what its users chose and stops being answered for. Filtering on
   * the way out rather than deleting is what makes switching one back on find the earlier answers.
   */
  const visible: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (resolvePhiUserStateKeyOwner(key, activeModuleIds)) {
      visible[key] = value;
    }
  }
  return NextResponse.json({ state: visible });
}

/** One key written, every other namespace on the row untouched. */
export async function PATCH(request: NextRequest) {
  const actor = await resolveActor(request);
  if (actor.error) {
    return actor.error;
  }
  const { site, session } = actor;

  const parsed = await requireJsonObjectBody(request, "A JSON object with a key and a shape is required.");
  if (!parsed.ok) {
    return parsed.response;
  }

  const payload = readWritePayload(parsed.body);
  if ("issue" in payload) {
    return NextResponse.json({ error: payload.issue }, { status: 400 });
  }
  const { key, shape, value, limit } = payload;

  const activeModuleIds = await listPhiSiteActiveModuleIds(site.id);
  const ownerModuleId = resolvePhiUserStateKeyOwner(key, activeModuleIds);
  if (!ownerModuleId) {
    return NextResponse.json(
      { error: "No active Module of this Site owns that key." },
      { status: 403 },
    );
  }

  const state = await getPhiUserModuleState(session.userId, site.id);
  if (!state) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const write = readPhisUserStateWrite(
    describeWrite(shape, limit),
    value,
    (state[key] ?? null) as PhisUserStateStoredValue | null,
  );
  if (!write) {
    return NextResponse.json({ error: `value does not match the ${shape} shape.` }, { status: 400 });
  }

  const bytes = measureNamespaceBytes(state, ownerModuleId, key, write.value);
  if (bytes > PHIS_USER_STATE_MAX_SERIALIZED_BYTES) {
    return NextResponse.json(
      {
        error: `${ownerModuleId} would keep ${bytes} bytes, above the ${PHIS_USER_STATE_MAX_SERIALIZED_BYTES} byte limit.`,
      },
      { status: 413 },
    );
  }

  const stored = await setPhiUserModuleStateKey(
    session.userId,
    site.id,
    key,
    write.value,
    { monotonic: shape === "marker" },
  );
  return NextResponse.json({ key, value: stored });
}

/**
 * One key removed, which is not the same as writing a falsy value.
 *
 * An absent key reads as "never decided", and a Site offering somebody a way back -- showing a dismissed
 * card again -- needs that state rather than a `false` that means the same only by convention.
 */
export async function DELETE(request: NextRequest) {
  const actor = await resolveActor(request);
  if (actor.error) {
    return actor.error;
  }
  const { site, session } = actor;

  const key = request.nextUrl.searchParams.get("key")?.trim() ?? "";
  if (!isPhisUserStateKey(key)) {
    return NextResponse.json(
      { error: "key must be a `<module id>/<key>` identifier." },
      { status: 400 },
    );
  }

  const activeModuleIds = await listPhiSiteActiveModuleIds(site.id);
  if (!resolvePhiUserStateKeyOwner(key, activeModuleIds)) {
    return NextResponse.json(
      { error: "No active Module of this Site owns that key." },
      { status: 403 },
    );
  }

  const cleared = await clearPhiUserModuleStateKey(session.userId, site.id, key);
  return cleared
    ? NextResponse.json({ key, cleared: true })
    : NextResponse.json({ error: "Authentication required." }, { status: 401 });
}
