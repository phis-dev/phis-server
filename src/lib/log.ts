import "server-only";

export type {
  PhiLogEvent,
  PhiLogLevel,
  PhiLogService,
  PhiLogger,
  PhiLoggerContext,
} from "@phis/contracts/logging";
import type { PhiLogEvent, PhiLogLevel, PhiLoggerContext, PhiLogger } from "@phis/contracts/logging";

import { AsyncLocalStorage } from "node:async_hooks";

/*
 * The Site a request was resolved for, stamped on every record that request writes without naming one.
 *
 * Callers almost never passed `siteKey`, so nearly every record carried null and a Site's admin log,
 * which shows only its own Site's records, came up empty. A record written outside a Site's request --
 * start-up, the scheduler -- stays null and is nobody's Site log, because this Core serves several.
 * Kept on `globalThis` because the bundler may give each route its own copy of this module, and the
 * Site noted in one copy must be read in the other.
 */
const PHI_LOG_SITE_SCOPE_KEY = Symbol.for("phis.log.siteScope");
const phiLogSiteScope: AsyncLocalStorage<{ siteKey: string }> =
  ((globalThis as Record<symbol, unknown>)[PHI_LOG_SITE_SCOPE_KEY] as AsyncLocalStorage<{ siteKey: string }> | undefined)
  ?? ((globalThis as Record<symbol, unknown>)[PHI_LOG_SITE_SCOPE_KEY] = new AsyncLocalStorage<{ siteKey: string }>()) as AsyncLocalStorage<{ siteKey: string }>;

/** Notes the Site the current request was resolved for; what it logs from here on carries that Site. */
export function notePhiLogSite(siteKey: string) {
  phiLogSiteScope.enterWith({ siteKey });
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
    };
  }

  if (typeof error === "string") {
    return {
      message: error,
    };
  }

  if (error && typeof error === "object") {
    try {
      const normalized = JSON.parse(safeStringify(error)) as unknown;
      if (normalized && typeof normalized === "object" && !Array.isArray(normalized)) {
        return normalized as Record<string, unknown>;
      }
    } catch {
      // Fall through to the generic message below.
    }
  }

  return {
    message: error == null ? null : String(error),
  };
}

export function normalizeLogThrowable(error: unknown) {
  return serializeError(error);
}

function safeStringify(value: unknown) {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_, current) => {
    if (typeof current === "bigint") {
      return current.toString();
    }

    if (current instanceof Error) {
      return {
        name: current.name,
        message: current.message,
        stack: current.stack ?? null,
      };
    }

    if (current && typeof current === "object") {
      if (seen.has(current)) {
        return "[Circular]";
      }

      seen.add(current);
    }

    return current;
  });
}

function emit(level: PhiLogLevel, payload: Record<string, unknown>) {
  let line: string;
  try {
    line = safeStringify(payload);
  } catch {
    line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      service: payload.service ?? "phis",
      event: payload.event ?? "log.emit_failed",
      message: "Failed to serialize log payload.",
    });
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  if (level === "error") {
    console.error(line);
    return;
  }

  console.info(line);
}

function normalizeContext(context: Partial<PhiLoggerContext>): PhiLoggerContext {
  if (!context.service) {
    throw new Error("Logger service is required.");
  }

  return {
    service: context.service,
    siteKey: context.siteKey ?? phiLogSiteScope.getStore()?.siteKey ?? null,
    area: context.area ?? null,
    requestId: context.requestId ?? null,
    userId: context.userId ?? null,
    actorRole: context.actorRole ?? null,
    pluginKey: context.pluginKey ?? null,
    method: context.method ?? null,
    path: context.path ?? null,
    targetType: context.targetType ?? null,
    targetId: context.targetId ?? null,
  };
}

function buildRecord(
  context: PhiLoggerContext,
  level: PhiLogLevel,
  event: string,
  data: PhiLogEvent,
) {
  return {
    ts: new Date().toISOString(),
    level,
    service: context.service,
    event,
    message: data.message ?? event,
    siteKey: context.siteKey ?? null,
    area: context.area ?? null,
    requestId: context.requestId ?? null,
    userId: context.userId ?? null,
    actorRole: context.actorRole ?? null,
    pluginKey: context.pluginKey ?? null,
    method: context.method ?? null,
    path: context.path ?? null,
    status: data.status ?? null,
    durationMs: data.durationMs ?? null,
    targetType: context.targetType ?? null,
    targetId: context.targetId ?? null,
    error: data.error === undefined ? null : serializeError(data.error),
    meta: data.meta ?? undefined,
  };
}

function createLoggerFromContext(context: PhiLoggerContext): PhiLogger {
  return {
    context,
    child(nextContext: Partial<PhiLoggerContext>) {
      return createLogger({
        ...context,
        ...nextContext,
        service: nextContext.service ?? context.service,
      });
    },
    debug(event, data = {}) {
      emit("debug", buildRecord(context, "debug", event, data));
    },
    info(event, data = {}) {
      emit("info", buildRecord(context, "info", event, data));
    },
    warn(event, data = {}) {
      emit("warn", buildRecord(context, "warn", event, data));
    },
    error(event, data = {}) {
      emit("error", buildRecord(context, "error", event, data));
    },
  };
}

export function createLogger(context: Partial<PhiLoggerContext>): PhiLogger {
  return createLoggerFromContext(normalizeContext(context));
}

export function logRuntimeEvent(
  level: PhiLogLevel,
  event: string,
  input: PhiLogEvent & Partial<PhiLoggerContext> = {},
) {
  const logger = createLogger({
    service: "phis",
    siteKey: input.siteKey ?? null,
    area: input.area ?? null,
    requestId: input.requestId ?? null,
    userId: input.userId ?? null,
    actorRole: input.actorRole ?? null,
    pluginKey: input.pluginKey ?? null,
    method: input.method ?? null,
    path: input.path ?? null,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
  });

  logger[level](event, {
    message: input.message,
    status: input.status,
    durationMs: input.durationMs,
    error: input.error,
    meta: input.meta,
  });
}
