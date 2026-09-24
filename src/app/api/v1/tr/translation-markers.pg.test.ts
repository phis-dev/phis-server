import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * Through the endpoints a Site actually calls, against the development database: `/api/v1/tr` fills and
 * answers, `/api/v1/site` hands out the change markers. Only what does not belong in a test is replaced
 * -- the token guard, and the translation provider, which stands in on a stubbed `fetch` so no request
 * leaves the process.
 *
 * The mode is `deepl` pointed at an unroutable host. It used to be `custom`, a mode that no longer
 * exists: an endpoint speaking our own request shape was replaced by the `add-on` service kind, and this
 * file kept testing the path that went with it. Which provider answers is beside the point here -- what
 * is under test is what the store and the markers do with a translation that arrives, is edited, is
 * deleted, or fails -- so it uses the one mode that reaches a provider today.
 */

const PROVIDER = "https://translation-provider.invalid/translate";

vi.mock("@/lib/api-v1-guard", () => ({
  guardApiV1: () => null,
  getApiV1TokenMode: () => "internal",
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/config")>();
  const withStubbedProvider = () => {
    const config = original.getPhisConfigSync();
    return {
      ...config,
      translation: {
        ...config.translation,
        mode: "deepl" as const,
        supportedLocales: ["en", "de"],
      },
      // A key has to be present or the unit answers `unconfigured` before it ever calls out, and the
      // URL is what the `fetch` stub below recognizes.
      deepl: { apiKey: "test-key", apiUrl: PROVIDER },
    };
  };
  return {
    ...original,
    getPhisConfigSync: withStubbedProvider,
    getPhisConfig: async () => withStubbedProvider(),
  };
});

import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../../../../test/pg/harness";
import { SITE_FLAG_ACTIVE } from "@/lib/site-flags";
import { GET as getSite } from "../site/route";
import { POST as translate } from "./route";

describe("translation change markers through /api/v1/tr and /api/v1/site", () => {
  let site: PhiTestSite;
  const provider = vi.fn<(msgs: string[]) => Response>();
  const realFetch = globalThis.fetch;

  function headers() {
    return { "x-phis-site-key": site.key, "content-type": "application/json" };
  }

  async function markers(): Promise<{ global: string; site: string }> {
    const response = await getSite(new Request("http://phis.test/api/v1/site", { headers: headers() }));
    expect(response.status).toBe(200);
    return (await response.json()).site.translationMarkers;
  }

  async function tr(msg: string): Promise<{ translations: string[]; provisional?: boolean }> {
    const response = await translate(new Request("http://phis.test/api/v1/tr", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ locale: "de", msgs: [msg], ctx: "Web UI label" }),
    }));
    expect(response.status).toBe(200);
    return response.json();
  }

  async function storedTranslation(msg: string) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ id: number; msg_id: number; translation: string }>(
      `SELECT lang.id, lang.msg_id, lang.translation
       FROM phis.tr_site_lang lang
       JOIN phis.tr_site_msg msg ON msg.id = lang.msg_id
       WHERE msg.site_id = $1 AND msg.msg = $2 AND lang.locale = 'de'`,
      [site.id, msg],
    );
    return rows[0] ?? null;
  }

  beforeAll(async () => {
    await dropPhiTestSites();
    site = await createPhiTestSite("tr-endpoint-markers");
    // The endpoints resolve only an active Site; the harness creates them inactive.
    const pool = await requirePhiTestDatabase();
    await pool.query("UPDATE phis.sites SET flags = flags | $2 WHERE id = $1", [site.id, SITE_FLAG_ACTIVE]);
    /*
     * Speaks DeepL on the wire and plain arrays to the tests.
     *
     * The stub translates between the two so each case can stay a one-liner: it unpacks the form-encoded
     * `text` parameters, hands them to `provider` as strings, and wraps whatever comes back into DeepL's
     * `{ translations: [{ text }] }`. A failure response is passed through untouched, which is the whole
     * point of the outage case.
     */
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) !== PROVIDER) {
        return realFetch(input, init);
      }
      const answer = provider(new URLSearchParams(String(init?.body)).getAll("text"));
      if (!answer.ok) {
        return answer;
      }
      const { translations } = await answer.json() as { translations: string[] };
      return Response.json({ translations: translations.map((text) => ({ text })) });
    }) as typeof fetch;
  });

  afterEach(() => {
    provider.mockReset();
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("fills a new message without moving a marker", async () => {
    provider.mockImplementation((msgs) => Response.json({ translations: msgs.map((msg) => `DE ${msg}`) }));
    const before = await markers();

    expect(await tr("Fill probe")).toEqual({ translations: ["DE Fill probe"] });

    expect((await storedTranslation("Fill probe"))?.translation).toBe("DE Fill probe");
    expect(await markers()).toEqual(before);
  });

  it("moves only the Site marker when exactly that translation is changed, and answers the change", async () => {
    provider.mockImplementation((msgs) => Response.json({ translations: msgs.map((msg) => `DE ${msg}`) }));
    await tr("Edit probe");
    const stored = await storedTranslation("Edit probe");
    const before = await markers();

    const pool = await requirePhiTestDatabase();
    await pool.query("UPDATE phis.tr_site_lang SET translation = 'Von Hand' WHERE id = $1", [stored!.id]);

    const after = await markers();
    expect(after.site).not.toBe(before.site);
    expect(after.global).toBe(before.global);
    expect(await tr("Edit probe")).toEqual({ translations: ["Von Hand"] });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("moves the Site marker when the message goes, translations and all", async () => {
    provider.mockImplementation((msgs) => Response.json({ translations: msgs.map((msg) => `DE ${msg}`) }));
    await tr("Delete probe");
    const stored = await storedTranslation("Delete probe");
    const before = await markers();

    const pool = await requirePhiTestDatabase();
    await pool.query("DELETE FROM phis.tr_site_msg WHERE id = $1", [stored!.msg_id]);

    expect((await markers()).site).not.toBe(before.site);
  });

  it("marks a provider failure provisional, stores nothing and moves no marker", async () => {
    // 502 and not 503: the unit opens its circuit breaker for thirty seconds on 429, 500 and 503, and a
    // test that leaves module state behind decides the outcome of whatever runs next. Any `!ok` fails
    // the request, so the case is unchanged.
    provider.mockImplementation(() => new Response("unavailable", { status: 502 }));
    const before = await markers();

    expect(await tr("Outage probe")).toEqual({ translations: ["Outage probe"], provisional: true });

    expect(await storedTranslation("Outage probe")).toBeNull();
    expect(await markers()).toEqual(before);
  });
});
