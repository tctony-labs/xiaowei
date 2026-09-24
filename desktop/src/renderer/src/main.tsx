import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./style.css";

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  console.error("Unhandled rejection", reason instanceof Error ? reason.stack : String(reason));
});
console.info("Renderer starting");

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
