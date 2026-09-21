import { App, Clipboard, Database, Launcher, Meta, System } from "xiaowei-contracts";
import { bindClient, type Client, type ServiceClient } from "xiaowei-gateway";
import { createRendererClient } from "xiaowei-gateway/renderer";
import type {} from "../../shared/gateway-api";

// Each renderer (or isolated preview) owns one lazy client and one binding per service.
export function createServices(connect: () => Client) {
  let gateway: Client | undefined;
  let clipboard: ServiceClient<typeof Clipboard> | undefined;
  let resources: ServiceClient<typeof System> | undefined;
  let launcher: ServiceClient<typeof Launcher> | undefined;
  let database: ServiceClient<typeof Database> | undefined;
  let meta: ServiceClient<typeof Meta> | undefined;
  let apps: ServiceClient<typeof App> | undefined;

  function getGateway(): Client {
    gateway ??= connect();
    return gateway;
  }

  return {
    getGateway,
    getDatabase() {
      database ??= bindClient(Database, getGateway());
      return database;
    },
    getMeta() {
      meta ??= bindClient(Meta, getGateway());
      return meta;
    },
    getClipboard() {
      clipboard ??= bindClient(Clipboard, getGateway());
      return clipboard;
    },
    getSystem() {
      resources ??= bindClient(System, getGateway());
      return resources;
    },
    getLauncher() {
      launcher ??= bindClient(Launcher, getGateway());
      return launcher;
    },
    getApp() {
      apps ??= bindClient(App, getGateway());
      return apps;
    },
  };
}

export type Services = ReturnType<typeof createServices>;

export const services = createServices(() => createRendererClient(window.gateway));
export const { getGateway, getClipboard, getSystem, getLauncher, getApp, getDatabase, getMeta } = services;
