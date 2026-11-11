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

/*
 * The address form DeepL is asked for. One per installation, because the global store is every Site's:
 * left to DeepL, a page read "Sie" in one sentence and "du" in the next.
 */
describe("the DeepL step's address form", () => {
  const translateWith = async (formality?: "prefer_more" | "prefer_less") => {
    mocks.getPhisConfigSync.mockReturnValue({
      translation: { mode: "deepl" },
      deepl: { apiKey: "key", ...(formality ? { formality } : {}) },
    } as PhisConfig);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ translations: [{ text: "Hallo", detected_source_language: "EN" }] }),
    }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    await requestPhisTranslationUnit({
      locale: "de",
      msgs: [`Hello ${formality ?? "default"}`],
      ctx: "",
      sourceLocale: "en",
      format: "text",
      audience: "platform",
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    return new URLSearchParams(String(init.body));
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks for the configured form", async () => {
    expect((await translateWith("prefer_more")).get("formality")).toBe("prefer_more");
  });

  it("leaves the form to DeepL where none is configured", async () => {
    expect((await translateWith()).has("formality")).toBe(false);
  });
});

/*
 * A spent character quota (HTTP 456). It used to open no breaker at all, so every render of a page with
 * untranslated labels asked DeepL again and was refused again, for as long as the quota stayed spent.
 */
describe("a DeepL account whose quota is used up", () => {
  const translate = (msg: string) => requestPhisTranslationUnit({
    locale: "de",
    msgs: [msg],
    ctx: "",
    sourceLocale: "en",
    format: "text",
    audience: "platform",
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Only the clock, and set in the past: the breaker this leaves open has run out before any other test asks.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2001-01-01T00:00:00Z") });
    mocks.getPhisConfigSync.mockReturnValue({ translation: { mode: "deepl" }, deepl: { apiKey: "key" } } as PhisConfig);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("is not asked again for an hour, and is asked again after it", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 456, text: async () => "Quota exceeded" }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(translate("Quota one")).resolves.toMatchObject({ succeeded: false, translations: ["Quota one"] });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2001-01-01T00:59:00Z"));
    await expect(translate("Quota two")).resolves.toMatchObject({ succeeded: false, translations: ["Quota two"] });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2001-01-01T01:00:01Z"));
    await translate("Quota three");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
