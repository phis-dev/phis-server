import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({ isBootstrapEnabled: () => true }));

import { POST } from "./route";

function post(headers: Record<string, string>) {
  return POST(new Request("http://setup.test/api/setup/runtime-check", {
    method: "POST",
    headers: { "content-type": "application/json", host: "setup.test", ...headers },
    // An id no check has, so a request that gets past the origin check is answered without acting.
    body: JSON.stringify({ checkId: "nonesuch" }),
  }));
}

/**
 * Two of the checks act -- a probe file, a CLI run -- so only the setup page may set them off.
 */
describe("runtime check route", () => {
  it("refuses a request the browser reports as cross-site", async () => {
    expect((await post({ "sec-fetch-site": "cross-site" })).status).toBe(403);
  });

  it("refuses a request that says nothing about where it came from", async () => {
    expect((await post({})).status).toBe(403);
  });

  it("answers the setup page itself", async () => {
    expect((await post({ "sec-fetch-site": "same-origin" })).status).toBe(400);
    expect((await post({ origin: "http://setup.test" })).status).toBe(400);
  });
});
