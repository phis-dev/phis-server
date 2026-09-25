import { NextRequest, NextResponse } from "next/server";

import { readSiteAvailableLocales } from "@/db/sites";
import { requireSiteAuthenticatedApiContext } from "@/lib/guards/site-admin-api";
import { resolvePhisTranslationOffer } from "@/lib/translation-offer";

export const dynamic = "force-dynamic";

/**
 * Whether this installation translates for this Site, and into what.
 *
 * A Site asks once and decides whether a control may exist. Without it a surface either draws a translate
 * button that answers 409, or guesses from its own locales -- and the answer cannot be guessed, because
 * the mode, the key and the selected Provider are installation state no Site is shown.
 *
 * It says nothing about how the answer was reached: not the mode, not the Provider, and never a key. An
 * installation that swaps DeepL for an Add-on changes nothing a Site can observe, which is the point of
 * the mode being Core's business.
 *
 * Not in the capability snapshot, although a note once planned it there: that snapshot reports one verdict
 * per capability *provider*, and Core's is unconditionally available because Core is the server answering.
 * Translation is configuration rather than interface -- the same build translates or does not, depending
 * on what an operator saved -- and folding it in would have switched off every unrelated first-party
 * Module along with it.
 */
export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteAuthenticatedApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const offer = await resolvePhisTranslationOffer(await readSiteAvailableLocales(site.id));

  return NextResponse.json({ translation: offer });
}
