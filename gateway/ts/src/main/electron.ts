import type { IpcMain, IpcMainInvokeEvent, WebContents, WebFrameMain } from "electron";
import { type CallContext, createContext, type Permissions } from "../core/context.js";
import { type ElectronRequest, GATEWAY_CHANNEL, GATEWAY_EVENT } from "../core/electron-protocol.js";
import { CONTROL_VERSION, failure, GatewayFailure, type Subscription, success } from "../core/protocol.js";
import type { GatewayHost } from "../core/registry.js";
import { encodeFrame, type ResponseStream } from "../core/stream.js";

interface Session {
  id: string;
  context: CallContext;
  frame: WebFrameMain;
  contents: WebContents;
  closed: boolean;
  subscriptions: Map<string, { handle?: Subscription; cancelled?: boolean }>;
  streams: Map<string, { controller: AbortController; stream?: ResponseStream<Uint8Array>; seq: number }>;
}

const unavailable = () => new GatewayFailure({ code: "OWNER_UNAVAILABLE", message: "frame session closed" });
export function attachElectron(host: GatewayHost, ipc: Pick<IpcMain, "handle" | "removeHandler">) {
  const allowed = new Map<WebContents, Permissions>();
  const sessions = new Map<WebContents, Session>();
  const targets = new WeakMap<CallContext, Session>();
  let generation = 0;
  let stopped = false;

  function cleanup(contents: WebContents) {
    const session = sessions.get(contents);
    if (!session) return;
    session.closed = true;
    sessions.delete(contents);
    for (const slot of session.subscriptions.values()) slot.handle?.close();
    session.subscriptions.clear();
    for (const slot of session.streams.values()) slot.controller.abort(unavailable());
    session.streams.clear();
    host.cleanupCaller(session.id);
  }

  ipc.handle(
    GATEWAY_CHANNEL,
    async (
      event: IpcMainInvokeEvent,
      request: ElectronRequest & {
        operation: string;
        session?: string;
        version: number;
      },
    ) => {
      try {
        const permissions = allowed.get(event.sender);
        if (stopped || !permissions || event.senderFrame !== event.sender.mainFrame || !event.senderFrame)
          throw unavailable();
        if (!request || request.version !== CONTROL_VERSION)
          return failure("INCOMPATIBLE", "Electron control version mismatch");
        if ((request.operation as string) === "connect") {
          cleanup(event.sender);
          const id = `frame:${event.sender.id}:${++generation}`;
          const session: Session = {
            id,
            context: createContext({ ...permissions, caller: id }),
            frame: event.senderFrame,
            contents: event.sender,
            closed: false,
            subscriptions: new Map(),
            streams: new Map(),
          };
          sessions.set(event.sender, session);
          targets.set(session.context, session);
          return id;
        }
        const session = sessions.get(event.sender);
        if (!session || session.closed || session.id !== request.session || session.frame !== event.senderFrame)
          throw unavailable();
        const id = request.id ?? "";
        if (request.operation !== "invoke" && (!id || id.length > 200))
          return failure("INVALID_ARGUMENT", "invalid handle ID");
        const payload = request.payload ?? new Uint8Array();
        switch (request.operation) {
          case "invoke": {
            if (!request.route) return failure("INVALID_ARGUMENT", "missing route");
            const result = await host.invoke(session.context, request.route, payload);
            return session.closed ? failure("OWNER_UNAVAILABLE", "frame closed") : result;
          }
          case "subscribe": {
            if (!request.event || session.subscriptions.has(id))
              return failure("INVALID_ARGUMENT", "invalid subscription");
            if (session.subscriptions.size >= 128) return failure("RESOURCE_EXHAUSTED", "frame subscriptions full");
            const slot: { handle?: Subscription; cancelled?: boolean } = {};
            session.subscriptions.set(id, slot);
            try {
              const handle = await host.subscribe(
                session.context,
                request.event,
                request.filter,
                (bytes) => {
                  if (!session.closed && session.subscriptions.get(id) === slot && !slot.cancelled)
                    session.frame.send(GATEWAY_EVENT, { session: session.id, id, payload: bytes });
                },
                request.persistent,
              );
              if (session.closed || slot.cancelled || session.subscriptions.get(id) !== slot) {
                handle.close();
                throw unavailable();
              }
              slot.handle = handle;
              return success(new Uint8Array());
            } catch (error) {
              if (session.subscriptions.get(id) === slot) session.subscriptions.delete(id);
              throw error;
            }
          }
          case "unsubscribe": {
            const slot = session.subscriptions.get(id);
            if (slot) {
              slot.cancelled = true;
              if (slot.handle) {
                slot.handle.close();
                session.subscriptions.delete(id);
              }
            }
            return success(new Uint8Array());
          }
          case "stream.open": {
            if (!request.route || session.streams.has(id)) return failure("INVALID_ARGUMENT", "invalid stream");
            if (session.streams.size >= 128) return failure("RESOURCE_EXHAUSTED", "frame streams full");
            const slot = {
              controller: new AbortController(),
              seq: 0,
              stream: undefined as ResponseStream<Uint8Array> | undefined,
            };
            session.streams.set(id, slot);
            try {
              const stream = await host.stream(session.context, request.route, payload, {
                signal: slot.controller.signal,
              });
              if (session.closed || session.streams.get(id) !== slot) {
                await stream.cancel();
                throw unavailable();
              }
              slot.stream = stream;
              void stream.closed.then(() => {
                if (session.streams.get(id) === slot) session.streams.delete(id);
              });
              return success(new TextEncoder().encode(JSON.stringify(stream.policy)));
            } catch (error) {
              if (session.streams.get(id) === slot) session.streams.delete(id);
              throw error;
            }
          }
          case "stream.next": {
            const slot = session.streams.get(id);
            if (!slot?.stream) throw unavailable();
            const item = await slot.stream.next();
            return success(encodeFrame(slot.seq++, item));
          }
          case "stream.cancel": {
            const slot = session.streams.get(id);
            session.streams.delete(id);
            slot?.controller.abort();
            await slot?.stream?.cancel();
            return success(new Uint8Array());
          }
          default:
            return failure("INVALID_ARGUMENT", "unknown operation");
        }
      } catch (error) {
        return error instanceof GatewayFailure
          ? { ok: false, error: error.detail }
          : failure("HANDLER_ERROR", "Electron gateway failed");
      }
    },
  );

  return {
    register(contents: WebContents, permissions: Permissions = { caller: "renderer", trusted: true }) {
      allowed.set(contents, permissions);
      // A navigation attempt can be cancelled while the current document stays alive.
      // did-navigate runs after main-frame commit, before the new preload connects.
      contents.on("did-navigate", () => cleanup(contents));
      contents.on("render-process-gone", () => cleanup(contents));
      contents.once("destroyed", () => {
        cleanup(contents);
        allowed.delete(contents);
      });
    },
    target(context: CallContext): WebContents {
      const session = targets.get(context);
      if (!session || session.closed || session.contents.isDestroyed()) throw unavailable();
      return session.contents;
    },
    close() {
      stopped = true;
      for (const contents of sessions.keys()) cleanup(contents);
      allowed.clear();
      ipc.removeHandler(GATEWAY_CHANNEL);
    },
  };
}
