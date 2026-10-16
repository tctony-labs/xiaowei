import { constants, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = fileURLToPath(new URL("../../", import.meta.url));
const environment = ["server/config/.env.example", "server/config/.env"];

function ensureFiles(templates, { root = workspace, print = console.log } = {}) {
  for (const [template, path] of templates) {
    if (existsSync(join(root, path))) continue;
    try {
      copyFileSync(join(root, template), join(root, path), constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code === "EEXIST") continue;
      throw new Error(`无法从 ${template} 创建 ${path}（${error.code}）。`);
    }
    print(`${path} 缺失，已从 ${template} 复制。`);
  }
}

export function ensureEnvironment(options) {
  ensureFiles([environment], options);
}

export function ensureServerConfiguration(options) {
  ensureFiles(
    [["server/config/server.example.yaml", "server/config/server.yaml"], environment],
    options,
  );
}
