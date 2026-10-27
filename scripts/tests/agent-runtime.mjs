import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import artifacts from "./bundled-worker.cjs";

artifacts.prepareBundledWorker();
execFileSync(
  process.execPath,
  ["--conditions=source", "--import", "tsx", "--test", "test/*.test.cjs"],
  {
    cwd: fileURLToPath(new URL("../../crates/xiaowei-agent/napi/", import.meta.url)),
    stdio: "inherit",
  },
);
