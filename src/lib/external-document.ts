import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const EXTERNAL_DOCUMENT_MAX_BYTES = 2 * 1024 * 1024;
const EXTERNAL_DOCUMENT_TIMEOUT_MS = 10_000;

function isPrivateAddress(address: string) {
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return isPrivateAddress(normalized.slice("::ffff:".length));
  }
  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  ) {
    return true;
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }
  return parts[0] === 0 ||
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] >= 224;
}

async function assertExternalDocumentUrl(value: string) {
  const url = new URL(value);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new Error("External document URL must be an unauthenticated HTTP or HTTPS URL.");
  }
  if (url.hostname === "localhost" || url.hostname.endsWith(".local")) {
    throw new Error("External document URL must not target a local host.");
  }
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true });
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("External document URL resolves to a private address.");
  }
  return url;
}

export async function loadExternalDocument(sourceUrl: string) {
  let url = await assertExternalDocumentUrl(sourceUrl.trim());
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    const response = await fetch(url, {
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(EXTERNAL_DOCUMENT_TIMEOUT_MS),
      headers: { accept: "text/markdown, text/html, text/plain;q=0.9" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirectCount === 3) {
        throw new Error("External document redirect could not be resolved safely.");
      }
      url = await assertExternalDocumentUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) {
      throw new Error(`External document request failed with status ${response.status}.`);
    }
    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (declaredSize > EXTERNAL_DOCUMENT_MAX_BYTES) {
      throw new Error("External document exceeds the 2 MiB size limit.");
    }
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("External document response did not include a readable body.");
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > EXTERNAL_DOCUMENT_MAX_BYTES) {
        await reader.cancel();
        throw new Error("External document exceeds the 2 MiB size limit.");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }
  throw new Error("External document redirect limit exceeded.");
}

export function buildExternalDocumentLanguageSample(
  document: string,
  format: "markdown" | "html",
) {
  const plain = format === "html"
    ? document.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
    : document.replace(/^\s*```[\s\S]*?^\s*```\s*$/gm, " ")
      .replace(/`[^`]*`/g, " ")
      .replace(/!?(\[[^\]]*\])\([^)]*\)/g, "$1")
      .replace(/^\s{0,3}[#>*+-]+\s*/gm, " ")
      .replace(/[|*_~]/g, " ");
  return plain.replace(/\s+/g, " ").trim().slice(0, 16_000);
}
