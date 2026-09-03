import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

/**
 * The authority matrix for one existing Asset, cell by cell.
 *
 * This is the whole reason `owner_user_id` exists as a column of its own, so it is worth stating as a
 * table rather than as prose: an Author reaches what is theirs, an Editor reaches what anyone wrote,
 * and removing someone else's work stays a Manager act.
 */

const mocks = vi.hoisted(() => ({
  mediaAuthority: vi.fn(),
  authenticated: vi.fn(),
  asset: vi.fn(),
  space: vi.fn(),
  flags: vi.fn(),
}));

vi.mock("@/lib/guards/site-admin-api", () => ({
  requireSiteMediaApiContext: mocks.mediaAuthority,
  requireSiteAuthenticatedApiContext: mocks.authenticated,
}));
vi.mock("@/db/media", () => ({ getMediaAssetBySiteAndId: mocks.asset }));
vi.mock("@/db/media-spaces", () => ({
  getMediaSpaceById: mocks.space,
  resolveAuthorizedMediaSpace: vi.fn(),
  PhisMediaSpaceKind: { Site: 1, User: 2, Group: 3 },
}));
vi.mock("@/db/site-groups", () => ({ readEffectiveGroupMembershipFlags: mocks.flags }));
vi.mock("@/lib/authorization", () => ({
  canPhiViewerAccess: () => false,
  PHI_ACCESS_DEVELOPER_TOOLS: "developer-tools",
}));

import { PhiGroupMembershipFlags } from "@/lib/constants/site-groups";
import {
  canTransferMediaAssetOwnership,
  requireMediaAssetContext,
} from "./site-media-api";

const ACTOR = 42;
const OTHER = 99;
const GROUP_SPACE = { id: 5, kind: 3, userId: null, groupId: 7 };
const request = {} as NextRequest;

function noMediaAuthority() {
  return { context: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.mediaAuthority.mockResolvedValue(noMediaAuthority());
  mocks.authenticated.mockResolvedValue({
    context: { site: { id: 1, key: "s" }, session: { userId: ACTOR } },
    error: null,
  });
  mocks.space.mockResolvedValue(GROUP_SPACE);
});

async function mayAct(input: {
  level: number;
  ownerUserId: number | null;
  intent: "read" | "update" | "delete";
}) {
  mocks.asset.mockResolvedValue({ id: 3, spaceId: 5, ownerUserId: input.ownerUserId });
  mocks.flags.mockResolvedValue(input.level);
  const result = await requireMediaAssetContext(request, 3, input.intent);
  return result.error === null;
}

describe("acting on one Asset in a Group Space", () => {
  const { Member, Author, Editor, Manager } = PhiGroupMembershipFlags;

  it.each([
    ["Member reads", Member, ACTOR, "read", true],
    ["Member does not update even their own", Member, ACTOR, "update", false],
    ["Author updates their own", Author, ACTOR, "update", true],
    ["Author deletes their own", Author, ACTOR, "delete", true],
    ["Author does not touch someone else's", Author, OTHER, "update", false],
    ["Author does not delete someone else's", Author, OTHER, "delete", false],
    ["Editor updates someone else's", Editor, OTHER, "update", true],
    ["Editor does not delete someone else's", Editor, OTHER, "delete", false],
    ["Editor still deletes their own", Editor, ACTOR, "delete", true],
    ["Manager deletes someone else's", Manager, OTHER, "delete", true],
  ] as const)("%s", async (_name, level, ownerUserId, intent, expected) => {
    expect(await mayAct({ level, ownerUserId, intent })).toBe(expected);
  });

  it("treats an unowned Asset as nobody's, not as everybody's", async () => {
    expect(await mayAct({ level: Author, ownerUserId: null, intent: "update" })).toBe(false);
    expect(await mayAct({ level: Author, ownerUserId: null, intent: "delete" })).toBe(false);
    expect(await mayAct({ level: Editor, ownerUserId: null, intent: "update" })).toBe(true);
    expect(await mayAct({ level: Manager, ownerUserId: null, intent: "delete" })).toBe(true);
  });

  it("refuses someone outside the group entirely", async () => {
    expect(await mayAct({ level: 0, ownerUserId: ACTOR, intent: "read" })).toBe(false);
  });

  it("leaves the Site Space to Media administration", async () => {
    mocks.space.mockResolvedValue({ id: 1, kind: 1, userId: null, groupId: null });
    expect(await mayAct({ level: Manager, ownerUserId: ACTOR, intent: "read" })).toBe(false);
  });

  it("answers a User Space from the Space itself", async () => {
    mocks.space.mockResolvedValue({ id: 9, kind: 2, userId: ACTOR, groupId: null });
    expect(await mayAct({ level: 0, ownerUserId: null, intent: "delete" })).toBe(true);
    mocks.space.mockResolvedValue({ id: 9, kind: 2, userId: OTHER, groupId: null });
    expect(await mayAct({ level: 0, ownerUserId: ACTOR, intent: "delete" })).toBe(false);
  });
});

describe("handing an Asset over", () => {
  const { Member, Author, Editor } = PhiGroupMembershipFlags;

  async function mayTransfer(input: {
    level: number;
    ownerUserId: number | null;
    nextOwnerUserId: number | null;
    recipientLevel?: number;
  }) {
    mocks.flags.mockImplementation((_siteId: number, _groupId: number, userId: number) =>
      Promise.resolve(userId === ACTOR ? input.level : input.recipientLevel ?? Member),
    );
    return canTransferMediaAssetOwnership({
      siteId: 1,
      groupId: 7,
      actorId: ACTOR,
      ownerUserId: input.ownerUserId,
      nextOwnerUserId: input.nextOwnerUserId,
    });
  }

  it("lets an Author give away what is theirs", async () => {
    expect(await mayTransfer({ level: Author, ownerUserId: ACTOR, nextOwnerUserId: OTHER })).toBe(true);
  });

  it("does not let an Author take what is someone else's", async () => {
    expect(await mayTransfer({ level: Author, ownerUserId: OTHER, nextOwnerUserId: ACTOR })).toBe(false);
  });

  it("lets an Editor take it", async () => {
    expect(await mayTransfer({ level: Editor, ownerUserId: OTHER, nextOwnerUserId: ACTOR })).toBe(true);
  });

  it("lets an Author release their own to the group", async () => {
    expect(await mayTransfer({ level: Author, ownerUserId: ACTOR, nextOwnerUserId: null })).toBe(true);
  });

  it("needs an Editor to release someone else's to nobody", async () => {
    expect(await mayTransfer({ level: Author, ownerUserId: OTHER, nextOwnerUserId: null })).toBe(false);
    expect(await mayTransfer({ level: Editor, ownerUserId: OTHER, nextOwnerUserId: null })).toBe(true);
  });

  it("does not let a Member give away even their own", async () => {
    expect(await mayTransfer({ level: Member, ownerUserId: ACTOR, nextOwnerUserId: null })).toBe(false);
  });

  it("refuses a recipient who is not in the group", async () => {
    expect(await mayTransfer({
      level: Editor, ownerUserId: ACTOR, nextOwnerUserId: OTHER, recipientLevel: 0,
    })).toBe(false);
  });
});
