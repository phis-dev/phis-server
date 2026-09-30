import { isPhisCmsAreaKey } from "@/lib/constants/cms-areas";
import { PHIS_AREA_HEADER } from "@/lib/constants/http-headers";

/**
 * The shell a media call came from, which only the Client can say, or null for anything that is not an
 * Area of a Site.
 *
 * It is recorded against log events and nothing more, so an unknown or absent header is simply not
 * named. Four media routes each kept this as a private pair of functions.
 */
export function readPhisMediaRequestArea(request: { headers: Headers }) {
  const normalized = request.headers.get(PHIS_AREA_HEADER)?.trim().toLowerCase() ?? "";
  return isPhisCmsAreaKey(normalized) ? normalized : null;
}
