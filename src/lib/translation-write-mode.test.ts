import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PhisConfig } from "@/lib/config-core";

const mocks = vi.hoisted(() => ({ getPhisConfigSync: vi.fn() }));

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  getPhisConfigSync: mocks.getPhisConfigSync,
}));

const { resolvePhisTranslationWriteMode, PHIS_TRANSLATION_WRITE_WINDOW_MAX_MS } =
  await import("@/lib/translation-write-mode");

/*
 * Which of the two rights a request carries, which is the whole reason they were separated.
 *
 * `allowPublicWrites` used to grant both at once: filling a translation for a message the catalogue
 * holds, and putting a message in `tr_msg` that nobody here has seen. The first is what an installation
 * asking a mirror needs and may stand open; the second is what an application outside the platform
 * needs, and it is open only inside a window somebody opened on purpose.
 */
describe("what a request may write to the global store", () => {
  const NOW = Date.parse("2026-09-27T10:00:00.000Z");

  const configure = (translation: PhisConfig["translation"]) => {
    mocks.getPhisConfigSync.mockReturnValue({ translation } as PhisConfig);
  };

  const inMinutes = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lets the platform itself do both, whatever the flags say", () => {
    configure({ allowPublicWrites: false });

    expect(resolvePhisTranslationWriteMode({ tokenMode: "internal", named: false, now: NOW }))
      .toBe("extend");
  });

  it("writes nothing for a public caller where writing is off", () => {
    configure({ allowPublicWrites: false, allowPublicWritesUntil: inMinutes(5) });

    expect(resolvePhisTranslationWriteMode({ tokenMode: "public", named: true, now: NOW }))
      .toBe("none");
  });

  it("fills the catalogue for a public caller and does not extend it", () => {
    configure({ allowPublicWrites: true });

    expect(resolvePhisTranslationWriteMode({ tokenMode: "public", named: false, now: NOW }))
      .toBe("fill");
    // Named, but nobody opened a window: an application may still fill what is already there.
    expect(resolvePhisTranslationWriteMode({ tokenMode: "public", named: true, now: NOW }))
      .toBe("fill");
  });

  it("extends only for an application, and only while the window stands open", () => {
    configure({ allowPublicWrites: true, allowPublicWritesUntil: inMinutes(5) });

    expect(resolvePhisTranslationWriteMode({ tokenMode: "public", named: true, now: NOW }))
      .toBe("extend");
    // An open window is not a general licence: without a name there is no space to extend into.
    expect(resolvePhisTranslationWriteMode({ tokenMode: "public", named: false, now: NOW }))
      .toBe("fill");
  });

  it("closes the window by reading it, not by being switched off", () => {
    configure({ allowPublicWrites: true, allowPublicWritesUntil: inMinutes(-1) });

    expect(resolvePhisTranslationWriteMode({ tokenMode: "public", named: true, now: NOW }))
      .toBe("fill");
  });

  it("treats a timestamp it cannot read as closed", () => {
    configure({ allowPublicWrites: true, allowPublicWritesUntil: "soon" });

    expect(resolvePhisTranslationWriteMode({ tokenMode: "public", named: true, now: NOW }))
      .toBe("fill");
  });

  it("keeps the window's own ceiling at ten minutes", () => {
    // The cap is enforced where the timestamp is written; this pins the number that action uses.
    expect(PHIS_TRANSLATION_WRITE_WINDOW_MAX_MS).toBe(600_000);
  });
});
