import { create, fromBinary } from "@bufbuild/protobuf";
import { useEffect, useState } from "react";
import { EmptySchema, SettingsChangedSchema } from "xiaowei-contracts";
import { Launcher } from "./components/Launcher";
import { SettingsPage } from "./components/settings/SettingsPage";
import { services } from "./services";
import { applyTheme } from "./theme";

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

export function App() {
  const parameters = new URLSearchParams(window.location.search);
  if (parameters.get("window") === "settings") {
    return (
      <SettingsPage version={parameters.get("version") ?? ""} development={parameters.get("development") === "true"} />
    );
  }
  return <LauncherWithTheme />;
}
