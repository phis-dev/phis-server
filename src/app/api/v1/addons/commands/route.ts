import { NextResponse, type NextRequest } from "next/server";

import { guardApiV1 } from "@/lib/api-v1-guard";
import { getPhiCliSiteByKey } from "@/db/cli-sites.mts";
import { getUserAccountByEmail, getUserAccountById } from "@/db/user-accounts";
import { getPool } from "@/lib/db";
import { PhisAddonCommandError, runPhisAddonCommand } from "@/lib/addons/commands";
import { PhiUserAccountFlag } from "@/lib/constants/user-account-flags";
import { logRuntimeEvent } from "@/lib/log";

export const dynamic = "force-dynamic";

/** One command's input is a JSON document an operator wrote, not an upload. */
const PHIS_ADDON_COMMAND_BODY_LIMIT_BYTES = 1_048_576;

/**
 * Running one declared command now, as one member of the Site (SERVER_ADDONS.md, Commands).
 *
 * `phis addon command` posts here for the reason `phis addon job` posts to `/api/v1/addons/jobs`: the
 * Add-on is loaded in the serving process, against the release it actually serves, and the CLI stays a
 * caller. Internal token only. That is what makes naming the person safe -- only the operator holds the
 * token, and the operator can already make anybody anything on this stage. A request reaching an
 * Add-on's own routes can never get here, so an Add-on cannot use this to act as somebody else.
 *
 * `as` is an address or an account id, and it must be a member of the Site and not disabled: a person
 * who cannot sign in here is a person who could not have done this in the browser either.
 */
export async function POST(request: NextRequest) {
  const guardError = await guardApiV1(request, { requireInternalToken: true });
  if (guardError) {
    return guardError;
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > PHIS_ADDON_COMMAND_BODY_LIMIT_BYTES) {
    return NextResponse.json({ error: "The command input is too large." }, { status: 413 });
  }
  const body = await request.json().catch(() => null) as {
    addonId?: unknown;
    commandId?: unknown;
    siteKey?: unknown;
    as?: unknown;
    input?: unknown;
  } | null;
  if (
    typeof body?.addonId !== "string" || typeof body.commandId !== "string"
    || typeof body.siteKey !== "string" || typeof body.as !== "string"
  ) {
    return NextResponse.json({ error: "addonId, commandId, siteKey and as are required." }, { status: 400 });
  }

  const site = await getPhiCliSiteByKey(getPool(), body.siteKey.trim().toLowerCase());
  if (!site) {
    return NextResponse.json({ error: "site_not_found" }, { status: 404 });
  }
  const who = body.as.trim();
  const account = /^\d+$/.test(who)
    ? await getUserAccountById(Number(who), site.id)
    : await getUserAccountByEmail(who, site.id);
  if (!account || !account.siteIds.includes(site.id)) {
    return NextResponse.json({ error: `${who} is not a member of ${site.key}.` }, { status: 404 });
  }
  if ((account.flags & PhiUserAccountFlag.Disabled) !== 0) {
    return NextResponse.json({ error: `${who} is disabled.` }, { status: 409 });
  }

  try {
    const outcome = await runPhisAddonCommand({
      addonId: body.addonId,
      commandId: body.commandId,
      site: { id: site.id, key: site.key, publicBaseUrl: site.publicBaseUrl, timeZone: site.timeZone },
      actorUserId: account.id,
      input: body.input ?? null,
      signal: request.signal,
    });
    const answer = {
      addonId: body.addonId,
      commandId: body.commandId,
      siteKey: site.key,
      actor: { id: account.id, email: account.emailNormalized },
      ...outcome,
    };
    logRuntimeEvent(outcome.ok ? "info" : "warn", outcome.ok ? "addon.command.ran" : "addon.command.failed", {
      message: outcome.ok ? undefined : outcome.error,
      siteKey: site.key,
      pluginKey: body.addonId,
      meta: { commandId: body.commandId, runId: outcome.runId, actorUserId: account.id },
    });
    // A command that ran and refused is the Add-on saying no to this input, not a fault of Core's.
    return NextResponse.json(answer, { status: outcome.ok ? 200 : 422 });
  } catch (error) {
    if (error instanceof PhisAddonCommandError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
