import { create, fromBinary } from "@bufbuild/protobuf";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { EmptySchema, SettingsChangedSchema } from "xiaowei-contracts";
import { Launcher } from "./components/Launcher";
import { applyTheme, SettingsPage } from "./components/settings/SettingsPage";
import { services } from "./services";
import "./style.css";

function LauncherWithTheme() {
  const [refreshToken, setRefreshToken] = useState(0);
  useEffect(() => {
    let active = true;
    let subscription: { close(): void } | undefined;
    let revision = 0;
    void (async () => {
      const handle = await services.getGateway().subscribe(SettingsChangedSchema.typeName, undefined, (bytes) => {
        const snapshot = fromBinary(SettingsChangedSchema, bytes).snapshot;
        if (active && snapshot) {
          revision += 1;
          applyTheme(snapshot.theme);
          setRefreshToken((current) => current + 1);
        }
      });
      if (!active) {
        handle.close();
        return;
      }
      subscription = handle;
      const before = revision;
      const snapshot = await services.getSettings().get(create(EmptySchema));
      if (active && revision === before) applyTheme(snapshot.theme);
    })().catch((error: unknown) => console.error("Theme loading failed", error));
    return () => {
      active = false;
      subscription?.close();
    };
  }, []);
  return <Launcher refreshToken={refreshToken} />;
}

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  console.error("Unhandled rejection", reason instanceof Error ? reason.stack : String(reason));
});
console.info("Renderer starting");

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
const parameters = new URLSearchParams(window.location.search);
const settings = parameters.get("window") === "settings";
createRoot(root).render(
  <StrictMode>
    {settings ? (
      <SettingsPage version={parameters.get("version") ?? ""} development={parameters.get("development") === "true"} />
    ) : (
      <LauncherWithTheme />
    )}
  </StrictMode>,
);
