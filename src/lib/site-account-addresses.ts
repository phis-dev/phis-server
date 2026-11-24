import "server-only";

import { NextResponse } from "next/server";

import { createPhisSiteAddress, PhisSiteUsersError } from "@/db/site-users";
import { readRequestBody } from "@/lib/helpers/request";
import { PhisSiteAddressInputError, readPhisSiteAddressFlags, readPhisSiteAddressInput } from "@/lib/site-address-input";

/**
 * Writing one of the signed-in person's addresses on the Site, for `POST /api/site/account/addresses` (a new
 * one) and `PUT /api/site/account/addresses/{id}` (a new version of `replaces`): `{ address, flags }` read by
 * the rule `users:v1` holds an Add-on to. Not handed to an Add-on, so not marked handed out; the person's
 * `user.changed` with `address` is owed where a version replaced their current one.
 */
export async function writeSiteAccountAddress(request: Request, input: {
  siteId: number;
  userId: number;
  replaces: number | null;
}) {
  const body = await readRequestBody(request);
  let address;
  let flags;
  try {
    address = readPhisSiteAddressInput(body.address);
    flags = readPhisSiteAddressFlags(body.flags);
  } catch (error) {
    if (error instanceof PhisSiteAddressInputError) {
      return NextResponse.json({ error: `The address is refused: ${error.message}` }, { status: 400 });
    }
    throw error;
  }
  try {
    const written = await createPhisSiteAddress({
      siteId: input.siteId,
      userId: input.userId,
      address,
      flags,
      replaces: input.replaces,
      handedOut: false,
    });
    return NextResponse.json(written, { status: input.replaces == null ? 201 : 200 });
  } catch (error) {
    if (error instanceof PhisSiteUsersError) {
      return NextResponse.json({ error: "No current address of yours has this id." }, { status: 404 });
    }
    throw error;
  }
}

/** A positive whole number from a path segment, or null. */
export function readPhisPathId(raw: string): number | null {
  if (!/^[1-9]\d{0,9}$/u.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id <= 2_147_483_647 ? id : null;
}
