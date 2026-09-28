import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getPool: vi.fn() }));

import { PhisThreadAttachmentError, PhisThreadError } from "./threads";

describe("a refused attachment", () => {
  // The routes answer `PhisThreadError` with a 400; an attachment refusal outside that family was a 500.
  it("is a refused thread write", () => {
    expect(new PhisThreadAttachmentError("no")).toBeInstanceOf(PhisThreadError);
  });
});
