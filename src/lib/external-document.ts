import "server-only";

import { DEEPL_DETECTION_SAMPLE_CHARS } from "@/lib/translation-unit";
import { fetchPhisOutbound, type PhisOutboundPolicy } from "@/lib/outbound-fetch";

const EXTERNAL_DOCUMENT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * What an external document may be fetched from: http or https on any port, any host whose every address
 * is public, three redirects. The checks, the DNS pinning and the blocked networks are `outbound-fetch.ts`'s,
 * the same an import into the CDN goes through; only the host list differs -- a document's address is
 * typed by an editor, not chosen by the operator.
 */
const EXTERNAL_DOCUMENT_POLICY: PhisOutboundPolicy = {
  protocols: ["https:", "http:"],
  ports: "any",
  hosts: null,
  maxRedirects: 3,
  headersTimeoutMs: 10_000,
  idleTimeoutMs: 10_000,
};

export async function loadExternalDocument(sourceUrl: string) {
  const response = await fetchPhisOutbound(sourceUrl.trim(), EXTERNAL_DOCUMENT_POLICY, {
    signal: AbortSignal.timeout(EXTERNAL_DOCUMENT_POLICY.headersTimeoutMs * 2),
    headers: { accept: "text/markdown, text/html, text/plain;q=0.9" },
  });
  try {
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`External document request failed with status ${response.status}.`);
    }
    const declaredSize = Number(response.headers["content-length"] ?? 0);
    if (declaredSize > EXTERNAL_DOCUMENT_MAX_BYTES) {
      throw new Error("External document exceeds the 2 MiB size limit.");
    }
    const chunks: Buffer[] = [];
    let byteLength = 0;
    for await (const chunk of response.body as AsyncIterable<Buffer>) {
      byteLength += chunk.length;
      if (byteLength > EXTERNAL_DOCUMENT_MAX_BYTES) {
        throw new Error("External document exceeds the 2 MiB size limit.");
      }
      chunks.push(chunk);
    }
    return new TextDecoder().decode(Buffer.concat(chunks, byteLength));
  } finally {
    response.discard();
  }
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
  return plain.replace(/\s+/g, " ").trim().slice(0, DEEPL_DETECTION_SAMPLE_CHARS);
}
