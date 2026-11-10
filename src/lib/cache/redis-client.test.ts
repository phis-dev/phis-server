import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  PhisRedisReplyError,
  PhisRedisUnavailableError,
  createPhisRedisClient,
  encodePhisRedisCommand,
  parsePhisRedisReply,
  type PhisRedisClient,
} from "./redis-client";

/**
 * A server that speaks just enough RESP to be talked to: it reads commands off the wire with the
 * client's own parser (a command is an array of bulk strings) and answers what the test says.
 */
type Answer = string | null;

async function startServer(answer: (args: string[]) => Answer) {
  const seen: string[][] = [];
  let connections = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const parsed = parsePhisRedisReply(buffer);
        if (!parsed) break;
        buffer = buffer.subarray(parsed.next);
        const args = (parsed.value as string[]).map(String);
        seen.push(args);
        const reply = answer(args);
        if (reply !== null) socket.write(reply);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    seen,
    connections: () => connections,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

const OK = "+OK\r\n";

describe("the Redis wire format", () => {
  it("writes a command as an array of bulk strings, counted in bytes", () => {
    expect(encodePhisRedisCommand(["SET", "k", "é", 5]).toString("utf8"))
      .toBe("*4\r\n$3\r\nSET\r\n$1\r\nk\r\n$2\r\né\r\n$1\r\n5\r\n");
  });

  it("reads each kind of reply and says where the next one starts", () => {
    expect(parsePhisRedisReply(Buffer.from("+PONG\r\n"))).toEqual({ value: "PONG", next: 7 });
    expect(parsePhisRedisReply(Buffer.from(":42\r\n"))?.value).toBe(42);
    expect(parsePhisRedisReply(Buffer.from("$-1\r\n"))?.value).toBeNull();
    expect(parsePhisRedisReply(Buffer.from("$2\r\né\r\n"))?.value).toBe("é");
    expect(parsePhisRedisReply(Buffer.from("*2\r\n:3\r\n:60000\r\n"))?.value).toEqual([3, 60000]);
    expect(parsePhisRedisReply(Buffer.from("-ERR no\r\n"))?.value).toBeInstanceOf(PhisRedisReplyError);
  });

  it("waits for the rest of a reply that has only partly arrived", () => {
    expect(parsePhisRedisReply(Buffer.from("+PON"))).toBeNull();
    expect(parsePhisRedisReply(Buffer.from("$5\r\nabc"))).toBeNull();
    expect(parsePhisRedisReply(Buffer.from("*2\r\n:3\r\n"))).toBeNull();
  });
});

describe("the Redis client", () => {
  let client: PhisRedisClient | null = null;
  let server: Awaited<ReturnType<typeof startServer>> | null = null;

  afterEach(async () => {
    client?.close();
    client = null;
    await server?.close();
    server = null;
  });

  it("answers each command with its own reply, in the order they were sent", async () => {
    server = await startServer((args) => `$${args[1]!.length}\r\n${args[1]}\r\n`);
    client = createPhisRedisClient(`redis://127.0.0.1:${server.port}`);

    const replies = await Promise.all([
      client.command(["ECHO", "first"]),
      client.command(["ECHO", "second"]),
      client.command(["ECHO", "third"]),
    ]);

    expect(replies).toEqual(["first", "second", "third"]);
    expect(server.connections()).toBe(1);
  });

  it("signs in and selects the database before the first command", async () => {
    server = await startServer(() => OK);
    client = createPhisRedisClient(`redis://app:s%40cret@127.0.0.1:${server.port}/3`);

    await client.command(["PING"]);

    expect(server.seen).toEqual([["AUTH", "app", "s@cret"], ["SELECT", "3"], ["PING"]]);
  });

  it("reports a refused command and keeps the connection for the next one", async () => {
    server = await startServer((args) => args[0] === "BAD" ? "-ERR unknown command\r\n" : OK);
    client = createPhisRedisClient(`redis://127.0.0.1:${server.port}`);

    await expect(client.command(["BAD"])).rejects.toBeInstanceOf(PhisRedisReplyError);
    await expect(client.command(["PING"])).resolves.toBe("OK");
    expect(server.connections()).toBe(1);
  });

  it("drops a connection that falls silent, and connects anew for the next command", async () => {
    let silent = true;
    server = await startServer(() => silent ? null : OK);
    client = createPhisRedisClient(`redis://127.0.0.1:${server.port}`, { commandTimeoutMs: 40 });

    await expect(client.command(["PING"])).rejects.toBeInstanceOf(PhisRedisUnavailableError);
    silent = false;
    await expect(client.command(["PING"])).resolves.toBe("OK");
    // A late reply on the old connection could only have answered the wrong command.
    expect(server.connections()).toBe(2);
  });

  it("refuses at once for a while after a failed connect, instead of trying on every call", async () => {
    server = await startServer(() => OK);
    const port = server.port;
    await server.close();
    server = null;
    client = createPhisRedisClient(`redis://127.0.0.1:${port}`, { retryAfterMs: 60_000 });

    await expect(client.command(["PING"])).rejects.toBeInstanceOf(PhisRedisUnavailableError);
    const started = Date.now();
    await expect(client.command(["PING"])).rejects.toThrow(/a moment ago/);
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("refuses an address that is not a Redis address", () => {
    expect(() => createPhisRedisClient("http://127.0.0.1:6379")).toThrow(/redis:\/\//);
    expect(() => createPhisRedisClient("redis://127.0.0.1:6379/cache")).toThrow(/database number/);
  });
});
