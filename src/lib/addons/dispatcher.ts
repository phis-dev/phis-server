import "server-only";

import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  getSessionFromRequest,
  touchSession,
} from "@/db/user-sessions";
import {
  getPhisAddonRegistryRecord,
  isPhisAddonEnabledForSite,
} from "@/db/server-addons";
import { getPhisAddonInstalledManifest } from "@/lib/addons/installed";
import {
  type PhisAddonApiRouteDescriptor,
  type PhisAddonBuildEntry,
  type PhisAddonHandler,
  type PhisAddonHookDescriptor,
  type PhisAddonHttpMethod,
  type PhisAddonRequestContext,
} from "@/lib/addons/contract";
import { buildPhisAddonCapabilities } from "@/lib/addons/capabilities";
import { hasPhisCoreCapability } from "@/lib/addons/core-capabilities";
import {
  digestPhisAddonManifest,
  validatePhisAddonManifest,
} from "@/lib/addons/manifest";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { requireSiteAdminOnlyApiContext } from "@/lib/guards/site-admin-api";
import { createLogger } from "@/lib/log";
import { getOperatorSessionFromRequest } from "@/lib/operator-auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { requireSiteFromRequest } from "@/lib/site-context";

const DEFAULT_API_BODY_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_API_TIMEOUT_MS = 15_000;

type AddonRouteKind = "api" | "hook";

type AddonRouteParams = {
  scope: string;
  name: string;
  path?: string[];
};

type MatchedDescriptor<T> = {
  descriptor: T;
  pathParams: Readonly<Record<string, string>>;
};

function notFound() {
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

function unavailable(requestId: string) {
  return NextResponse.json(
    { error: "Add-on temporarily unavailable.", requestId },
    { status: 503 },
  );
}

function normalizeRoutePath(path?: string[]) {
  return (path ?? []).map((segment) => segment.trim()).filter(Boolean).join("/");
}

function matchPath(pattern: string, actual: string) {
  const patternSegments = pattern ? pattern.split("/") : [];
  const actualSegments = actual ? actual.split("/") : [];
  if (patternSegments.length !== actualSegments.length) {
    return null;
  }

  const params: Record<string, string> = {};
  for (let index = 0; index < patternSegments.length; index += 1) {
    const expected = patternSegments[index] ?? "";
    const observed = actualSegments[index] ?? "";
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = observed;
      continue;
    }
    if (expected !== observed) {
      return null;
    }
  }
  return params;
}

function findDescriptor<T extends { method: string; path: string }>(
  descriptors: readonly T[],
  method: string,
  path: string,
): MatchedDescriptor<T> | null {
  for (const descriptor of descriptors) {
    if (descriptor.method !== method) {
      continue;
    }
    const pathParams = matchPath(descriptor.path, path);
    if (pathParams) {
      return { descriptor, pathParams };
    }
  }
  return null;
}

async function readRequestBody(request: Request, limit: number) {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    return {
      body: null,
      error: NextResponse.json({ error: "Request body too large." }, { status: 413 }),
    };
  }

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > limit) {
    return {
      body: null,
      error: NextResponse.json({ error: "Request body too large." }, { status: 413 }),
    };
  }

  return { body, error: null };
}

async function verifyRegistryState(
  entry: PhisAddonBuildEntry,
  siteId: number | null,
) {
  const registry = await getPhisAddonRegistryRecord(entry.manifest.addonId);
  if (!registry) {
    return "unavailable" as const;
  }
  if (!registry.globallyEnabled) {
    return "hidden" as const;
  }
  if (
    registry.packageName !== entry.manifest.packageName ||
    registry.packageVersion !== entry.manifest.packageVersion ||
    registry.serverAbi !== entry.manifest.serverAbi ||
    registry.manifestDigest !== entry.manifestDigest ||
    registry.migrationVersion < entry.manifest.migrationVersion
  ) {
    return "unavailable" as const;
  }
  if (
    siteId !== null &&
    !(await isPhisAddonEnabledForSite(entry.manifest.addonId, siteId))
  ) {
    return "hidden" as const;
  }
  return "ready" as const;
}

async function resolveApiIdentity(
  request: NextRequest,
  descriptor: PhisAddonApiRouteDescriptor,
) {
  if (descriptor.auth === "operator") {
    const operator = getOperatorSessionFromRequest(request);
    if (!operator) {
      return {
        error: NextResponse.json({ error: "Authentication required." }, { status: 401 }),
        site: null,
        actor: null,
      };
    }
    const site = descriptor.siteScoped ? await requireSiteFromRequest(request) : null;
    if (descriptor.siteScoped && !site) {
      return { error: notFound(), site: null, actor: null };
    }
    return {
      error: null,
      site,
      actor: { kind: "operator", id: operator.email } as const,
    };
  }

  if (descriptor.auth === "site-admin") {
    const result = await requireSiteAdminOnlyApiContext(request);
    if (result.error || !result.context?.session) {
      return {
        error:
          result.error ??
          NextResponse.json({ error: "Authentication required." }, { status: 401 }),
        site: null,
        actor: null,
      };
    }
    return {
      error: null,
      site: result.context.site,
      actor: { kind: "user", id: result.context.session.userId } as const,
    };
  }

  const guardError = guardApiV1(request, { requireInternalToken: true });
  if (guardError) {
    return { error: guardError, site: null, actor: null };
  }
  const site = descriptor.siteScoped ? await requireSiteFromRequest(request) : null;
  if (descriptor.siteScoped && !site) {
    return { error: notFound(), site: null, actor: null };
  }

  if (descriptor.auth === "site-user") {
    if (!site) {
      return { error: notFound(), site: null, actor: null };
    }
    const session = await getSessionFromRequest(request, site.id);
    if (!session) {
      return {
        error: NextResponse.json({ error: "Authentication required." }, { status: 401 }),
        site: null,
        actor: null,
      };
    }
    await touchSession(session.id, request);
    return {
      error: null,
      site,
      actor: { kind: "user", id: session.userId } as const,
    };
  }

  return {
    error: null,
    site,
    actor: { kind: "internal", id: null } as const,
  };
}

/**
 * Who is calling a hook: nobody, and on which Site.
 *
 * A hook is unauthenticated by construction -- that is what makes it reachable by a payment provider or
 * by somebody else's Core, and nothing here changes it. The Site is read from `x-phis-site-key`, the same
 * header every Site-scoped route already uses, and a hook that asks for one and does not get it is a 404
 * rather than an error: an address that answers nothing without the header stays out of indexes and off
 * casual scanners, which is worth having even though the header is no secret.
 *
 * The actor stays null, and null here means something the other contexts do not: an internal caller is
 * `{kind:"internal"}` and an operator is `{kind:"operator"}`, so a bare null is the one shape that says
 * nobody authenticated at all. The capabilities are built from that.
 */
async function resolveHookIdentity(
  request: NextRequest,
  descriptor: PhisAddonHookDescriptor,
) {
  if (!descriptor.siteScoped) {
    return { error: null, site: null, actor: null };
  }
  const site = await requireSiteFromRequest(request);
  if (!site) {
    return { error: notFound(), site: null, actor: null };
  }
  return { error: null, site, actor: null };
}

async function invokeHandler(
  handler: PhisAddonHandler,
  context: PhisAddonRequestContext,
  timeoutMs: number,
) {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  context.signal.addEventListener("abort", () => timeoutController.abort(), {
    once: true,
  });

  try {
    return await Promise.race([
      Promise.resolve(handler({ ...context, signal: timeoutController.signal })),
      new Promise<Response>((resolve) => {
        timeoutController.signal.addEventListener(
          "abort",
          () =>
            resolve(
              NextResponse.json(
                { error: "Add-on request timed out.", requestId: context.requestId },
                { status: 504 },
              ),
            ),
          { once: true },
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function dispatchPhisAddonRequest(
  request: NextRequest,
  kind: AddonRouteKind,
  params: AddonRouteParams,
) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  const addonId = `@${params.scope}/${params.name}`;
  const path = normalizeRoutePath(params.path);
  const logger = createLogger({
    service: "phis",
    requestId,
    pluginKey: addonId,
    method: request.method,
    path,
  });
  const entry = getPhisAddonInstalledManifest()[addonId];

  if (!entry || !entry.enabled) {
    return notFound();
  }

  const manifestValidation = validatePhisAddonManifest(entry.manifest);
  if (
    !manifestValidation.manifest ||
    digestPhisAddonManifest(manifestValidation.manifest) !== entry.manifestDigest
  ) {
    logger.error("addon.build_manifest.invalid");
    return unavailable(requestId);
  }
  if (
    entry.manifest.requiredCoreCapabilities.some(
      (capability) => !hasPhisCoreCapability(capability),
    )
  ) {
    logger.error("addon.core_capability.incompatible");
    return unavailable(requestId);
  }

  const match =
    kind === "api"
      ? findDescriptor(entry.manifest.apiRoutes, request.method, path)
      : findDescriptor(entry.manifest.hooks, request.method, path);
  if (!match) {
    return notFound();
  }

  const identity =
    kind === "api"
      ? await resolveApiIdentity(
          request,
          match.descriptor as PhisAddonApiRouteDescriptor,
        )
      : await resolveHookIdentity(
          request,
          match.descriptor as PhisAddonHookDescriptor,
        );
  if (identity.error) {
    return identity.error;
  }

  const rateLimitClass = match.descriptor.rateLimitClass;
  if (rateLimitClass) {
    const retryAfter = checkRateLimit(
      `${addonId}:${rateLimitClass}:${getClientIp(request)}`,
    );
    if (retryAfter !== null) {
      return NextResponse.json(
        { error: "Too many requests." },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }
  }

  try {
    const registryState = await verifyRegistryState(
      entry,
      identity.site?.id ?? null,
    );
    if (registryState === "hidden") {
      return notFound();
    }
    if (registryState !== "ready") {
      logger.error("addon.registry.unavailable");
      return unavailable(requestId);
    }

    const descriptor = match.descriptor as
      | PhisAddonApiRouteDescriptor
      | PhisAddonHookDescriptor;
    const bodyLimit =
      descriptor.bodyLimitBytes ?? DEFAULT_API_BODY_LIMIT_BYTES;
    const bodyResult = await readRequestBody(request, bodyLimit);
    if (bodyResult.error || !bodyResult.body) {
      return bodyResult.error;
    }

    const runtimeModule = await entry.load();
    const runtime = runtimeModule.phiServerAddon;
    const runtimeValidation = validatePhisAddonManifest(runtime?.manifest);
    if (
      !runtimeValidation.manifest ||
      digestPhisAddonManifest(runtimeValidation.manifest) !== entry.manifestDigest
    ) {
      logger.error("addon.runtime_manifest.mismatch");
      return unavailable(requestId);
    }

    const handlers = kind === "api" ? runtime.apiHandlers : runtime.hookHandlers;
    const handler = handlers?.[descriptor.handler];
    if (!handler) {
      logger.error("addon.handler.missing", {
        meta: { handler: descriptor.handler, kind },
      });
      return unavailable(requestId);
    }

    const response = await invokeHandler(
      handler,
      {
        addonId,
        requestId,
        method: request.method as PhisAddonHttpMethod,
        url: request.url,
        headers: new Headers(request.headers),
        body: bodyResult.body,
        path,
        pathParams: match.pathParams,
        site: identity.site
          ? { id: identity.site.id, key: identity.site.key }
          : null,
        actor: identity.actor,
        // Built here, per request, so the Site and actor above are the ones closed over. A capability
        // hoisted out of the request would be a capability someone could reach with another's identity.
        capabilities: buildPhisAddonCapabilities({
          manifest: entry.manifest,
          manifestDigest: entry.manifestDigest,
          siteId: identity.site?.id ?? null,
          siteKey: identity.site?.key ?? null,
          actorUserId: identity.actor?.kind === "user" ? identity.actor.id : null,
          unauthenticated: identity.actor === null,
        }),
        signal: request.signal,
      },
      descriptor.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    );

    if (!(response instanceof Response)) {
      logger.error("addon.handler.invalid_response");
      return unavailable(requestId);
    }
    response.headers.set("x-request-id", requestId);
    return response;
  } catch (error) {
    logger.error("addon.dispatch.failed", { error });
    return unavailable(requestId);
  }
}
