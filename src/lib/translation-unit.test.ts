import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PhisConfig } from "@/lib/config-core";

const mocks = vi.hoisted(() => ({ getPhisConfigSync: vi.fn() }));

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  getPhisConfigSync: mocks.getPhisConfigSync,
}));

const { requestPhisTranslationUnit } = await import("@/lib/translation-unit");

/*
 * The CDN step, which is a request to somebody else's installation and therefore the one request whose
 * shape this server does not get to choose. It is the public form of our own `/api/v1/tr`: a token, no
 * Site header, global messages only.
 *
 * It went out without a token for a while. Every mirror answered 403, `requestCdnTranslations` read that
 * as "not held here", and `cdn+deepl` was a `deepl` with a round trip in front of it -- which no test
 * caught because a refused step and an empty step fall through the same way.
 */
describe("the CDN step of cdn+deepl", () => {
  const configure = (config: Partial<PhisConfig>) => {
    mocks.getPhisConfigSync.mockReturnValue(config as PhisConfig);
  };

  const answerWith = (body: unknown, ok = true) => {
    const fetchMock = vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  const translate = (msgs: string[]) => requestPhisTranslationUnit({
    locale: "de",
    msgs,
    ctx: "",
    sourceLocale: "en",
    format: "text",
    audience: "platform",
  });

  beforeEach(() => {
    vi.clearAllMocks();
    configure({
      translation: { mode: "cdn+deepl", cdnBaseUrl: "https://cdn.phis.dev/" },
      api: { phisCdnPublicToken: "public-token" },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks the mirror with the public token this installation was given", async () => {
    const fetchMock = answerWith({ translations: ["eins", "zwei"] });

    await expect(translate(["one", "two"])).resolves.toMatchObject({
      translations: ["eins", "zwei"],
      succeeded: true,
      outcome: "translated",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cdn.phis.dev/api/v1/tr");
    expect(init.headers).toMatchObject({ "x-phis-token": "public-token" });
    expect(init.headers).not.toHaveProperty("x-phis-site-key");
  });

  it("asks without a token where none is configured, and takes the refusal as no answer", async () => {
    configure({ translation: { mode: "cdn+deepl", cdnBaseUrl: "https://cdn.phis.dev" } });
    const fetchMock = answerWith({ error: "Forbidden." }, false);

    // No DeepL key behind the step, so a refused CDN leaves an installation that translates nothing.
    await expect(translate(["one"])).resolves.toMatchObject({
      translations: ["one"],
      succeeded: false,
      outcome: "unconfigured",
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).not.toHaveProperty("x-phis-token");
  });

  it("does not take a batch the mirror answered with its own source text", async () => {
    answerWith({ translations: ["one"], provisional: true });

    await expect(translate(["one"])).resolves.toMatchObject({
      succeeded: false,
      outcome: "unconfigured",
    });
  });

  it("never shows a private text to the mirror", async () => {
    const fetchMock = answerWith({ translations: ["eins"] });

    await requestPhisTranslationUnit({
      locale: "de",
      msgs: ["one"],
      ctx: "",
      sourceLocale: null,
      format: "text",
      audience: "private",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
