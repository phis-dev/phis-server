import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type { MediaAssetRecord } from "@/db/media";

const mocks = vi.hoisted(() => ({
  tokenMode: vi.fn(),
  session: vi.fn(),
  space: vi.fn(),
  groupMember: vi.fn(),
}));

// The three constant tables stay real -- the policy numbers are the contract this decides on.
vi.mock("@/db/media-spaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db/media-spaces")>()),
  getMediaSpaceById: mocks.space,
  isEffectiveMediaGroupMember: mocks.groupMember,
}));
vi.mock("@/db/user-sessions", () => ({ getSessionFromRequest: mocks.session }));
vi.mock("@/lib/api-v1-guard", () => ({ getApiV1TokenMode: mocks.tokenMode }));

import {
  PhiMediaDeliveryPolicy,
  PhiMediaLifecycleStatus,
  PhiMediaSpaceKind,
} from "@/db/media-spaces";
import { canDeliverMediaAsset, mediaDeliveryCacheControl, mediaDeliverySafetyHeaders } from "./media-delivery";

function asset(
  deliveryPolicy: number,
  deliveryRevision = 3,
): MediaAssetRecord {
  return { deliveryPolicy, deliveryRevision } as MediaAssetRecord;
}

function protectedAsset(overrides: Partial<MediaAssetRecord> = {}): MediaAssetRecord {
  return {
    id: 9,
    siteId: 31,
    spaceId: 5,
    lifecycleStatus: PhiMediaLifecycleStatus.Ready,
    deliveryPolicy: PhiMediaDeliveryPolicy.Public,
    ...overrides,
  } as MediaAssetRecord;
}

const delivery = () => new NextRequest("https://site.test/api/site/media/9/content");

function visitor(options: {
  token?: "internal" | "public" | null;
  userId?: number | null;
  space?: { kind: number; userId?: number | null; groupId?: number | null } | null;
  member?: boolean;
} = {}) {
  mocks.tokenMode.mockReturnValue(options.token ?? null);
  mocks.session.mockResolvedValue(options.userId == null ? null : { userId: options.userId });
  mocks.space.mockResolvedValue(options.space === undefined ? null : options.space);
  mocks.groupMember.mockResolvedValue(options.member ?? false);
}

describe("media delivery cache policy", () => {
  it("uses immutable caching only when a public URL carries the current delivery revision", () => {
    expect(mediaDeliveryCacheControl(
      new NextRequest("https://site.test/api/site/media/7/content?r=3"),
      asset(PhiMediaDeliveryPolicy.Public),
    )).toBe("public, max-age=31536000, immutable");
  });

  it("revalidates stable public Asset-id URLs without the current delivery revision", () => {
    expect(mediaDeliveryCacheControl(
      new NextRequest("https://site.test/api/site/media/7/content"),
      asset(PhiMediaDeliveryPolicy.Public),
    )).toBe("public, max-age=0, must-revalidate");
    expect(mediaDeliveryCacheControl(
      new NextRequest("https://site.test/api/site/media/7/content?r=2"),
      asset(PhiMediaDeliveryPolicy.Public),
    )).toBe("public, max-age=0, must-revalidate");
  });

  it("never emits shared caching for protected Assets", () => {
    expect(mediaDeliveryCacheControl(
      new NextRequest("https://site.test/api/site/media/7/content?r=3"),
      asset(PhiMediaDeliveryPolicy.Authenticated),
    )).toBe("private, no-store");
  });
});

/*
 * The decision that stands in front of every Asset byte. It runs on the Asset's own lifecycle and
 * policy rather than on a route guard, so a public page keeps rendering without a session -- which also
 * means a mistake here is not caught by anything else. Each policy is its own row below, including the
 * ones that must answer no.
 */
describe("Who may be delivered a Media Asset", () => {
  it("delivers a public Asset to anyone, with no session and no token", async () => {
    visitor();
    await expect(canDeliverMediaAsset(delivery(), protectedAsset())).resolves.toBe(true);
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it("delivers nothing that is not Ready, whatever its policy says", async () => {
    for (const lifecycleStatus of [
      PhiMediaLifecycleStatus.Pending,
      PhiMediaLifecycleStatus.Archived,
      PhiMediaLifecycleStatus.Quarantined,
      PhiMediaLifecycleStatus.Failed,
    ]) {
      for (const deliveryPolicy of Object.values(PhiMediaDeliveryPolicy)) {
        visitor({ token: "internal", userId: 7, space: { kind: PhiMediaSpaceKind.Site } });
        await expect(
          canDeliverMediaAsset(delivery(), protectedAsset({ lifecycleStatus, deliveryPolicy })),
          `${lifecycleStatus}/${deliveryPolicy}`,
        ).resolves.toBe(false);
      }
    }
  });

  it("delivers an internal Asset to the internal token alone", async () => {
    const internal = protectedAsset({ deliveryPolicy: PhiMediaDeliveryPolicy.Internal });
    visitor({ token: "internal" });
    await expect(canDeliverMediaAsset(delivery(), internal)).resolves.toBe(true);
    // A signed-in person is not an internal caller: the session does not stand in for the token.
    visitor({ token: "public", userId: 7 });
    await expect(canDeliverMediaAsset(delivery(), internal)).resolves.toBe(false);
    visitor({ userId: 7 });
    await expect(canDeliverMediaAsset(delivery(), internal)).resolves.toBe(false);
  });

  it("delivers an authenticated Asset to any session and to no one without one", async () => {
    const authenticated = protectedAsset({ deliveryPolicy: PhiMediaDeliveryPolicy.Authenticated });
    visitor({ userId: 7 });
    await expect(canDeliverMediaAsset(delivery(), authenticated)).resolves.toBe(true);
    visitor();
    await expect(canDeliverMediaAsset(delivery(), authenticated)).resolves.toBe(false);
  });

  it("delivers a User Asset to the owner of the Space it sits in", async () => {
    const own = protectedAsset({ deliveryPolicy: PhiMediaDeliveryPolicy.User });
    visitor({ userId: 7, space: { kind: PhiMediaSpaceKind.User, userId: 7 } });
    await expect(canDeliverMediaAsset(delivery(), own)).resolves.toBe(true);
    visitor({ userId: 8, space: { kind: PhiMediaSpaceKind.User, userId: 7 } });
    await expect(canDeliverMediaAsset(delivery(), own)).resolves.toBe(false);
    // The policy names the Space kind too: a User policy on a Group Space grants nothing.
    visitor({ userId: 7, space: { kind: PhiMediaSpaceKind.Group, groupId: 2 }, member: true });
    await expect(canDeliverMediaAsset(delivery(), own)).resolves.toBe(false);
  });

  it("delivers a Group Asset to an effective member of that group", async () => {
    const shared = protectedAsset({ deliveryPolicy: PhiMediaDeliveryPolicy.Group });
    visitor({ userId: 7, space: { kind: PhiMediaSpaceKind.Group, groupId: 2 }, member: true });
    await expect(canDeliverMediaAsset(delivery(), shared)).resolves.toBe(true);
    expect(mocks.groupMember).toHaveBeenCalledWith(31, 2, 7);

    visitor({ userId: 7, space: { kind: PhiMediaSpaceKind.Group, groupId: 2 }, member: false });
    await expect(canDeliverMediaAsset(delivery(), shared)).resolves.toBe(false);
    // Membership is asked for per request, so a retired group stops delivering without any Asset write.
    visitor({ userId: 7, space: { kind: PhiMediaSpaceKind.Group, groupId: null }, member: true });
    await expect(canDeliverMediaAsset(delivery(), shared)).resolves.toBe(false);
    visitor({ userId: 7, space: { kind: PhiMediaSpaceKind.Site }, member: true });
    await expect(canDeliverMediaAsset(delivery(), shared)).resolves.toBe(false);
  });

  it("refuses when the Space behind a protected Asset cannot be read", async () => {
    for (const deliveryPolicy of [PhiMediaDeliveryPolicy.User, PhiMediaDeliveryPolicy.Group]) {
      visitor({ userId: 7, space: null });
      await expect(canDeliverMediaAsset(delivery(), protectedAsset({ deliveryPolicy }))).resolves.toBe(false);
    }
  });

  it("refuses a delivery policy it does not know", async () => {
    visitor({ token: "internal", userId: 7, space: { kind: PhiMediaSpaceKind.Site } });
    await expect(canDeliverMediaAsset(delivery(), protectedAsset({ deliveryPolicy: 99 }))).resolves.toBe(false);
  });

  it("is decided before the object is looked for", async () => {
    const route = await readFile(
      new URL("../app/api/site/media/[id]/content/route.ts", import.meta.url),
      "utf8",
    );
    // Storage is only reached once delivery is allowed: a refused request must not even reveal whether
    // the object exists, and must not cost a provider round trip.
    expect(route.indexOf("canDeliverMediaAsset(request, asset)"))
      .toBeLessThan(route.indexOf("createPhisMediaStorageServiceForProfile(profile"));
  });
});

describe("What a delivered object is allowed to do", () => {
  const disposition = (contentType: string) =>
    mediaDeliverySafetyHeaders(contentType, "file.bin")["content-disposition"].split(";", 1)[0];

  it("renders in place only what a browser cannot run", () => {
    for (const contentType of ["image/png", "image/jpeg", "image/webp", "image/avif", "video/mp4", "audio/mpeg"]) {
      expect(disposition(contentType)).toBe("inline");
    }
  });

  it("hands over anything that is a document when it is navigated to", () => {
    // SVG and HTML are the reason this exists: both run script in the Site's own origin.
    for (const contentType of ["image/svg+xml", "text/html", "application/pdf", "application/xhtml+xml"]) {
      expect(disposition(contentType)).toBe("attachment");
    }
  });

  it("hands over a type it has never heard of", () => {
    // Absence is what makes the list safe: a new format is a download until someone proves otherwise.
    expect(disposition("application/x-msdownload")).toBe("attachment");
    expect(disposition("application/vnd.acme.invented")).toBe("attachment");
    expect(disposition("")).toBe("attachment");
  });

  it("decides on the type alone, without its parameters or case", () => {
    expect(disposition("IMAGE/PNG")).toBe("inline");
    expect(disposition("image/png; charset=binary")).toBe("inline");
    expect(disposition(" image/png ")).toBe("inline");
  });

  it("stops a browser from improving on the declared type", () => {
    const headers = mediaDeliverySafetyHeaders("image/png", "logo.png");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    // The backstop for the day the list above is wrong: an opaque origin has nothing worth reaching.
    expect(headers["content-security-policy"]).toBe("sandbox");
  });

  it("carries a filename in both forms, and never one that could forge a header", () => {
    const headers = mediaDeliverySafetyHeaders("application/pdf", "Jahresbericht \"2026\".pdf");
    expect(headers["content-disposition"]).toContain('filename="Jahresbericht _2026_.pdf"');
    expect(headers["content-disposition"]).toContain("filename*=UTF-8''Jahresbericht%20%222026%22.pdf");
    expect(headers["content-disposition"]).not.toContain("\n");
  });

  it("keeps a non-ASCII name readable in the encoded form and legible in the fallback", () => {
    const headers = mediaDeliverySafetyHeaders("application/pdf", "Übergrößen.pdf");
    expect(headers["content-disposition"]).toContain('filename="_bergr__en.pdf"');
    expect(headers["content-disposition"]).toContain("filename*=UTF-8''%C3%9Cbergr%C3%B6%C3%9Fen.pdf");
  });

  it("percent-encodes what RFC 5987 does not admit", () => {
    const headers = mediaDeliverySafetyHeaders("application/pdf", "a'b(c)d*e.pdf");
    expect(headers["content-disposition"]).toContain("filename*=UTF-8''a%27b%28c%29d%2Ae.pdf");
  });

  it("never emits an empty filename", () => {
    expect(mediaDeliverySafetyHeaders("application/pdf", "   ")["content-disposition"])
      .toContain('filename="download"');
  });
});
