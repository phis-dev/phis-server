import { describe, expect, it } from "vitest";

import {
  resolvePhiMediaStoredContentType,
  sniffPhiMediaContentType,
} from "@/lib/media-content-sniffer";

const bytes = (...values: number[]) => Buffer.from(values);
const text = (value: string) => Buffer.from(value, "utf8");
const sniff = (head: Buffer, declared = "application/octet-stream") =>
  sniffPhiMediaContentType(head, declared);
const stored = (head: Buffer, declared = "application/octet-stream") =>
  resolvePhiMediaStoredContentType(sniff(head, declared));

/**
 * What a file is, as opposed to what it was called.
 *
 * The declaration reaches the server in a request body, so a content rule that reads it is a rule the
 * one party it exists for gets to write. These pin the answers that rule is now made on.
 */
describe("Media content sniffing", () => {
  it("recognizes the common image signatures", () => {
    expect(stored(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(stored(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(stored(text("GIF89a...."))).toBe("image/gif");
    expect(stored(Buffer.concat([text("RIFF"), bytes(0, 0, 0, 0), text("WEBP")]))).toBe("image/webp");
  });

  // Both are RIFF containers: the second run is what tells a picture from a sound.
  it("tells apart two formats that share a container", () => {
    expect(stored(Buffer.concat([text("RIFF"), bytes(0, 0, 0, 0), text("WAVE")]))).toBe("audio/wav");
  });

  it("recognizes documents, archives and executables", () => {
    expect(stored(text("%PDF-1.7"))).toBe("application/pdf");
    expect(stored(bytes(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c))).toBe("application/x-7z-compressed");
    expect(stored(bytes(0x7f, 0x45, 0x4c, 0x46, 2, 1, 1))).toBe("application/x-executable");
    expect(stored(text("MZ "))).toBe("application/x-msdownload");
  });

  describe("what the bytes cannot settle alone", () => {
    const zip = (entry: string) => Buffer.concat([
      bytes(0x50, 0x4b, 0x03, 0x04),
      Buffer.alloc(26),
      text(entry),
    ]);

    it("reads an ODF type out of the container, which states it", () => {
      expect(stored(zip("mimetypeapplication/vnd.oasis.opendocument.text")))
        .toBe("application/vnd.oasis.opendocument.text");
    });

    // The bytes still prove it is a ZIP, and nothing dangerous is a ZIP, so refining among
    // archive-shaped answers can only pick the wrong archive.
    it("lets a declaration refine which ZIP, but only among ZIP formats", () => {
      const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      expect(stored(zip("[Content_Types].xml"), docx)).toBe(docx);
      expect(stored(zip("[Content_Types].xml"), "image/png")).toBe("application/zip");
      expect(stored(zip("[Content_Types].xml"), "text/html")).toBe("application/zip");
    });

    it("pins the two text formats that would run in the Site's origin", () => {
      expect(stored(text("<!DOCTYPE html><html><body>hi"))).toBe("text/html");
      expect(stored(text("  <html>"))).toBe("text/html");
      expect(stored(text('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe("image/svg+xml");
      expect(stored(text('<?xml version="1.0"?><svg xmlns="x"/>'))).toBe("image/svg+xml");
    });

    it("keeps a textual label for text, within the textual family", () => {
      expect(stored(text("a,b,c\n1,2,3"), "text/csv")).toBe("text/csv");
      expect(stored(text("# Title"), "text/markdown")).toBe("text/markdown");
      expect(stored(text('{"a":1}'), "application/json")).toBe("application/json");
      // A textual body labelled as something binary keeps neither: it is plain text.
      expect(stored(text("a,b,c"), "image/png")).toBe("text/plain");
      // And a textual body labelled as HTML is not thereby HTML.
      expect(stored(text("just words"), "text/html")).toBe("text/plain");
    });
  });

  describe("a claim that disagrees with the bytes", () => {
    it("believes the bytes, in both directions", () => {
      expect(stored(text("<html><script>x</script>"), "image/png")).toBe("text/html");
      expect(stored(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), "text/html")).toBe("image/png");
      expect(stored(text("%PDF-1.4"), "image/jpeg")).toBe("application/pdf");
    });
  });

  describe("when nothing can be said", () => {
    it("answers nothing rather than guessing", () => {
      expect(sniff(Buffer.alloc(0)).evidence).toBe("none");
      expect(sniff(bytes(0x00, 0x01, 0x02, 0x03, 0xff, 0xfe)).contentType).toBeNull();
    });

    // An object nothing recognizes is bytes. Keeping the claim would carry it into delivery.
    it("stores unidentified bytes as bytes, not as what they were called", () => {
      expect(stored(bytes(0x00, 0x01, 0x02, 0x03, 0xff, 0xfe), "image/png")).toBe("application/octet-stream");
      expect(stored(Buffer.alloc(0), "image/png")).toBe("application/octet-stream");
    });
  });

  it("says how it reached its answer, so proof is distinguishable from shape", () => {
    expect(sniff(text("%PDF-1.7")).evidence).toBe("signature");
    expect(sniff(text("<svg/>")).evidence).toBe("text");
    const odf = Buffer.concat([
      bytes(0x50, 0x4b, 0x03, 0x04),
      Buffer.alloc(26),
      text("mimetypeapplication/vnd.oasis.opendocument.text"),
    ]);
    expect(sniff(odf).evidence).toBe("container");
  });
});
