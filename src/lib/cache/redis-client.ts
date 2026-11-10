import net from "node:net";
import tls from "node:tls";

/**
 * As much of a Redis client as Core needs, and no more.
 *
 * Core asks a shared cache one question today (count this, tell me when it expires), and a library that
 * speaks all of Redis is several megabytes of it. This speaks RESP2 over one connection: commands go
 * out in order, replies come back in order, and a connection that breaks or falls silent is dropped
 * with every waiting command refused, so nothing is ever answered with another command's reply.
 *
 * It never retries by itself. Whoever calls it has a fallback for the answer it could not get, and a
 * retry here would only make that caller wait for a server that is not there. After a failed connect
 * it refuses at once for a short while instead of paying the connect timeout on every call.
 */

export type PhisRedisReply = string | number | null | PhisRedisReply[];

export class PhisRedisUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhisRedisUnavailableError";
  }
}

/** The server understood the command and refused it; the connection is intact. */
export class PhisRedisReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhisRedisReplyError";
  }
}

export type PhisRedisClientOptions = {
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  /** How long a failed connect is remembered before the next attempt. */
  retryAfterMs?: number;
};

export type PhisRedisClient = {
  command(args: readonly (string | number)[]): Promise<PhisRedisReply>;
  close(): void;
};

type Pending = {
  resolve: (reply: PhisRedisReply) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Parsed = { value: PhisRedisReply | PhisRedisReplyError; next: number };

const LINE_END = Buffer.from([13, 10]);

export function encodePhisRedisCommand(args: readonly (string | number)[]) {
  const parts: Buffer[] = [Buffer.from(`*${args.length}`), LINE_END];
  for (const arg of args) {
    const body = Buffer.from(String(arg), "utf8");
    parts.push(Buffer.from(`$${body.length}`), LINE_END, body, LINE_END);
  }
  return Buffer.concat(parts);
}

/** One reply from `buffer` at `offset`, or null while it has not arrived completely. */
export function parsePhisRedisReply(buffer: Buffer, offset = 0): Parsed | null {
  const lineEnd = buffer.indexOf(LINE_END, offset);
  if (lineEnd < 0) return null;
  const type = String.fromCharCode(buffer[offset]!);
  const line = buffer.toString("utf8", offset + 1, lineEnd);
  const next = lineEnd + 2;
  switch (type) {
    case "+":
      return { value: line, next };
    case "-":
      return { value: new PhisRedisReplyError(line), next };
    case ":":
      return { value: Number(line), next };
    case "$": {
      const length = Number(line);
      if (length < 0) return { value: null, next };
      if (buffer.length < next + length + 2) return null;
      return { value: buffer.toString("utf8", next, next + length), next: next + length + 2 };
    }
    case "*": {
      const count = Number(line);
      if (count < 0) return { value: null, next };
      const items: PhisRedisReply[] = [];
      let cursor = next;
      for (let index = 0; index < count; index += 1) {
        const item = parsePhisRedisReply(buffer, cursor);
        if (!item) return null;
        // An error inside an array is that slot's answer; no command Core sends produces one.
        items.push(item.value instanceof PhisRedisReplyError ? item.value.message : item.value);
        cursor = item.next;
      }
      return { value: items, next: cursor };
    }
    default:
      throw new PhisRedisUnavailableError(`Unexpected reply type "${type}".`);
  }
}

function readTarget(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    throw new Error("A cache address starts with redis:// or rediss://.");
  }
  const database = parsed.pathname.replace(/^\//, "");
  if (database && !/^\d+$/.test(database)) {
    throw new Error("The path of a cache address is a database number.");
  }
  return {
    secure: parsed.protocol === "rediss:",
    host: parsed.hostname || "127.0.0.1",
    port: parsed.port ? Number(parsed.port) : 6379,
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: database ? Number(database) : 0,
  };
}

export function createPhisRedisClient(url: string, options: PhisRedisClientOptions = {}): PhisRedisClient {
  const target = readTarget(url);
  const connectTimeoutMs = options.connectTimeoutMs ?? 1_000;
  const commandTimeoutMs = options.commandTimeoutMs ?? 1_000;
  const retryAfterMs = options.retryAfterMs ?? 5_000;

  let socket: net.Socket | null = null;
  let connecting: Promise<net.Socket> | null = null;
  let pending: Pending[] = [];
  let received: Buffer = Buffer.alloc(0);
  let refuseUntil = 0;
  let closed = false;

  function drop(reason: string) {
    const failed = pending;
    pending = [];
    received = Buffer.alloc(0);
    const current = socket;
    socket = null;
    current?.destroy();
    for (const entry of failed) {
      clearTimeout(entry.timer);
      entry.reject(new PhisRedisUnavailableError(reason));
    }
  }

  function onData(chunk: Buffer) {
    received = received.length === 0 ? chunk : Buffer.concat([received, chunk]);
    let offset = 0;
    try {
      for (;;) {
        const parsed = parsePhisRedisReply(received, offset);
        if (!parsed) break;
        offset = parsed.next;
        const entry = pending.shift();
        if (!entry) {
          // A reply nobody asked for means the stream and the queue no longer agree.
          drop("The cache sent an unexpected reply.");
          return;
        }
        clearTimeout(entry.timer);
        if (parsed.value instanceof PhisRedisReplyError) entry.reject(parsed.value);
        else entry.resolve(parsed.value);
      }
    } catch (error) {
      drop(error instanceof Error ? error.message : "The cache reply could not be read.");
      return;
    }
    received = offset === 0 ? received : received.subarray(offset);
  }

  function send(connection: net.Socket, args: readonly (string | number)[]) {
    return new Promise<PhisRedisReply>((resolve, reject) => {
      pending.push({
        resolve,
        reject,
        // A reply that never comes cannot be skipped: every later reply would belong to the wrong command.
        timer: setTimeout(() => drop("The cache did not answer in time."), commandTimeoutMs),
      });
      connection.write(encodePhisRedisCommand(args));
    });
  }

  function connect(): Promise<net.Socket> {
    if (socket) return Promise.resolve(socket);
    if (connecting) return connecting;
    if (Date.now() < refuseUntil) {
      return Promise.reject(new PhisRedisUnavailableError("The cache was unreachable a moment ago."));
    }
    connecting = new Promise<net.Socket>((resolve, reject) => {
      const opened = target.secure
        ? tls.connect({ host: target.host, port: target.port, servername: target.host })
        : net.connect({ host: target.host, port: target.port });
      let settled = false;
      const fail = (reason: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opened.destroy();
        refuseUntil = Date.now() + retryAfterMs;
        reject(new PhisRedisUnavailableError(reason));
      };
      const timer = setTimeout(() => fail("The cache did not accept a connection in time."), connectTimeoutMs);
      opened.once("error", (error) => fail(error.message));
      opened.once(target.secure ? "secureConnect" : "connect", () => {
        opened.on("data", onData);
        opened.on("error", () => { if (socket === opened) drop("The cache connection failed."); });
        opened.on("close", () => { if (socket === opened) drop("The cache closed the connection."); });
        socket = opened;
        // The handshake travels as ordinary commands, ahead of anything a caller is waiting to send.
        const steps: Promise<PhisRedisReply>[] = [];
        if (target.password) {
          steps.push(send(opened, target.username
            ? ["AUTH", target.username, target.password]
            : ["AUTH", target.password]));
        }
        if (target.database !== 0) steps.push(send(opened, ["SELECT", target.database]));
        Promise.all(steps).then(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(opened);
        }, (error: unknown) => {
          if (socket === opened) drop("The cache refused the handshake.");
          fail(error instanceof Error ? error.message : "The cache refused the handshake.");
        });
      });
    }).finally(() => { connecting = null; });
    return connecting;
  }

  return {
    async command(args) {
      if (closed) throw new PhisRedisUnavailableError("The cache client is closed.");
      return send(await connect(), args);
    },
    close() {
      closed = true;
      drop("The cache client is closed.");
    },
  };
}
