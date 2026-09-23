import { App, ClipboardBiz, KeyValue, Launcher, Settings, System } from "xiaowei-contracts";
import { bindClient, type Client, type ServiceClient } from "xiaowei-gateway";
import { createRendererClient } from "xiaowei-gateway/renderer";
import type {} from "../../shared/gateway-api";

// Each renderer (or isolated preview) owns one lazy client and one binding per service.
export function createServices(connect: () => Client) {
  let gateway: Client | undefined;
  let clipboard: ServiceClient<typeof ClipboardBiz> | undefined;
  let resources: ServiceClient<typeof System> | undefined;
  let launcher: ServiceClient<typeof Launcher> | undefined;
  let keyValue: ServiceClient<typeof KeyValue> | undefined;
  let apps: ServiceClient<typeof App> | undefined;
  let settings: ServiceClient<typeof Settings> | undefined;

  function getGateway(): Client {
    gateway ??= connect();
    return gateway;
  }

  return {
    getGateway,
    getKeyValue() {
      keyValue ??= bindClient(KeyValue, getGateway());
      return keyValue;
    },
    getClipboard() {
      clipboard ??= bindClient(ClipboardBiz, getGateway());
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
    getSettings() {
      settings ??= bindClient(Settings, getGateway());
      return settings;
    },
    getApp() {
      apps ??= bindClient(App, getGateway());
      return apps;
    },
  };
}

export type Services = ReturnType<typeof createServices>;

export const services = createServices(() => createRendererClient(window.gateway));
export const { getGateway, getClipboard, getSystem, getLauncher, getApp, getKeyValue, getSettings } = services;
