import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { LauncherSearchBar } from "./components/LauncherSearchBar";
import "./style.css";

function Launcher() {
  const [query, setQuery] = useState("");
  return (
    <div className="h-screen">
      <LauncherSearchBar query={query} onQueryChange={setQuery} onDismiss={() => window.launcher.hide()} />
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(
  <StrictMode>
    <Launcher />
  </StrictMode>,
);
