import { afterEach, describe, expect, it } from "vitest";

import { isSameOriginRequest, readPhiClientIp } from "./request";

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
