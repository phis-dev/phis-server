import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getMethod: vi.fn() }));

vi.mock("@/db/site-auth", () => ({ getSiteAuthMethod: mocks.getMethod }));

import { isSitePasswordMethodEnabled } from "./password-method";

describe("isSitePasswordMethodEnabled", () => {
  beforeEach(() => {
    mocks.getMethod.mockReset();
  });

  it("asks for the password row itself, not the first enabled method", async () => {
    mocks.getMethod.mockResolvedValue({ enabled: true });
    expect(await isSitePasswordMethodEnabled(7)).toBe(true);
    expect(mocks.getMethod).toHaveBeenCalledWith(7, "password", "primary", null);
  });

  it("is closed when the row is off, and when there is no row", async () => {
    mocks.getMethod.mockResolvedValue({ enabled: false });
    expect(await isSitePasswordMethodEnabled(7)).toBe(false);
    mocks.getMethod.mockResolvedValue(null);
    expect(await isSitePasswordMethodEnabled(7)).toBe(false);
  });
});
