import { afterEach, describe, expect, it } from "vitest";

import { toPhiRecord } from "./record";
import {
  isSameOriginRequest,
  normalizeNullableInteger,
  normalizePositiveIdArray,
  parsePhiPagination,
  PHI_MAX_PAGE_SIZE,
  readPhiClientIp,
  requireJsonObjectBody,
} from "./request";

/**
 * The address a rate limit is keyed on, against a caller who writes the header themselves.
 *
 * Every case here is one an ordinary reverse proxy produces: it appends what it saw to whatever
 * arrived, so a forged entry and an observed one differ only by position.
 */

function request(headers: Record<string, string>) {
  return { headers: new Headers(headers) };
}

const original = process.env.TRUST_PROXY;

afterEach(() => {
  if (original === undefined) {
    delete process.env.TRUST_PROXY;
  } else {
    process.env.TRUST_PROXY = original;
  }
});

describe("behind one proxy", () => {
  it("reads the address that proxy observed", () => {
    process.env.TRUST_PROXY = "true";
    expect(readPhiClientIp(request({ "x-forwarded-for": "198.51.100.7" }))).toBe("198.51.100.7");
  });

  it("steps over an entry the caller wrote themselves", () => {
    process.env.TRUST_PROXY = "true";
    // What nginx produces when the caller sent "203.0.113.45": their claim, then what it saw.
    const ip = readPhiClientIp(request({ "x-forwarded-for": "203.0.113.45, 198.51.100.7" }));
    expect(ip).toBe("198.51.100.7");
  });

  it("falls back to x-real-ip only where there is no list", () => {
    process.env.TRUST_PROXY = "true";
    expect(readPhiClientIp(request({ "x-real-ip": "198.51.100.7" }))).toBe("198.51.100.7");
  });
});

describe("behind two proxies", () => {
  it("counts from the right, so a CDN hop is not mistaken for the client", () => {
    process.env.TRUST_PROXY = "2";
    const ip = readPhiClientIp(request({ "x-forwarded-for": "198.51.100.7, 203.0.113.9" }));
    expect(ip).toBe("198.51.100.7");
  });

  it("still steps over a forged entry", () => {
    process.env.TRUST_PROXY = "2";
    const ip = readPhiClientIp(request({
      "x-forwarded-for": "203.0.113.45, 198.51.100.7, 203.0.113.9",
    }));
    expect(ip).toBe("198.51.100.7");
  });

  it("refuses a chain shorter than the hops it claims", () => {
    process.env.TRUST_PROXY = "2";
    expect(readPhiClientIp(request({ "x-forwarded-for": "198.51.100.7" }))).toBeNull();
  });
});

describe("behind nothing", () => {
  it("ignores both headers, because either would be the caller's own", () => {
    process.env.TRUST_PROXY = "false";
    const ip = readPhiClientIp(request({
      "x-forwarded-for": "203.0.113.45",
      "x-real-ip": "203.0.113.45",
    }));
    expect(ip).toBeNull();
  });
});

describe("the setting itself", () => {
  it("reads an absent value as the one proxy this ships with", () => {
    delete process.env.TRUST_PROXY;
    const ip = readPhiClientIp(request({ "x-forwarded-for": "203.0.113.45, 198.51.100.7" }));
    expect(ip).toBe("198.51.100.7");
  });

  it("treats a value it cannot read as one rather than as none", () => {
    process.env.TRUST_PROXY = "yes please";
    expect(readPhiClientIp(request({ "x-forwarded-for": "198.51.100.7" }))).toBe("198.51.100.7");
  });

  it("returns nothing when no header carries an address", () => {
    process.env.TRUST_PROXY = "true";
    expect(readPhiClientIp(request({}))).toBeNull();
  });
});

describe("isSameOriginRequest", () => {
  it("trusts Sec-Fetch-Site where the browser sends it", () => {
    expect(isSameOriginRequest(request({ "sec-fetch-site": "same-origin" }))).toBe(true);
    const crossSite = { "sec-fetch-site": "cross-site", origin: "https://a.test", host: "a.test" };
    expect(isSameOriginRequest(request(crossSite))).toBe(false);
    expect(isSameOriginRequest(request({ "sec-fetch-site": "same-site" }))).toBe(false);
  });

  it("falls back to an Origin that names the addressed host, and refuses a request with neither", () => {
    const own = { origin: "https://setup.test:52030", host: "setup.test:52030" };
    expect(isSameOriginRequest(request(own))).toBe(true);
    const foreign = { origin: "https://evil.test", host: "setup.test" };
    expect(isSameOriginRequest(request(foreign))).toBe(false);
    expect(isSameOriginRequest(request({ origin: "null", host: "setup.test" }))).toBe(false);
    expect(isSameOriginRequest(request({ host: "setup.test" }))).toBe(false);
  });
});

describe("submitted numbers and lists", () => {
  it("reads a whole number from a number or from nothing but its digits", () => {
    expect(normalizeNullableInteger(7)).toBe(7);
    expect(normalizeNullableInteger(" -3 ")).toBe(-3);
    expect(normalizeNullableInteger("12abc")).toBeNull();
    expect(normalizeNullableInteger(1.5)).toBeNull();
    expect(normalizeNullableInteger("")).toBeNull();
    expect(normalizeNullableInteger(null)).toBeNull();
  });

  it("keeps the positive ids of a list, whether sent as numbers or as a Select's strings", () => {
    expect(normalizePositiveIdArray([3, "4", " 5 ", 0, -1, "6x", 1.5, null])).toEqual([3, 4, 5]);
    expect(normalizePositiveIdArray("3")).toEqual([]);
  });

  it("reads a record and nothing that only looks like one", () => {
    expect(toPhiRecord({ a: 1 })).toEqual({ a: 1 });
    expect(toPhiRecord([1])).toEqual({});
    expect(toPhiRecord("x")).toEqual({});
    expect(toPhiRecord(null)).toEqual({});
  });
});

describe("a JSON object body", () => {
  const post = (body: string) => new Request("https://server.test/", { method: "POST", body });

  it("hands over an object", async () => {
    const parsed = await requireJsonObjectBody(post('{"a":1}'));
    expect(parsed.ok && parsed.body).toEqual({ a: 1 });
  });

  it.each(["[1]", "3", "null", "{"])("refuses %s with a 400 in the route's own words", async (body) => {
    const parsed = await requireJsonObjectBody(post(body), "Invalid thing.");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.response.status).toBe(400);
      expect(await parsed.response.json()).toEqual({ error: "Invalid thing." });
    }
  });
});

describe("a list's page", () => {
  it("starts at the first page of the default size", () => {
    expect(parsePhiPagination(new URLSearchParams())).toEqual({ page: 1, pageSize: 25 });
  });

  it("caps what a caller asks for", () => {
    const params = new URLSearchParams({ page: "3", pageSize: "5000" });
    expect(parsePhiPagination(params)).toEqual({ page: 3, pageSize: PHI_MAX_PAGE_SIZE });
  });
});
