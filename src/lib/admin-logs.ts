import "server-only";

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { normalizeString } from "@/lib/helpers/request";

export type PhiAdminLogLevel = "debug" | "info" | "warn" | "error";

export type PhiAdminLogRecord = {
  id: string;
  ts: string;
  level: PhiAdminLogLevel;
  service: string;
  event: string;
  message: string;
  siteKey: string | null;
  area: string | null;
  requestId: string | null;
  userId: number | string | null;
  actorRole: string | null;
  pluginKey: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  durationMs: number | null;
  targetType: string | null;
  targetId: number | string | null;
  meta: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
};

export type PhiAdminLogQuery = {
  page: number;
  pageSize: number;
  services: string[];
  levels: PhiAdminLogLevel[];
  event: string;
  requestId: string;
  userId: string;
  area: string;
  targetType: string;
  targetId: string;
  search: string;
  since: string;
  until: string;
};

export type PhiAdminLogResponse = {
  rows: PhiAdminLogRecord[];
  total: number;
  page: number;
  pageSize: number;
};

function asPositiveInt(value: string | null, fallback: number, max = 100) {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function parseCsv(value: string | null, fallback: string[]) {
  const values = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return values.length > 0 ? values : fallback;
}

function resolveJournalUnits() {
  const override = (process.env.PHIS_ADMIN_LOG_JOURNAL_UNITS ?? "").trim();
  if (override) {
    return override
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return ["phi-server-dev.service", "phis-site-skeleton-dev.service"];
}

function normalizeNumber(value: unknown): number | string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }

    return value.trim() || null;
  }

  return null;
}

function normalizeFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function parseLogMessage(message: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(message) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readJournalMessage(value: unknown) {
  if (typeof value === "string") {
    return value.trim();
  }

  return "";
}

function readTimestampMs(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function parseJournalRecord(line: string) {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizeLogRecord(raw: Record<string, unknown>, siteKey: string): PhiAdminLogRecord | null {
  const message = readJournalMessage(raw.MESSAGE);
  if (!message) {
    return null;
  }

  const parsed = parseLogMessage(message);
  if (!parsed) {
    return null;
  }

  const parsedSiteKey = normalizeString(parsed.siteKey);
  if (parsedSiteKey !== siteKey) {
    return null;
  }

  const ts = normalizeString(parsed.ts) || normalizeString(raw.__REALTIME_TIMESTAMP) || new Date().toISOString();
  const level = normalizeString(parsed.level).toLowerCase();
  if (!["debug", "info", "warn", "error"].includes(level)) {
    return null;
  }

  return {
    id: normalizeString(raw.__CURSOR) || `${ts}:${normalizeString(parsed.event)}:${normalizeString(parsed.requestId)}:${normalizeString(parsed.userId)}`,
    ts,
    level: level as PhiAdminLogLevel,
    service: normalizeString(parsed.service) || "site",
    event: normalizeString(parsed.event) || "unknown",
    message: normalizeString(parsed.message) || normalizeString(parsed.event) || "unknown",
    siteKey: parsedSiteKey || null,
    area: normalizeString(parsed.area) || null,
    requestId: normalizeString(parsed.requestId) || null,
    userId: normalizeNumber(parsed.userId),
    actorRole: normalizeString(parsed.actorRole) || null,
    pluginKey: normalizeString(parsed.pluginKey) || null,
    method: normalizeString(parsed.method) || null,
    path: normalizeString(parsed.path) || null,
    status: Number.isInteger(parsed.status) ? (parsed.status as number) : null,
    durationMs: normalizeFiniteNumber(parsed.durationMs),
    targetType: normalizeString(parsed.targetType) || null,
    targetId: normalizeNumber(parsed.targetId),
    meta:
      parsed.meta && typeof parsed.meta === "object" && !Array.isArray(parsed.meta)
        ? (parsed.meta as Record<string, unknown>)
        : null,
    error:
      parsed.error && typeof parsed.error === "object" && !Array.isArray(parsed.error)
        ? (parsed.error as Record<string, unknown>)
        : null,
  };
}

function createLegacyLogRecordId(record: PhiAdminLogRecord) {
  return `${record.ts}:${record.event}:${normalizeString(record.requestId)}:${normalizeString(record.userId)}`;
}

function matchesSearch(record: PhiAdminLogRecord, search: string) {
  if (!search) {
    return true;
  }

  const needle = search.toLowerCase();
  const haystack = JSON.stringify({
    ...record,
    meta: record.meta ?? undefined,
    error: record.error ?? undefined,
  }).toLowerCase();
  return haystack.includes(needle);
}

function matchesLevels(record: PhiAdminLogRecord, levels: PhiAdminLogLevel[]) {
  return levels.length === 0 || levels.includes(record.level);
}

function matchesServices(record: PhiAdminLogRecord, services: string[]) {
  return services.length === 0 || services.includes(record.service);
}

function matchesField(record: PhiAdminLogRecord, field: string, expected: string) {
  if (!expected) {
    return true;
  }

  if (field === "event" && expected.trim().length < 3) {
    return true;
  }

  const value = normalizeString((record as Record<string, unknown>)[field]);
  return value.toLowerCase().startsWith(expected.toLowerCase());
}

function matchesNumericField(record: PhiAdminLogRecord, field: "userId" | "targetId", expected: string) {
  if (!expected) {
    return true;
  }

  const value = record[field];
  return String(value ?? "").toLowerCase() === expected.toLowerCase();
}

export function parsePhiAdminLogQuery(searchParams: URLSearchParams): PhiAdminLogQuery {
  const levels = parseCsv(searchParams.get("level"), [])
    .map((level) => level.toLowerCase())
    .filter((level): level is PhiAdminLogLevel => ["debug", "info", "warn", "error"].includes(level));
  return {
    page: asPositiveInt(searchParams.get("page"), 1, 1000),
    pageSize: asPositiveInt(searchParams.get("pageSize"), 25, 100),
    services: parseCsv(searchParams.get("service"), ["phis", "site", "ui", "cli"]),
    levels,
    event: normalizeString(searchParams.get("event")),
    requestId: normalizeString(searchParams.get("requestId")),
    userId: normalizeString(searchParams.get("userId")),
    area: normalizeString(searchParams.get("area")),
    targetType: normalizeString(searchParams.get("targetType")),
    targetId: normalizeString(searchParams.get("targetId")),
    search: normalizeString(searchParams.get("q")),
    since: normalizeString(searchParams.get("since")),
    until: normalizeString(searchParams.get("until")),
  };
}

async function readPhiSiteAdminLogRecords(siteKey: string, sinceValue: string, untilValue: string) {
  const since = sinceValue.trim() || "24 hours ago";
  const args = [
    "--no-pager",
    "-o",
    "json",
    /*
     * Without this, the entries that matter most are the ones that do not arrive.
     *
     * `-o json` withholds a field it considers too long, handing over `MESSAGE: null` rather than the
     * text -- and the record that trips it is precisely the one carrying a stack trace, which is to
     * say every unhandled failure. Those parse as unreadable here and are dropped, so a search for
     * errors answers "nothing happened" about the only events it could not show.
     */
    "--all",
    "--output-fields=__CURSOR,__REALTIME_TIMESTAMP,MESSAGE",
    "--since",
    since,
  ];

  if (untilValue.trim()) {
    args.push("--until", untilValue.trim());
  }

  for (const unit of resolveJournalUnits()) {
    args.push("-u", unit);
  }

  const child = spawn("journalctl", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stderrChunks: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrChunks.push(chunk);
  });

  const records: PhiAdminLogRecord[] = [];
  const reader = createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });

  for await (const line of reader) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const journalRecord = parseJournalRecord(trimmed);
    const structured = journalRecord ? normalizeLogRecord(journalRecord, siteKey) : null;
    if (structured) {
      records.push(structured);
    }
  }

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });

  if (exitCode !== 0) {
    const stderr = stderrChunks.join("").trim();
    throw new Error(stderr || `journalctl exited with code ${exitCode}.`);
  }

  return records;
}

async function readPhiSiteAdminLogRecordByCursor(siteKey: string, cursor: string) {
  const args = [
    "--no-pager",
    "-o",
    "json",
    // As above: a detail view exists to show the long record, so it must ask for the whole field.
    "--all",
    "--output-fields=__CURSOR,__REALTIME_TIMESTAMP,MESSAGE",
    "--cursor",
    cursor,
    "-n",
    "1",
  ];
  for (const unit of resolveJournalUnits()) {
    args.push("-u", unit);
  }

  const child = spawn("journalctl", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderrChunks: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => stderrChunks.push(chunk));

  let journalRecord: Record<string, unknown> | null = null;
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of reader) {
    journalRecord = parseJournalRecord(line.trim());
    if (journalRecord) break;
  }

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  if (exitCode !== 0) {
    const stderr = stderrChunks.join("").trim();
    throw new Error(stderr || `journalctl exited with code ${exitCode}.`);
  }
  if (normalizeString(journalRecord?.__CURSOR) !== cursor) {
    return null;
  }
  return journalRecord ? normalizeLogRecord(journalRecord, siteKey) : null;
}

export async function readPhiSiteAdminLogs(siteKey: string, query: PhiAdminLogQuery): Promise<PhiAdminLogResponse> {
  const records = await readPhiSiteAdminLogRecords(siteKey, query.since, query.until);

  const filteredRecords = records
    .filter((entry) => matchesServices(entry, query.services))
    .filter((entry) => matchesLevels(entry, query.levels))
    .filter((entry) => matchesField(entry, "event", query.event))
    .filter((entry) => matchesField(entry, "area", query.area))
    .filter((entry) => matchesField(entry, "requestId", query.requestId))
    .filter((entry) => matchesNumericField(entry, "userId", query.userId))
    .filter((entry) => matchesField(entry, "targetType", query.targetType))
    .filter((entry) => matchesNumericField(entry, "targetId", query.targetId))
    .filter((entry) => matchesSearch(entry, query.search))
    .sort((left, right) => readTimestampMs(right.ts) - readTimestampMs(left.ts));

  const total = filteredRecords.length;
  const startIndex = (query.page - 1) * query.pageSize;
  const rows = filteredRecords.slice(startIndex, startIndex + query.pageSize);

  return {
    rows,
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function readPhiSiteAdminLog(siteKey: string, recordId: string) {
  const normalizedRecordId = recordId.trim();
  if (!normalizedRecordId) {
    return null;
  }

  if (normalizedRecordId.startsWith("s=")) {
    return readPhiSiteAdminLogRecordByCursor(siteKey, normalizedRecordId);
  }

  const timestampMatch = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z):/.exec(normalizedRecordId);
  if (!timestampMatch) {
    return null;
  }
  const timestamp = Date.parse(timestampMatch[1]);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  const records = await readPhiSiteAdminLogRecords(
    siteKey,
    new Date(timestamp - 1_000).toISOString(),
    new Date(timestamp + 1_000).toISOString(),
  );
  return records.find((record) => createLegacyLogRecordId(record) === normalizedRecordId) ?? null;
}
