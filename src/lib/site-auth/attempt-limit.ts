import "server-only";

import { NextResponse } from "next/server";

import { readPhiClientIp } from "@/lib/helpers/request";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * How many guesses a minute one subject gets at a credential.
 *
 * `/api/v1/auth/*` is reached with the internal token, and the internal token is exempt from the
 * per-address limit in `guardApiV1` -- rightly, because that limit measures a Site runtime, not the
 * person behind it. So nothing measured the person: a password, a TOTP code or a reset request could be
 * tried as fast as the wire allowed, and six digits at a hundred a second is an hour's work.
 *
 * Keyed on what is being guessed at rather than on where from. The address is added where a trusted
 * proxy hands one over, but it is never the only key: with no trusted hop there is no address, and a
 * limit that then shared one bucket among everybody would lock the Site's door for all of them at once.
 */
export const AUTH_ATTEMPTS_PER_MINUTE = 10;

export async function checkAuthAttemptLimit(
  request: { headers: Headers },
  keys: readonly string[],
  limit = AUTH_ATTEMPTS_PER_MINUTE,
) {
  const address = readPhiClientIp(request);
  const subjects = address ? [...keys, `${keys[0]}@${address}`] : [...keys];
  let retryAfter: number | null = null;
  for (const subject of subjects) {
    const answer = await checkRateLimit(`auth-attempt:${subject}`, limit);
    if (answer !== null && (retryAfter === null || answer > retryAfter)) {
      retryAfter = answer;
    }
  }
  return retryAfter;
}

export function tooManyAttemptsResponse(retryAfter: number) {
  return NextResponse.json(
    { code: "too_many_attempts", error: "Too many attempts. Try again later." },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}
