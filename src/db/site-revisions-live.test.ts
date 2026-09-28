import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getPool: vi.fn() }));

import { isLiveScopeRevision, type ResolvedRevisionScope } from "./site-revisions";

const area = {
  kind: "area",
  areaMask: 1,
  sourcePreset: {} as never,
  scopeId: 3,
  publishedRevisionId: 10,
  workingDraftRevisionId: 11,
  workingModuleDraftRevisionId: 12,
} satisfies ResolvedRevisionScope;

describe("which revisions history may not delete", () => {
  it("keeps an Area's Module draft, the third pointer an Area has", () => {
    expect(isLiveScopeRevision(area, 12)).toBe(true);
  });

  it("keeps the published revision and the working draft of every scope", () => {
    expect(isLiveScopeRevision(area, 10)).toBe(true);
    expect(isLiveScopeRevision(area, 11)).toBe(true);
    const page = {
      kind: "page", areaMask: 1, address: {} as never, scopeId: 4,
      publishedRevisionId: 20, workingDraftRevisionId: 21,
    } satisfies ResolvedRevisionScope;
    expect(isLiveScopeRevision(page, 21)).toBe(true);
  });

  it("lets a revision nothing points at go", () => {
    expect(isLiveScopeRevision(area, 9)).toBe(false);
  });
});
