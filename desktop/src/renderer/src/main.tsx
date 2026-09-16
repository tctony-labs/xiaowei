import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import logo from "../../../resources/logo.png";
import "./style.css";

function App() {
  return (
    <main className="flex min-h-screen items-center justify-center px-8 py-12">
      <section className="w-full max-w-lg">
        <img src={logo} alt="XiaoWei" className="mb-8 size-20 rounded-2xl" />
        <p className="mb-3 text-sm font-medium tracking-widest text-muted">搜索 · AGENT · 效率</p>
        <h1 className="mb-5 text-5xl font-semibold tracking-tight">XiaoWei</h1>
        <p className="text-lg leading-8 text-muted">通过搜索和 AI Agent，快速获取信息、处理任务。</p>
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
