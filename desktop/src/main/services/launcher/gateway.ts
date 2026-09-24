import { create, toBinary } from "@bufbuild/protobuf";
import type { BrowserWindow, WebContents } from "electron";
import {
  EmptySchema,
  ExecuteResponseSchema,
  Launcher,
  LauncherOpenedSchema,
  LauncherSearchResponseSchema,
  LocalPathRequestSchema,
  OpenUrlRequestSchema,
  RecordUsageRequestSchema,
  Search,
  SearchCommand,
  type SearchHit,
  SearchRequestSchema,
  System,
  LauncherMode as WireMode,
} from "xiaowei-contracts";
import { bindClient, bindHandlers, type EventSink } from "xiaowei-gateway";
import type { CallContext, GatewayHost } from "xiaowei-gateway/host";
import { type LauncherMode, launcherHeight } from "../../../shared/launcher-model";

export interface LauncherActions {
  development: boolean;
  platform: string;
  openExternal(url: string): Promise<void>;
  writeText(text: string): void;
  restart(): Promise<void>;
  resetPosition(window: BrowserWindow): void;
  modeChanged(mode: LauncherMode): void;
  iconUrl(path: string): string;
  includeChromeBookmarks(): Promise<boolean>;
}

export function registerSearch(
  host: GatewayHost,
  windowFor: (context: CallContext) => BrowserWindow,
  actions: LauncherActions,
) {
  const states = new WeakMap<CallContext, { token: number; results: Map<string, SearchHit> }>();
  const opened = new Map<object, { contents: WebContents; sink: EventSink }>();

  function state(context: CallContext) {
    windowFor(context);
    let state = states.get(context);
    if (!state) {
      state = { token: 0, results: new Map() };
      states.set(context, state);
    }
    return state;
  }

  const owner = host.registerOwner(
    "launcher",
    bindHandlers(Launcher, {
      async query(request, client, context) {
        const current = state(context);
        if (Buffer.byteLength(request.query) > 4096) throw new Error("Invalid search query");
        const token = ++current.token;
        current.results.clear();
        const includeChromeBookmarks = await actions.includeChromeBookmarks();
        const { hits } = await bindClient(Search, client).query(
          create(SearchRequestSchema, {
            query: request.query,
            includeChromeBookmarks,
          }),
        );
        windowFor(context);
        if (token !== current.token) return create(LauncherSearchResponseSchema, { token });
        current.results = new Map(hits.map((hit) => [hit.id, hit]));
        // Execution metadata stays in main; renderer sees only display fields.
        return create(LauncherSearchResponseSchema, {
          token,
          hits: hits.map(({ id, title, provider, label, score, ranges, action }) => ({
            id,
            title,
            provider,
            label,
            score,
            ranges,
            iconUrl: action?.action.case === "launchApp" ? actions.iconUrl(action.action.value) : undefined,
          })),
        });
      },
      async execute(request, client, context) {
        const current = state(context);
        const hit = request.token === current.token ? current.results.get(request.id) : undefined;
        if (!hit) throw new Error("Search result expired");
        const native = bindClient(Search, client);
        const record = () => native.recordUsage(create(RecordUsageRequestSchema, { recencyKey: hit.recencyKey }));
        switch (hit.action?.action.case) {
          case "command":
            if (hit.action.action.value === SearchCommand.OPEN_CLIPBOARD) {
              await record();
              return create(ExecuteResponseSchema, { mode: WireMode.CLIPBOARD });
            }
            if (hit.action.action.value === SearchCommand.TOGGLE_THEME && actions.platform === "darwin")
              await bindClient(System, client).toggleTheme(create(EmptySchema));
            else if (hit.action.action.value === SearchCommand.RESTART_DEVELOPMENT && actions.development)
              await actions.restart();
            else throw new Error("Unsupported command");
            break;
          case "copyText":
            actions.writeText(hit.action.action.value);
            break;
          case "launchApp": {
            await bindClient(System, client).openPath(
              create(LocalPathRequestSchema, { path: hit.action.action.value }),
            );
            break;
          }
          case "openUrl": {
            const url = new URL(hit.action.action.value);
            const web = url.protocol === "https:" || url.protocol === "http:";
            const settings = hit.provider === "app" && url.protocol === "x-apple.systempreferences:";
            if (!web && !settings) throw new Error("Unsupported URL scheme");
            if (web) {
              await bindClient(System, client).openUrl(create(OpenUrlRequestSchema, { url: url.href }));
            } else {
              await actions.openExternal(url.href);
            }
            break;
          }
          default:
            throw new Error("Unsupported search action");
        }
        if (hit.provider !== "calculator") await record();
        windowFor(context).hide();
        return create(ExecuteResponseSchema);
      },
      hide(_request, _client, context) {
        windowFor(context).hide();
        return create(EmptySchema);
      },
      updateLayout(request, _client, context) {
        const window = windowFor(context);
        if (
          request.resultCount > 30 ||
          (request.mode !== undefined && request.mode !== WireMode.CLIPBOARD && request.mode !== WireMode.SEARCH)
        )
          throw new Error("Invalid resize");
        actions.modeChanged(request.mode === WireMode.CLIPBOARD ? "clipboard" : "search");
        window.setSize(800, request.mode === WireMode.CLIPBOARD ? 580 : launcherHeight(request.resultCount));
        return create(EmptySchema);
      },
      resetPosition(_request, _client, context) {
        const window = windowFor(context);
        actions.resetPosition(window);
        window.show();
        window.focus();
        return create(EmptySchema);
      },
    }),
    [
      {
        name: LauncherOpenedSchema.typeName,
        policy: "coalesce",
        async attach(context, _filter, sink) {
          const key = {};
          opened.set(key, { contents: windowFor(context).webContents, sink });
          return {
            close() {
              opened.delete(key);
            },
          };
        },
      },
    ],
  );

  return {
    close: () => owner.close(),
    opened(window: BrowserWindow, mode: LauncherMode) {
      const bytes = toBinary(
        LauncherOpenedSchema,
        create(LauncherOpenedSchema, { mode: mode === "clipboard" ? WireMode.CLIPBOARD : WireMode.SEARCH }),
      );
      for (const entry of opened.values())
        if (entry.contents === window.webContents)
          void Promise.resolve(entry.sink(bytes)).catch((error) => console.error("Launcher event failed", error));
    },
  };
}
