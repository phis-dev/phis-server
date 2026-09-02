import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  PhisLocalMediaStorageAdapter,
  resolvePhisMediaStorageConfig,
} from "@/lib/media-storage";
import {
  PHI_MEDIA_UPLOAD_STALL_TIMEOUT_MS,
  PhiMediaUploadAbort,
  PhiMediaUploadAbortError,
  watchPhiMediaUploadBody,
} from "@/lib/media-upload-stream";

const roots: string[] = [];
async function localAdapter() {
  const rootDir = await mkdtemp(join(tmpdir(), "phi-upload-stream-"));
  roots.push(rootDir);
  return { adapter: new PhisLocalMediaStorageAdapter(resolvePhisMediaStorageConfig({ rootDir })), rootDir };
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const drain = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
};

/** A body that yields what it is given and then simply stops, without ending. */
function silentAfter(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = chunks.shift();
      if (next) {
        controller.enqueue(next);
        return;
      }
      await new Promise(() => {});
    },
  });
}

describe("watching an upload body", () => {
  it("passes an ordinary body through byte for byte", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
        controller.close();
      },
    });
    const watch = watchPhiMediaUploadBody(body);

    const seen: number[] = [];
    const reader = watch.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen.push(...value);
    }
    watch.release();

    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(watch.receivedBytes()).toBe(5);
    // Nothing went wrong, so nothing is reported as having gone wrong.
    expect(watch.abortedBy()).toBeNull();
    expect(watch.signal.aborted).toBe(false);
  });

  it("ends a body that falls silent, and says how far it got", async () => {
    const watch = watchPhiMediaUploadBody(silentAfter([new Uint8Array([1, 2, 3, 4])]), {
      stallTimeoutMs: 20,
    });

    await expect(drain(watch.body)).rejects.toBeDefined();
    expect(watch.abortedBy()).toBe(PhiMediaUploadAbort.Stalled);
    expect(watch.receivedBytes()).toBe(4);
    expect(watch.signal.reason).toBeInstanceOf(PhiMediaUploadAbortError);
    watch.release();
  });

  it("ends a body that never sends a first byte", async () => {
    // The silence before the first chunk is the same silence, and would otherwise wait forever
    // rather than for a while.
    const watch = watchPhiMediaUploadBody(silentAfter([]), { stallTimeoutMs: 20 });

    await expect(drain(watch.body)).rejects.toBeDefined();
    expect(watch.abortedBy()).toBe(PhiMediaUploadAbort.Stalled);
    expect(watch.receivedBytes()).toBe(0);
    watch.release();
  });

  it("does not call a slow but living body stalled", async () => {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        controller.enqueue(new Uint8Array([7]));
        if (++sent >= 4) controller.close();
      },
    });

    // Each gap is under the timeout even though the whole transfer is well over it: the measure is
    // between bytes, not across the upload.
    const watch = watchPhiMediaUploadBody(body, { stallTimeoutMs: 40 });
    await drain(watch.body);
    watch.release();

    expect(watch.abortedBy()).toBeNull();
    expect(watch.receivedBytes()).toBe(4);
  });

  it("reports a departed client as a departure, not as silence", async () => {
    const client = new AbortController();
    const watch = watchPhiMediaUploadBody(silentAfter([new Uint8Array([9])]), {
      clientSignal: client.signal,
      stallTimeoutMs: 5_000,
    });

    const drained = drain(watch.body);
    await new Promise((resolve) => setTimeout(resolve, 10));
    client.abort();

    await expect(drained).rejects.toBeDefined();
    expect(watch.abortedBy()).toBe(PhiMediaUploadAbort.ClientGone);
    watch.release();
  });

  it("takes a client that had already gone before the read began", async () => {
    const watch = watchPhiMediaUploadBody(silentAfter([]), {
      clientSignal: AbortSignal.abort(),
      stallTimeoutMs: 5_000,
    });

    await expect(drain(watch.body)).rejects.toBeDefined();
    expect(watch.abortedBy()).toBe(PhiMediaUploadAbort.ClientGone);
    watch.release();
  });

  it("keeps the first ending when a second follows", async () => {
    const client = new AbortController();
    const watch = watchPhiMediaUploadBody(silentAfter([]), {
      clientSignal: client.signal,
      stallTimeoutMs: 20,
    });

    await expect(drain(watch.body)).rejects.toBeDefined();
    client.abort();

    // The timer fired first; a Client that gives up afterwards does not rewrite what happened.
    expect(watch.abortedBy()).toBe(PhiMediaUploadAbort.Stalled);
    watch.release();
  });

  it("leaves no object behind when the write is aborted", async () => {
    const { adapter, rootDir } = await localAdapter();
    const watch = watchPhiMediaUploadBody(silentAfter([new Uint8Array([1, 2, 3])]), {
      stallTimeoutMs: 20,
    });

    await expect(
      adapter.putObjectStream({
        storageKey: "staging/torn.bin",
        body: watch.body,
        contentType: "application/octet-stream",
        signal: watch.signal,
      }),
    ).rejects.toBeDefined();
    watch.release();

    // The half-written file is what a sweep would otherwise have to find later.
    expect(await adapter.headObject("staging/torn.bin")).toBeNull();
    const staging = await readdir(join(rootDir, "staging")).catch(() => []);
    expect(staging).toEqual([]);
  });

  it("has a default timeout that is a transfer gap and not a whole upload", () => {
    // Small enough that a dead connection is noticed, large enough that a stalled mobile network is
    // not called dead. It bounds the gap between two bytes; the upload as a whole is bounded by the
    // reservation's expiry.
    expect(PHI_MEDIA_UPLOAD_STALL_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    expect(PHI_MEDIA_UPLOAD_STALL_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });
});
