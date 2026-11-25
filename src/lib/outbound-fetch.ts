import { lookup as dnsLookup } from "node:dns/promises";
import http, { type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import type { LookupFunction } from "node:net";

/*
 * Requests Core sends to an address somebody else named: an Add-on's import into the CDN
 * (`cdn-publish:v1`), an external document a translation is detected from. One place decides what such
 * a request may reach, so the rule is not re-derived wherever a URL arrives.
 *
 * - Every hop is checked: the scheme, credentials in the address, the port, the host against the
 *   policy's host list, and every address the host resolves to against the networks below. A redirect
 *   is followed by hand, and only so often.
 * - The name is resolved once per hop and the connection is made to that address (`lookup` pinned on the
 *   request), so a second answer from DNS -- rebinding -- never decides where the bytes come from.
 *   TLS still checks the certificate against the host name.
 *
 * No `server-only`, no aliases: the CLI may load it, and a test can drive it with its own resolver and
 * transport.
 */

/*
 * Networks no outbound request reaches: private, loopback, link-local, ULA, multicast, reserved. Two
 * lists, because a `BlockList` matches an IPv4 address against IPv6 rules too (as its mapped form), and
 * the mapped range itself is refused for IPv6.
 */
const BLOCKED_V4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
  BLOCKED_V4.addSubnet(network, prefix, "ipv4");
}
const BLOCKED_V6 = new BlockList();
for (const [network, prefix] of [
  // ::, ::1 and the IPv4-compatible and -mapped forms: an AAAA record never names a public host so.
  ["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED_V6.addSubnet(network, prefix, "ipv6");
}

/** Whether an address is one no outbound request may reach. */
export function isPhisOutboundAddressBlocked(address: string) {
  const family = isIP(address);
  if (family === 4) return BLOCKED_V4.check(address, "ipv4");
  if (family === 6) return BLOCKED_V6.check(address, "ipv6");
  // Not an address at all is not one to connect to.
  return true;
}

export type PhisOutboundPolicy = {
  /** The schemes a hop may use. */
  protocols: readonly ("https:" | "http:")[];
  /** `default`: only the scheme's own port (443 for https), stated or not. `any`: whatever the address says. */
  ports: "default" | "any";
  /** Host names a hop may name, lowercase and exact. Null: any host whose every address is public. */
  hosts: readonly string[] | null;
  /** Redirects followed at most; one more is `redirect-limit`. */
  maxRedirects: number;
  /** How long a hop may take until its response headers arrive. */
  headersTimeoutMs: number;
  /** How long a body may stand still before the response is ended. */
  idleTimeoutMs: number;
};

export type PhisOutboundFailure =
  | "host-not-allowed"
  | "address-refused"
  | "dns-failed"
  | "redirect-limit"
  | "timeout"
  | "network"
  | "aborted";

export class PhisOutboundFetchError extends Error {
  readonly code: PhisOutboundFailure;

  constructor(code: PhisOutboundFailure, message: string) {
    super(message);
    this.name = "PhisOutboundFetchError";
    this.code = code;
  }
}

export type PhisOutboundResponse = {
  /** The address that answered, after the redirects. */
  url: string;
  status: number;
  headers: IncomingHttpHeaders;
  /** The body as it arrives; ended by the caller's signal, the idle timeout or `discard()`. */
  body: IncomingMessage;
  /** Redirects followed. */
  redirects: number;
  discard(): void;
};

export type PhisOutboundResolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

/** What sends one hop; Node's `http`/`https` by default, a fake in tests. */
export type PhisOutboundTransport = (
  url: URL,
  options: http.RequestOptions & { lookup: LookupFunction; servername?: string },
) => http.ClientRequest;

export type PhisOutboundOptions = {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  resolve?: PhisOutboundResolver;
  transport?: PhisOutboundTransport;
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const defaultResolve: PhisOutboundResolver = async (hostname) =>
  await dnsLookup(hostname, { all: true, verbatim: true });

const defaultTransport: PhisOutboundTransport = (url, options) =>
  (url.protocol === "https:" ? https : http).request(url, options);

function hostOf(url: URL) {
  // An IPv6 literal comes bracketed; the name a resolver and a certificate know is without.
  return url.hostname.replace(/^\[(.*)\]$/u, "$1").toLowerCase();
}

/** Why an address may not be asked at all, before anything is resolved; null where it may. */
export function explainPhisOutboundUrlRefusal(url: URL, policy: PhisOutboundPolicy): string | null {
  if (!policy.protocols.includes(url.protocol as "https:" | "http:")) {
    return `${url.protocol} is not allowed here; ${policy.protocols.join(" or ")} only.`;
  }
  if (url.username || url.password) return "An address with credentials in it is not fetched.";
  if (policy.ports === "default" && url.port !== "") {
    return `Port ${url.port} is not allowed here; only the ${url.protocol === "https:" ? "443" : "80"} of ${url.protocol}.`;
  }
  const host = hostOf(url);
  if (!host) return "The address names no host.";
  if (policy.hosts && !policy.hosts.includes(host)) {
    return `${host} is not on the import host list.`;
  }
  if (!policy.hosts && (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local"))) {
    return `${host} is a local name.`;
  }
  return null;
}

/** Whether `fetchPhisOutbound` would ask this address at all, without asking it. */
export function isPhisOutboundUrlAllowed(input: string, policy: PhisOutboundPolicy) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  return explainPhisOutboundUrlRefusal(url, policy) === null;
}

async function resolvePinned(host: string, resolve: PhisOutboundResolver) {
  const literal = isIP(host);
  let addresses: { address: string; family: number }[];
  if (literal) {
    addresses = [{ address: host, family: literal }];
  } else {
    try {
      addresses = await resolve(host);
    } catch (error) {
      throw new PhisOutboundFetchError("dns-failed", `${host} did not resolve: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (addresses.length === 0) throw new PhisOutboundFetchError("dns-failed", `${host} has no address.`);
  // Every address, not just the first: a name answering one public and one private address is refused.
  const blocked = addresses.find((entry) => isPhisOutboundAddressBlocked(entry.address));
  if (blocked) {
    throw new PhisOutboundFetchError("address-refused", `${host} resolves to ${blocked.address}, which is not a public address.`);
  }
  return addresses[0]!;
}

function pinnedLookup(pinned: { address: string; family: number }): LookupFunction {
  return ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
    else callback(null, pinned.address, pinned.family);
  }) as LookupFunction;
}

function sendHop(
  url: URL,
  pinned: { address: string; family: number },
  policy: PhisOutboundPolicy,
  options: PhisOutboundOptions,
) {
  const transport = options.transport ?? defaultTransport;
  const host = hostOf(url);
  return new Promise<{ request: http.ClientRequest; response: IncomingMessage }>((resolve, reject) => {
    const request = transport(url, {
      method: "GET",
      headers: { "accept-encoding": "identity", "user-agent": "phis-server", ...(options.headers ?? {}) },
      lookup: pinnedLookup(pinned),
      ...(isIP(host) ? {} : { servername: host }),
      // A socket of its own: a kept-alive one was opened for an address this hop did not check.
      agent: false,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const timer = setTimeout(() => {
      request.destroy(new PhisOutboundFetchError("timeout", `${host} did not answer within ${policy.headersTimeoutMs} ms.`));
    }, policy.headersTimeoutMs);
    request.once("response", (response) => {
      clearTimeout(timer);
      response.socket?.setTimeout(policy.idleTimeoutMs, () => {
        response.destroy(new PhisOutboundFetchError("timeout", `${host} stopped sending for ${policy.idleTimeoutMs} ms.`));
      });
      resolve({ request, response });
    });
    request.once("error", (error) => {
      clearTimeout(timer);
      if (error instanceof PhisOutboundFetchError) reject(error);
      else if (options.signal?.aborted) reject(new PhisOutboundFetchError("aborted", "The request was aborted."));
      else reject(new PhisOutboundFetchError("network", `${host}: ${error.message}`));
    });
    request.end();
  });
}

/**
 * GET `input` under `policy`, following redirects by hand. Answers the first response that is not a
 * redirect, whatever its status -- the caller decides what a 404 means -- and throws
 * `PhisOutboundFetchError` where a hop may not be asked or does not answer.
 */
export async function fetchPhisOutbound(
  input: string,
  policy: PhisOutboundPolicy,
  options: PhisOutboundOptions = {},
): Promise<PhisOutboundResponse> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new PhisOutboundFetchError("host-not-allowed", `"${input}" is not an address.`);
  }
  const resolve = options.resolve ?? defaultResolve;
  for (let redirects = 0; ; redirects += 1) {
    if (options.signal?.aborted) throw new PhisOutboundFetchError("aborted", "The request was aborted.");
    const refusal = explainPhisOutboundUrlRefusal(url, policy);
    if (refusal) throw new PhisOutboundFetchError("host-not-allowed", refusal);
    const pinned = await resolvePinned(hostOf(url), resolve);
    const { request, response } = await sendHop(url, pinned, policy, options);
    const status = response.statusCode ?? 0;
    if (REDIRECT_STATUSES.has(status)) {
      const location = response.headers.location;
      response.resume();
      request.destroy();
      if (!location) throw new PhisOutboundFetchError("network", `${url.host} answered ${status} without a Location.`);
      if (redirects >= policy.maxRedirects) {
        throw new PhisOutboundFetchError("redirect-limit", `More than ${policy.maxRedirects} redirects from ${input}.`);
      }
      try {
        url = new URL(location, url);
      } catch {
        throw new PhisOutboundFetchError("network", `${url.host} redirected to "${location}", which is not an address.`);
      }
      continue;
    }
    return {
      url: url.toString(),
      status,
      headers: response.headers,
      body: response,
      redirects,
      discard() {
        response.destroy();
        request.destroy();
      },
    };
  }
}

/** The policy of an import into the CDN: https on 443, the operator's hosts, five redirects. */
export function buildPhisCdnImportPolicy(importHosts: readonly string[]): PhisOutboundPolicy {
  return {
    protocols: ["https:"],
    ports: "default",
    hosts: importHosts.map((host) => host.trim().toLowerCase()).filter(Boolean),
    maxRedirects: 5,
    headersTimeoutMs: 30_000,
    idleTimeoutMs: 60_000,
  };
}

/** Whether a response's type is a page: a 200 that is an error page, or a file the CDN never serves. */
export function isPhisOutboundHtml(headers: IncomingHttpHeaders) {
  const type = String(headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  return type === "text/html" || type === "application/xhtml+xml";
}
