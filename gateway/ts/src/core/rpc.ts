import { GatewayFailure } from "./protocol.js";

/** A single local terminal result, with independent cooperative cancellation. */
export interface Rpc<T> extends Promise<T> {
  cancel(): void;
}

export function cancelled(): GatewayFailure {
  return new GatewayFailure({ code: "CANCELLED", message: "RPC cancelled" });
}

export function createRpc<T>(work: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Rpc<T> {
  const controller = new AbortController();
  let done = false;
  let rejectResult!: (error: unknown) => void;
  const abort = () => {
    if (done) return;
    done = true;
    parent?.removeEventListener("abort", abort);
    rejectResult(cancelled());
    controller.abort(cancelled());
  };
  const promise = new Promise<T>((resolve, reject) => {
    rejectResult = reject;
    parent?.addEventListener("abort", abort, { once: true });
    if (parent?.aborted) {
      abort();
      return;
    }
    const finish = (result: { value: T } | { error: unknown }) => {
      if (done) return;
      done = true;
      parent?.removeEventListener("abort", abort);
      if ("error" in result) reject(result.error);
      else resolve(result.value);
    };
    try {
      void work(controller.signal).then(
        (value) => finish({ value }),
        (error) => finish({ error }),
      );
    } catch (error) {
      finish({ error });
    }
  });
  return Object.assign(promise, {
    cancel() {
      abort();
    },
  });
}
