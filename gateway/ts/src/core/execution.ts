import type { Client } from "./client.js";
import { type CallContext, caller } from "./context.js";
import { failure, type GatewayError, GatewayFailure, type Result, success } from "./protocol.js";
import type { Registration } from "./registry.js";
import { cancelled } from "./rpc.js";
import { openStream, type StreamOptions, streamPolicy } from "./stream.js";

export function executionError(error: unknown): Result<never> {
  return error instanceof GatewayFailure
    ? { ok: false, error: { ...error.detail } }
    : failure("HANDLER_ERROR", "handler or transport failed");
}

/** Local execution only: an instance belongs to the environment running the handlers. */
export class ExecutionScope {
  private running = new WeakMap<Registration, number>();
  private pending = new Set<{
    owner: object;
    caller: string;
    controller: AbortController;
    finish: (result: Result<Uint8Array>) => void;
  }>();
  private streams = new Set<{ owner: object; caller: string; controller: AbortController }>();
  private work = new Set<Promise<unknown>>();

  invoke(
    registration: Registration,
    owner: object,
    context: CallContext,
    client: (signal: AbortSignal) => Client,
    payload: Uint8Array,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted) return Promise.resolve(failure("CANCELLED", "RPC cancelled"));
    const running = this.running.get(registration) ?? 0;
    if (running >= (registration.maxConcurrency ?? 32))
      return Promise.resolve(failure("CONCURRENCY_FULL", "route concurrency full"));
    this.running.set(registration, running + 1);
    return new Promise<Result<Uint8Array>>((resolve) => {
      let done = false;
      const controller = new AbortController();
      const state = { owner, caller: caller(context), controller, finish };
      const abort = () => {
        finish(failure("CANCELLED", "RPC cancelled"));
        controller.abort(cancelled());
      };
      const timer = setTimeout(() => {
        finish(failure("TIMEOUT", "handler timed out"));
        controller.abort();
      }, registration.timeoutMs ?? 30_000);
      function finish(result: Result<Uint8Array>) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve(result);
      }
      this.pending.add(state);
      signal?.addEventListener("abort", abort, { once: true });
      const run = async () => {
        if (!registration.handler) return failure("WRONG_METHOD_KIND", "handler is not unary");
        const response = await registration.handler(payload, client(controller.signal));
        return response instanceof Uint8Array
          ? success(response)
          : failure("HANDLER_ERROR", "handler did not return PB bytes");
      };
      const work = run();
      this.work.add(work);
      const settled = (result: Result<Uint8Array>) => {
        this.running.set(registration, (this.running.get(registration) ?? 1) - 1);
        this.pending.delete(state);
        this.work.delete(work);
        finish(result);
      };
      void work.then(settled, (error) => settled(executionError(error)));
    });
  }

  stream(
    registration: Registration,
    owner: object,
    context: CallContext,
    client: (signal: AbortSignal) => Client,
    payload: Uint8Array,
    options: StreamOptions = {},
  ) {
    const handler = registration.streamHandler;
    if (!handler) throw new GatewayFailure({ code: "WRONG_METHOD_KIND", message: "no stream handler" });
    const policy = streamPolicy(registration.streamPolicy);
    const id = caller(context);
    const active = [...this.streams];
    if (
      active.filter((s) => s.owner === owner).length >= policy.maxOwnerStreams ||
      active.filter((s) => s.caller === id).length >= policy.maxCallerStreams
    )
      throw new GatewayFailure({ code: "RESOURCE_EXHAUSTED", message: "stream admission full" });
    const controller = new AbortController();
    const state = { owner, caller: id, controller };
    this.streams.add(state);
    let complete!: () => void;
    const work = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.work.add(work);
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    return openStream(
      (signal) => handler(payload, client(signal)),
      policy,
      { signal: controller.signal },
      () => {
        this.streams.delete(state);
        this.work.delete(work);
        complete();
        options.signal?.removeEventListener("abort", abort);
      },
    );
  }

  close(owner: object, reason: GatewayError = { code: "OWNER_UNAVAILABLE", message: "owner closed" }) {
    for (const state of this.pending) {
      if (state.owner !== owner) continue;
      state.finish({ ok: false, error: reason });
      state.controller.abort(new GatewayFailure(reason));
    }
    for (const state of this.streams) if (state.owner === owner) state.controller.abort(new GatewayFailure(reason));
  }

  cleanupCaller(id: string) {
    for (const state of this.pending) {
      if (state.caller !== id) continue;
      state.finish(failure("CANCELLED", "caller closed"));
      state.controller.abort(cancelled());
    }
    for (const stream of this.streams) if (stream.caller === id) stream.controller.abort();
  }

  async drained() {
    await Promise.allSettled([...this.work]);
  }
}
