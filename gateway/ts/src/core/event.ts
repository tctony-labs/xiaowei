import { authorize, type CallContext, caller } from "./context.js";
import {
  type Backpressure,
  type EventDescriptor,
  type EventSink,
  GatewayFailure,
  type Subscription,
  validateName,
} from "./protocol.js";

export interface LocalEventExport extends EventDescriptor {
  validate(filter: Uint8Array | undefined): void;
  matches(payload: Uint8Array, filter: Uint8Array | undefined): boolean;
}
export interface RemoteEventExport extends EventDescriptor {
  attach(context: CallContext, filter: Uint8Array | undefined, sink: EventSink): Promise<Subscription>;
}
export type EventExport = LocalEventExport | RemoteEventExport;
export class DeliveryQueue implements Subscription {
  private pending: Uint8Array[] = [];
  private draining = false;
  private active = true;
  constructor(
    public policy: Backpressure,
    private sink: EventSink,
  ) {}
  enqueue(payload: Uint8Array): void {
    if (!this.active || (this.policy === "drop" && this.pending.length)) return;
    if (this.policy === "coalesce") this.pending.length = 0;
    this.pending.push(payload.slice());
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => {
      void this.drain();
    });
  }
  private async drain(): Promise<void> {
    while (this.active && this.pending.length) {
      const payload = this.pending.shift();
      if (!payload) break;
      try {
        await this.sink(payload);
      } catch {
        /* best-effort, no retries */
      }
    }
    this.draining = false;
  }
  clear(): void {
    this.pending.length = 0;
  }
  close(): void {
    this.active = false;
    this.clear();
  }
}
interface Entry {
  owner: object;
  name: string;
  export: EventExport;
}
interface Consumer {
  context: CallContext;
  active: boolean;
  generation: number;
  binding?: Subscription;
  caller: string;
  event: string;
  filter: Uint8Array | undefined;
  persistent: boolean;
  queue: DeliveryQueue;
}
export class Events {
  private entries = new Map<string, Entry>();
  private consumers = new Set<Consumer>();

  validateOwner(name: string, exports: readonly EventExport[]): void {
    const names = new Set<string>();
    for (const entry of exports) {
      validateName(entry.name);
      if (!["ordered", "coalesce", "drop"].includes(entry.policy)) {
        throw new GatewayFailure({ code: "INVALID_ARGUMENT", message: "invalid event policy" });
      }
      const existing = this.entries.get(entry.name);
      if (names.has(entry.name) || (existing && existing.name !== name)) {
        throw new GatewayFailure({ code: "CONFLICT", message: "event already registered" });
      }
      names.add(entry.name);
    }
  }
  install(owner: object, name: string, exports: readonly EventExport[]): void {
    for (const entry of exports) {
      this.entries.set(entry.name, { owner, name, export: { ...entry } });
      for (const consumer of this.consumers) {
        if (consumer.event === entry.name) {
          consumer.queue.policy = entry.policy;
          void this.activate(consumer).catch(() => {
            /* Invalid pending filters remain inactive. */
          });
        }
      }
    }
  }
  remove(owner: object): void {
    for (const [name, entry] of this.entries) {
      if (entry.owner !== owner) continue;
      this.entries.delete(name);
      for (const consumer of this.consumers) {
        if (consumer.event !== name) continue;
        consumer.generation++;
        if (consumer.binding) this.closeBinding(consumer.binding);
        consumer.binding = undefined;
        consumer.queue.clear();
        if (!consumer.persistent) this.close(consumer);
      }
    }
  }
  async subscribe(
    context: CallContext,
    event: string,
    filter: Uint8Array | undefined,
    sink: EventSink,
    persistent: boolean,
  ): Promise<Subscription> {
    authorize(context, event, true);
    validateName(event);
    const entry = this.entries.get(event);
    if (!entry && !persistent) throw new GatewayFailure({ code: "UNKNOWN_ROUTE", message: "event not exported" });
    if (entry && "validate" in entry.export) entry.export.validate(filter);
    const consumer: Consumer = {
      context,
      active: true,
      generation: 0,
      caller: caller(context),
      event,
      filter: filter?.slice(),
      persistent,
      queue: new DeliveryQueue(entry?.export.policy ?? "drop", sink),
    };
    this.consumers.add(consumer);
    try {
      await this.activate(consumer);
    } catch (error) {
      if (
        !(
          persistent &&
          error instanceof GatewayFailure &&
          ["UNKNOWN_ROUTE", "OWNER_UNAVAILABLE"].includes(error.detail.code)
        )
      ) {
        this.close(consumer);
        throw error;
      }
    }
    return { close: () => this.close(consumer) };
  }
  private closeBinding(binding: Subscription): void {
    try {
      binding.close();
    } catch {
      /* A disconnected endpoint cannot prevent local cleanup. */
    }
  }
  private close(consumer: Consumer): void {
    consumer.active = false;
    consumer.generation++;
    if (consumer.binding) this.closeBinding(consumer.binding);
    consumer.binding = undefined;
    consumer.queue.close();
    this.consumers.delete(consumer);
  }
  private async activate(consumer: Consumer): Promise<void> {
    const entry = this.entries.get(consumer.event);
    if (!entry || !consumer.active) return;
    const generation = ++consumer.generation;
    if ("validate" in entry.export) {
      entry.export.validate(consumer.filter);
      return;
    }
    let binding: Subscription;
    try {
      binding = await entry.export.attach(consumer.context, consumer.filter, (payload) => {
        if (consumer.active && consumer.generation === generation && this.entries.get(consumer.event) === entry) {
          consumer.queue.enqueue(payload);
        }
      });
    } catch (error) {
      if (!consumer.active || consumer.generation !== generation || this.entries.get(consumer.event) !== entry) return;
      throw error;
    }
    if (!consumer.active || consumer.generation !== generation || this.entries.get(consumer.event) !== entry) {
      this.closeBinding(binding);
      return;
    }
    consumer.binding = binding;
  }
  publish(owner: object, event: string, payload: Uint8Array): void {
    const entry = this.entries.get(event);
    if (!entry) throw new GatewayFailure({ code: "UNKNOWN_ROUTE", message: "event not exported" });
    if (entry.owner !== owner) throw new GatewayFailure({ code: "OWNER_UNAVAILABLE", message: "stale event source" });
    if (!("matches" in entry.export)) {
      throw new GatewayFailure({ code: "INVALID_ARGUMENT", message: "remote events use subscription delivery" });
    }
    for (const consumer of this.consumers) {
      if (consumer.event !== event) continue;
      try {
        entry.export.validate(consumer.filter);
        if (entry.export.matches(payload, consumer.filter)) consumer.queue.enqueue(payload);
      } catch {
        /* Invalid pending filters never receive events after owner registration. */
      }
    }
  }
  cleanupCaller(id: string): void {
    for (const consumer of this.consumers) {
      if (consumer.caller === id) this.close(consumer);
    }
  }
}
