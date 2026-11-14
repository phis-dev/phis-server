import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runPhiEmailTest } from "../cli/email-test.mts";
import { readPhiEmailTestStatus } from "../cli/setup.mts";
import { readPhiEmailTestRecord, resolvePhiEmailTestRecordPath } from "./email-test-record.ts";
import { sendPhiTestEmail } from "./email-test.ts";
import { attemptPhiMailDelivery, classifyPhiSmtpError, readPhiSmtpQueueId, sendPhiMail } from "./email-transport.ts";

type Refuse = "mail" | "rcpt" | null;

/**
 * A minimal SMTP server on the loopback: enough of RFC 5321 for nodemailer to deliver one message, and
 * able to refuse the sender or the recipient. Records what it was sent.
 */
async function startFakeSmtp(refuse: Refuse = null) {
  const received: { from: string; to: string; data: string }[] = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    let inData = false;
    let current = { from: "", to: "", data: "" };
    socket.write("220 fake.test ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index: number;
      while ((index = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            received.push(current);
            current = { from: "", to: "", data: "" };
            socket.write("250 2.0.0 Ok: queued as 4ABCDEF123\r\n");
          } else {
            current.data += `${line}\n`;
          }
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO" || verb === "HELO") socket.write("250-fake.test\r\n250 8BITMIME\r\n");
        else if (verb === "MAIL") {
          if (refuse === "mail") socket.write("553 5.7.1 Sender address rejected: not owned by user\r\n");
          else {
            current.from = line;
            socket.write("250 2.1.0 Ok\r\n");
          }
        } else if (verb === "RCPT") {
          if (refuse === "rcpt") socket.write("550 5.1.1 Recipient address rejected: User unknown\r\n");
          else {
            current.to = line;
            socket.write("250 2.1.5 Ok\r\n");
          }
        } else if (verb === "DATA") {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (verb === "RSET" || verb === "NOOP") socket.write("250 2.0.0 Ok\r\n");
        else if (verb === "QUIT") {
          socket.write("221 2.0.0 Bye\r\n");
          socket.end();
        } else socket.write("502 5.5.2 Error: command not recognized\r\n");
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  servers.push(server);
  return { target: `127.0.0.1:${port}`, received };
}

/** A port on the loopback nothing listens on. */
async function closedTarget() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `127.0.0.1:${port}`;
}

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function emailConfig(targets: string[]) {
  return { from: "noreply@phis.test", fromName: "phis test", smtp: { targets, secure: false, ignoreTls: false } };
}

function scratchStage(runtime: object) {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "phis-email-test-")), "stage");
  mkdirSync(path.join(root, "config"), { recursive: true });
  writeFileSync(path.join(root, "config", "phis-config.json"), "{}\n");
  writeFileSync(path.join(root, "config", "phis-runtime.json"), `${JSON.stringify(runtime)}\n`);
  return root;
}

const message = { to: "someone@phis.test", subject: "s", text: "t" };

describe("attemptPhiMailDelivery", () => {
  it("tries the targets in order and reports each, stopping at the first that accepts", async () => {
    const down = await closedTarget();
    const refusing = await startFakeSmtp("rcpt");
    const accepting = await startFakeSmtp();
    const unused = await startFakeSmtp();

    const report = await attemptPhiMailDelivery(message, emailConfig([down, refusing.target, accepting.target, unused.target]));

    expect(report.from).toBe("phis test <noreply@phis.test>");
    expect(report.attempts.map((attempt) => [attempt.target, attempt.ok ? "ok" : attempt.stage])).toEqual([
      [down, "connect"],
      [refusing.target, "recipient"],
      [accepting.target, "ok"],
    ]);
    const refused = report.attempts[1];
    expect(refused.ok === false && refused.response).toMatch(/^550 5\.1\.1/);
    expect(report.accepted).toMatchObject({
      target: accepting.target,
      response: "250 2.0.0 Ok: queued as 4ABCDEF123",
      queueId: "4ABCDEF123",
    });
    expect(accepting.received).toHaveLength(1);
    expect(accepting.received[0].from).toContain("noreply@phis.test");
    expect(unused.received).toHaveLength(0);
  });

  it("names a refused sender, and accepts nothing when every target fails", async () => {
    const refusing = await startFakeSmtp("mail");
    const report = await attemptPhiMailDelivery(message, emailConfig([refusing.target]));
    expect(report.accepted).toBeNull();
    expect(report.attempts).toMatchObject([{ ok: false, stage: "sender" }]);
  });

  it("has no attempt when no target is configured", async () => {
    expect((await attemptPhiMailDelivery(message, emailConfig([]))).attempts).toEqual([]);
  });
});

describe("sendPhiMail, the server's path", () => {
  it("still falls through to the next target and throws only the last error", async () => {
    const accepting = await startFakeSmtp();
    await expect(sendPhiMail(message, emailConfig([await closedTarget(), accepting.target]))).resolves.toEqual(
      expect.any(String),
    );
    const refusing = await startFakeSmtp("rcpt");
    await expect(sendPhiMail(message, emailConfig([await closedTarget(), refusing.target]))).rejects.toMatchObject({
      command: "RCPT TO",
    });
  });
});

describe("the SMTP error classes", () => {
  it("follow nodemailer's code and command", () => {
    expect(classifyPhiSmtpError({ code: "ECONNECTION", command: "CONN", message: "connect ECONNREFUSED" })).toBe("connect");
    expect(classifyPhiSmtpError({ code: "ETLS", command: "STARTTLS", message: "x" })).toBe("tls");
    expect(classifyPhiSmtpError({ code: "ESOCKET", command: "CONN", message: "self-signed certificate" })).toBe("tls");
    expect(classifyPhiSmtpError({ code: "EAUTH", command: "AUTH PLAIN", message: "Invalid login" })).toBe("auth");
    expect(classifyPhiSmtpError({ code: "EENVELOPE", command: "MAIL FROM", message: "x" })).toBe("sender");
    expect(classifyPhiSmtpError({ code: "EENVELOPE", command: "RCPT TO", message: "x" })).toBe("recipient");
    expect(classifyPhiSmtpError({ code: "EMESSAGE", command: "DATA", message: "x" })).toBe("data");
  });

  it("read the queue id from the answers relays give", () => {
    expect(readPhiSmtpQueueId("250 2.0.0 Ok: queued as 4ABCDEF123")).toBe("4ABCDEF123");
    expect(readPhiSmtpQueueId("250 OK id=1tAbCd-000123-Xy")).toBe("1tAbCd-000123-Xy");
    expect(readPhiSmtpQueueId("250 2.0.0 Ok")).toBeNull();
  });
});

describe("a test email", () => {
  it("records the accepted target in config/, and setup status reads it", async () => {
    const accepting = await startFakeSmtp();
    const root = scratchStage({ email: emailConfig([accepting.target]) });
    expect(readPhiEmailTestStatus(root).record).toBeNull();

    const result = await runPhiEmailTest(root, { to: "Operator@Phis.Test", siteKey: null }, async () => null);

    expect(result.report.accepted?.target).toBe(accepting.target);
    expect(result.recordPath).toBe(resolvePhiEmailTestRecordPath(root));
    expect(readPhiEmailTestRecord(root)).toMatchObject({
      version: 1,
      to: "operator@phis.test",
      from: "phis test <noreply@phis.test>",
      siteKey: null,
      target: accepting.target,
      queueId: "4ABCDEF123",
      via: "cli",
    });
    expect(readPhiEmailTestStatus(root).detail).toContain(`accepted by ${accepting.target}`);
    expect(accepting.received[0].data).toContain("Subject: phis test email");
  });

  it("uses the Site's own sender with a Site, and records nothing when no target accepted", async () => {
    const refusing = await startFakeSmtp("rcpt");
    const root = scratchStage({ email: emailConfig([refusing.target]) });
    const result = await runPhiEmailTest(root, { to: "a@phis.test", siteKey: "acme" }, async (key) =>
      key === "acme" ? { mailFrom: "no-reply@acme.test", mailFromName: "Acme" } : null);

    expect(result.report.from).toBe("Acme <no-reply@acme.test>");
    expect(result.report.accepted).toBeNull();
    expect(result.recordPath).toBeNull();
    expect(readPhiEmailTestRecord(root)).toBeNull();
    await expect(runPhiEmailTest(root, { to: "a@phis.test", siteKey: "nope" }, async () => null)).rejects.toThrow(
      "No Site nope.",
    );
  });

  it("refuses an address that is none before connecting", async () => {
    const root = scratchStage({});
    await expect(sendPhiTestEmail({ root, emailConfig: emailConfig([]), to: "nobody", site: null, via: "operator" }))
      .rejects.toThrow("no email address");
    expect(() => readFileSync(resolvePhiEmailTestRecordPath(root))).toThrow();
  });
});
