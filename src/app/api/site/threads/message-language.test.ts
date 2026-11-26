import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ create: vi.fn(), add: vi.fn() }));

vi.mock("@/lib/guards/site-admin-api", () => ({
  requireSiteAuthenticatedApiContext: async () => ({
    context: { site: { id: 1, key: "acme" }, session: { userId: 7 } },
    error: null,
  }),
}));
// The writes are stood in for; the normalizer is the real one, because how it reads a body is under test.
vi.mock("@/db/threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db/threads")>()),
  createThread: mocks.create,
  addThreadMessage: mocks.add,
}));

import { POST as createThreadRoute } from "./route";
import { POST as replyByBody } from "./messages/route";
import { POST as replyByPath } from "./[threadId]/messages/route";

function post(path: string, body: Record<string, unknown>) {
  return new NextRequest(`https://server.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const opening = { kind: 1, subject: "Rechnung", message: "Hallo." };

const writes = [
  {
    name: "opening a conversation",
    send: (extra: Record<string, unknown>) => createThreadRoute(post("/api/site/threads", { ...opening, ...extra })),
    written: () => mocks.create,
  },
  {
    name: "a reply or a note, addressed in the body (the Form's shape)",
    send: (extra: Record<string, unknown>) =>
      replyByBody(post("/api/site/threads/messages", { threadId: 5, message: "Hallo.", ...extra })),
    written: () => mocks.add,
  },
  {
    name: "a reply or a note, addressed in the path",
    send: (extra: Record<string, unknown>) =>
      replyByPath(post("/api/site/threads/5/messages", { message: "Hallo.", ...extra }), {
        params: Promise.resolve({ threadId: "5" }),
      }),
    written: () => mocks.add,
  },
] as const;

/**
 * The language a person declares beside what they write, on every Site route that writes a message.
 *
 * Optional, resolved through the platform capability table on the way in, and refused -- never quietly
 * dropped -- where it is no key that table knows.
 */
describe.each(writes)("the declared message language, $name", ({ send, written }) => {
  beforeEach(() => {
    mocks.create.mockResolvedValue({ thread: { id: 5, kind: 1 } });
    mocks.add.mockResolvedValue({ thread: { id: 5, kind: 1 } });
  });

  it("stores what was declared, resolved to the table's own key", async () => {
    for (const [sent, stored] of [["de", "de"], ["de_DE", "de-DE"], ["zh-CN", "zh-Hans"], [" pt-br ", "pt-BR"]]) {
      written().mockClear();
      expect((await send({ sourceLang: sent })).status).toBe(201);
      expect(written()).toHaveBeenCalledWith(expect.objectContaining({ messageSourceLang: stored }));
    }
  });

  it("declares nothing where nothing, null or an empty string was sent", async () => {
    for (const extra of [{}, { sourceLang: null }, { sourceLang: "" }, { sourceLang: "  " }]) {
      written().mockClear();
      expect((await send(extra)).status).toBe(201);
      expect(written()).toHaveBeenCalledWith(expect.objectContaining({ messageSourceLang: null }));
    }
  });

  it("refuses a value that is no locale key, before anything is written", async () => {
    for (const sourceLang of ["xx", "klingon", 49, true, ["de"], { code: "de" }]) {
      const response = await send({ sourceLang });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/language/u);
    }
    expect(written()).not.toHaveBeenCalled();
  });
});
