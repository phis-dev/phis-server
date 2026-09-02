/**
 * Watching an upload body for the two ways it stops arriving without stopping.
 *
 * A reservation has an expiry, which is the outer bound on a whole upload. It is not what catches a
 * Client that walks away mid-body: the session is valid, the request is open, and Core would wait on a
 * socket nobody is writing to for as long as the network is willing to pretend it is alive. Two
 * distinct endings hide behind that, and the difference is worth keeping:
 *
 * - The Client is gone. The transport says so, and there is nobody left to answer. Ordinary -- a
 *   closed tab is not a Server fault, and logging it as one buries the faults that are.
 * - The Client is silent. The connection is open and no byte has arrived for `stallTimeoutMs`. Nothing
 *   says so; the absence of bytes is the only evidence, so it has to be measured.
 *
 * Both are aborts, and the abort is raised on the stream itself rather than only handed to the Adapter.
 * The `signal` on `PhisMediaObjectStreamInput` is optional, so an Adapter is entitled to ignore it --
 * ending the read is what makes the write end regardless of who wrote the Provider.
 */

export const PHI_MEDIA_UPLOAD_STALL_TIMEOUT_MS = 30_000;

export const PhiMediaUploadAbort = {
  ClientGone: "client_gone",
  Stalled: "stalled",
} as const;

export type PhiMediaUploadAbortValue =
  (typeof PhiMediaUploadAbort)[keyof typeof PhiMediaUploadAbort];

export class PhiMediaUploadAbortError extends Error {
  readonly abortedBy: PhiMediaUploadAbortValue;

  constructor(abortedBy: PhiMediaUploadAbortValue, receivedBytes: number) {
    super(
      abortedBy === PhiMediaUploadAbort.Stalled
        ? `Upload stalled after ${receivedBytes} byte(s).`
        : `Upload abandoned by the client after ${receivedBytes} byte(s).`,
    );
    this.name = "PhiMediaUploadAbortError";
    this.abortedBy = abortedBy;
  }
}

export type PhiMediaUploadBodyWatch = {
  /** The same bytes, passed through untouched, ending in an abort when one of the two endings happens. */
  body: ReadableStream<Uint8Array>;
  signal: AbortSignal;
  /** Which ending this was, or `null` while the body is still arriving or has arrived in full. */
  abortedBy: () => PhiMediaUploadAbortValue | null;
  /** How much had arrived. A slow network and a dead one look identical without it. */
  receivedBytes: () => number;
  /** Drops the timer. Required on every path, or a finished upload keeps one pending. */
  release: () => void;
};

export function watchPhiMediaUploadBody(
  body: ReadableStream<Uint8Array>,
  options?: { clientSignal?: AbortSignal | null; stallTimeoutMs?: number },
): PhiMediaUploadBodyWatch {
  const stallTimeoutMs = options?.stallTimeoutMs ?? PHI_MEDIA_UPLOAD_STALL_TIMEOUT_MS;
  const controller = new AbortController();
  let abortedBy: PhiMediaUploadAbortValue | null = null;
  let receivedBytes = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const abort = (reason: PhiMediaUploadAbortValue) => {
    // First ending wins. A Client that vanishes exactly as the timer fires has one reason, not two,
    // and it is the one that happened first.
    if (abortedBy !== null || controller.signal.aborted) return;
    abortedBy = reason;
    clearTimer();
    controller.abort(new PhiMediaUploadAbortError(reason, receivedBytes));
  };

  // Armed before the first byte as well as between bytes: a Client that opens the request and sends
  // nothing at all is the same silence, and it would otherwise wait forever rather than for a while.
  const arm = () => {
    clearTimer();
    if (stallTimeoutMs > 0) {
      timer = setTimeout(() => abort(PhiMediaUploadAbort.Stalled), stallTimeoutMs);
      timer.unref?.();
    }
  };

  const clientSignal = options?.clientSignal ?? null;
  if (clientSignal) {
    if (clientSignal.aborted) abort(PhiMediaUploadAbort.ClientGone);
    else clientSignal.addEventListener("abort", () => abort(PhiMediaUploadAbort.ClientGone), { once: true });
  }

  const meter = new TransformStream<Uint8Array, Uint8Array>({
    start() {
      arm();
    },
    transform(chunk, chunkController) {
      receivedBytes += chunk.byteLength;
      arm();
      chunkController.enqueue(chunk);
    },
    flush() {
      clearTimer();
    },
  });

  return {
    body: body.pipeThrough(meter, { signal: controller.signal }),
    signal: controller.signal,
    abortedBy: () => abortedBy,
    receivedBytes: () => receivedBytes,
    release: clearTimer,
  };
}
