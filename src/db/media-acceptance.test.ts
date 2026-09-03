import { describe, expect, it } from "vitest";

import {
  isPhiMediaContentAllowedInSpace,
  isPhiMediaObjectSizeAllowed,
  PhisMediaSpaceKind,
  type PhisMediaSpaceKindValue,
  resolveMediaSpaceContentKinds,
} from "@/db/media-spaces";

/**
 * What a Space is for, as opposed to how much of it fits.
 *
 * The two questions have different owners on purpose. Capacity is the operator's, because it is their
 * storage. Content is the Module's, because only a Module knows what the Space it asked for is for --
 * so these rules read a derivation rather than a setting, and there is no administrative path to them.
 */
describe("Media acceptance rules", () => {
  const config = {
    userSpaceContentKinds: ["image"],
    groupSpaceContentKinds: ["document", "pdf"],
  };
  const space = (kind: PhisMediaSpaceKindValue) => ({ kind });

  describe("what a Space accepts", () => {
    it("accepts what a Module declared its Space for", () => {
      expect(isPhiMediaContentAllowedInSpace("image/png", space(PhisMediaSpaceKind.User), config)).toBe(true);
      expect(isPhiMediaContentAllowedInSpace("image/svg+xml", space(PhisMediaSpaceKind.User), config)).toBe(true);
    });

    it("refuses what no Module declared it for", () => {
      expect(isPhiMediaContentAllowedInSpace("application/pdf", space(PhisMediaSpaceKind.User), config)).toBe(false);
      expect(isPhiMediaContentAllowedInSpace("video/mp4", space(PhisMediaSpaceKind.User), config)).toBe(false);
    });

    it("keeps the two delegated kinds apart", () => {
      // The whole point of deriving per Space kind: a general library declaring everything for the
      // Site Space must not widen what a personal Space holds.
      expect(isPhiMediaContentAllowedInSpace("application/pdf", space(PhisMediaSpaceKind.Group), config)).toBe(true);
      expect(isPhiMediaContentAllowedInSpace("image/png", space(PhisMediaSpaceKind.Group), config)).toBe(false);
    });

    // The opposite reading from an administered list, and for a reason: this one is only ever empty
    // when no Module has spoken, and a Space nothing asked for holds nothing.
    it("accepts nothing when no Module declared anything", () => {
      const silent = { userSpaceContentKinds: [], groupSpaceContentKinds: [] };
      expect(isPhiMediaContentAllowedInSpace("image/png", space(PhisMediaSpaceKind.User), silent)).toBe(false);
      expect(isPhiMediaContentAllowedInSpace("text/plain", space(PhisMediaSpaceKind.Group), silent)).toBe(false);
    });

    // Not delegated capacity: `PHI_ACCESS_SITE_MEDIA` decides there, and what a Site publishes
    // includes binaries offered for download.
    it("never restricts the Site Space", () => {
      const silent = { userSpaceContentKinds: [], groupSpaceContentKinds: [] };
      for (const contentType of ["image/png", "application/x-msdownload", "text/html", ""]) {
        expect(isPhiMediaContentAllowedInSpace(contentType, space(PhisMediaSpaceKind.Site), silent)).toBe(true);
      }
      expect(resolveMediaSpaceContentKinds(space(PhisMediaSpaceKind.Site), config)).toBeNull();
    });

    it("decides on the kind rather than the exact type", () => {
      // A declaration names kinds, so a Module gets every type in the family without listing them.
      for (const contentType of ["image/png", "image/webp", "image/avif", "IMAGE/JPEG; charset=binary"]) {
        expect(isPhiMediaContentAllowedInSpace(contentType, space(PhisMediaSpaceKind.User), config)).toBe(true);
      }
    });

    it("refuses an unclassifiable type against any declaration", () => {
      // `other` is what an unmapped type resolves to, and nothing declares it.
      expect(isPhiMediaContentAllowedInSpace("", space(PhisMediaSpaceKind.User), config)).toBe(false);
      expect(isPhiMediaContentAllowedInSpace("application/vnd.acme.invented", space(PhisMediaSpaceKind.Group), config))
        .toBe(false);
    });

    it("carries a kind this release has never heard of", () => {
      // A newer Module's declaration travels as the string it is: refusing it here would make an older
      // control plane reject a Module that knows perfectly well what it means.
      const future = { userSpaceContentKinds: ["hologram"], groupSpaceContentKinds: [] };
      expect(resolveMediaSpaceContentKinds(space(PhisMediaSpaceKind.User), future)).toEqual(["hologram"]);
      expect(isPhiMediaContentAllowedInSpace("image/png", space(PhisMediaSpaceKind.User), future)).toBe(false);
    });
  });

  describe("object size", () => {
    it("accepts up to the limit and refuses one byte past it", () => {
      expect(isPhiMediaObjectSizeAllowed(1_000, { maxObjectBytes: 1_000 })).toBe(true);
      expect(isPhiMediaObjectSizeAllowed(1_001, { maxObjectBytes: 1_000 })).toBe(false);
    });

    // There is no "no limit": `site_media_config_quota_check` requires a positive cap, so an unbounded
    // upload is a state the Site cannot get into.
    it("has no disabled state", () => {
      expect(isPhiMediaObjectSizeAllowed(1, { maxObjectBytes: 0 })).toBe(false);
    });
  });
});
