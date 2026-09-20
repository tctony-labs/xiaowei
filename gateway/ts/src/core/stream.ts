import { type GatewayError, GatewayFailure, invalid } from "./protocol.js";

export interface StreamPolicy {
  maxChunkBytes: number;
  queueItems: number;
  queueBytes: number;
  maxOwnerStreams: number;
  maxCallerStreams: number;
  openTimeoutMs: number;
  producerIdleMs: number;
  consumerIdleMs: number;
  totalMs: number;
}
export const DEFAULT_STREAM_POLICY: Readonly<StreamPolicy> = Object.freeze({
  maxChunkBytes: 1024 * 1024,
  queueItems: 16,
  queueBytes: 4 * 1024 * 1024,
  maxOwnerStreams: 128,
  maxCallerStreams: 32,
  openTimeoutMs: 10_000,
  producerIdleMs: 60_000,
  consumerIdleMs: 60_000,
  totalMs: 0,
});
export function streamPolicy(options: Partial<StreamPolicy> = {}): StreamPolicy {
  const policy = { ...DEFAULT_STREAM_POLICY, ...options };
  for (const [name, value] of Object.entries(policy)) {
    const max =
      name === "maxChunkBytes" || name === "queueBytes"
        ? 64 * 1024 * 1024
        : name.endsWith("Streams") || name === "queueItems"
          ? 4096
          : 2_147_483_647;
    if (!Number.isSafeInteger(value) || value < (name === "totalMs" ? 0 : 1) || value > max)
      invalid(`invalid stream policy: ${name}`);
  }
  return policy;
}
export interface ResponseStream<T> extends AsyncIterableIterator<T> {
  return(): Promise<IteratorResult<T>>;
  readonly policy: Readonly<StreamPolicy>;
  readonly closed: Promise<void>;
  cancel(): Promise<void>;
}
export interface StreamOptions {
  signal?: AbortSignal;
}
export type ByteSource = AsyncIterable<Uint8Array>;
export const streamError = (code: GatewayError["code"], message: string) => new GatewayFailure({ code, message });

/** Registers cancellation before opening; no source.next() until the consumer requests it. */
export async function openStream(
  factory: (signal: AbortSignal) => Promise<ByteSource> | ByteSource,
  policy: StreamPolicy,
  options: StreamOptions = {},
  released: () => void = () => {},
): Promise<ResponseStream<Uint8Array>> {
  let settled!: () => void;
  const closed = new Promise<void>((resolve) => {
    settled = resolve;
  });
  let activeWork: Promise<unknown> = Promise.resolve();
  const controller = new AbortController();
  let source: AsyncIterator<Uint8Array> | undefined;
  let terminal: Error | "end" | undefined;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let total: ReturnType<typeof setTimeout> | undefined;
  let rejectPending: ((error: Error) => void) | undefined;
  let cleanup: Promise<void> = Promise.resolve();
  let actualCleanup: Promise<unknown> = Promise.resolve();
  const dispose = () => {
    if (!source?.return) return;
    const iterator = source;
    source = undefined;
    actualCleanup = Promise.resolve().then(() => iterator.return?.());
    void actualCleanup.catch(() => {});
  };
  const finish = (reason: Error | "end") => {
    if (terminal) return;
    terminal = reason;
    clearTimeout(timer);
    clearTimeout(total);
    options.signal?.removeEventListener("abort", abort);
    controller.abort(reason);
    rejectPending?.(reason === "end" ? streamError("CANCELLED", "stream ended") : reason);
    dispose();
    settled();
    const completed = activeWork.catch(() => {}).then(() => actualCleanup);
    cleanup = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(streamError("TIMEOUT", "producer cleanup timed out")), 1000);
      completed.then(
        () => {
          clearTimeout(timeout);
          resolve();
        },
        (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    });
    void cleanup.catch(() => {});
    void completed.catch(() => {}).then(released);
  };
  const abort = () =>
    finish(
      options.signal?.reason instanceof GatewayFailure
        ? options.signal.reason
        : streamError("CANCELLED", "stream cancelled"),
    );
  const deadline = (ms: number, phase: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => finish(streamError("TIMEOUT", `${phase} timed out`)), ms);
  };
  const race = <T>(work: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      rejectPending = reject;
      work.then(resolve, reject);
      if (terminal) reject(terminal);
    });
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  if (terminal) throw terminal;
  deadline(policy.openTimeoutMs, "stream open");
  try {
    activeWork = Promise.resolve()
      .then(() => {
        if (terminal) throw terminal;
        return factory(controller.signal);
      })
      .then((iterable) => {
        source = iterable[Symbol.asyncIterator]();
        if (terminal) dispose();
      });
    await race(activeWork);
  } catch (error) {
    finish(error instanceof Error ? error : streamError("HANDLER_ERROR", "stream open failed"));
    throw terminal;
  }
  rejectPending = undefined;
  deadline(policy.consumerIdleMs, "consumer idle");
  if (policy.totalMs)
    total = setTimeout(() => finish(streamError("TIMEOUT", "stream total timed out")), policy.totalMs);
  const stream: ResponseStream<Uint8Array> = {
    policy: Object.freeze({ ...policy }),
    closed,
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (terminal === "end") return { done: true, value: undefined };
      if (terminal) throw terminal;
      if (busy) throw streamError("CONCURRENCY_FULL", "one pending next per stream");
      busy = true;
      deadline(policy.producerIdleMs, "producer idle");
      try {
        const iterator = source;
        if (!iterator) throw streamError("HANDLER_ERROR", "missing stream source");
        const work = Promise.resolve().then(() => iterator.next());
        activeWork = work;
        const item = await race(work);
        rejectPending = undefined;
        if (terminal) throw terminal;
        if (item.done) {
          finish("end");
          return { done: true, value: undefined };
        }
        if (!(item.value instanceof Uint8Array)) throw streamError("HANDLER_ERROR", "chunk must be PB bytes");
        if (item.value.byteLength > policy.maxChunkBytes) throw streamError("RESOURCE_EXHAUSTED", "chunk too large");
        deadline(policy.consumerIdleMs, "consumer idle");
        return { done: false, value: item.value };
      } catch (error) {
        finish(error instanceof Error ? error : streamError("HANDLER_ERROR", "stream failed"));
        throw terminal;
      } finally {
        busy = false;
        rejectPending = undefined;
      }
    },
    async cancel() {
      abort();
      await cleanup;
    },
    async return() {
      await this.cancel();
      return { done: true, value: undefined };
    },
  };
  return stream;
}

/** Active sources must await send. Concurrent/unpausable producers fail instead of accumulating waiters. */
export function boundedByteQueue(policy: StreamPolicy, signal: AbortSignal) {
  const queue: Uint8Array[] = [];
  let bytes = 0;
  let ended = false;
  let error: Error | undefined;
  let sending = false;
  let wake: (() => void) | undefined;
  let room: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
    room?.();
    room = undefined;
  };
  const fail = (reason: Error) => {
    error ??= reason;
    ended = true;
    queue.length = 0;
    bytes = 0;
    notify();
  };
  const abort = () => fail(streamError("CANCELLED", "queue cancelled"));
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const source: ByteSource = {
    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          if (error) throw error;
          const value = queue.shift();
          if (value) {
            bytes -= value.byteLength;
            room?.();
            room = undefined;
            yield value;
          } else if (ended) return;
          else
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
        }
      } finally {
        signal.removeEventListener("abort", abort);
        abort();
      }
    },
  };
  return {
    source,
    async send(value: Uint8Array) {
      if (sending) {
        const reason = streamError("RESOURCE_EXHAUSTED", "producer did not await send");
        fail(reason);
        throw reason;
      }
      if (value.byteLength > Math.min(policy.maxChunkBytes, policy.queueBytes)) {
        const reason = streamError("RESOURCE_EXHAUSTED", "chunk too large");
        fail(reason);
        throw reason;
      }
      sending = true;
      try {
        while (!ended && (queue.length >= policy.queueItems || bytes + value.byteLength > policy.queueBytes))
          await new Promise<void>((resolve) => {
            room = resolve;
          });
        if (error) throw error;
        if (ended) throw streamError("CANCELLED", "queue closed");
        queue.push(value);
        bytes += value.byteLength;
        wake?.();
        wake = undefined;
      } finally {
        sending = false;
      }
    },
    end() {
      ended = true;
      notify();
    },
    fail,
    usage: () => ({ items: queue.length, bytes }),
  };
}

// Version 1 binary frame: end=0; chunk=1 + big-endian u32 sequence + original PB bytes.
export function encodeFrame(seq: number, item: IteratorResult<Uint8Array>): Uint8Array {
  if (item.done) return Uint8Array.of(0);
  if (seq > 0xffffffff) throw streamError("RESOURCE_EXHAUSTED", "stream sequence exhausted");
  const bytes = new Uint8Array(5 + item.value.length);
  bytes[0] = 1;
  new DataView(bytes.buffer).setUint32(1, seq);
  bytes.set(item.value, 5);
  return bytes;
}
export function decodeFrame(bytes: Uint8Array, seq: number): IteratorResult<Uint8Array> {
  if (bytes.length === 1 && bytes[0] === 0) return { done: true, value: undefined };
  if (
    bytes.length < 5 ||
    bytes[0] !== 1 ||
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1) !== seq
  )
    throw streamError("INCOMPATIBLE", "invalid stream sequence or frame");
  return { done: false, value: bytes.subarray(5) };
}
