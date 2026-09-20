import { setTimeout as delay } from "node:timers/promises";

// nodemon may exit before pnpm/Electron descendants. Its private process group
// remains identifiable even after those descendants are reparented.
export async function stopProcessGroup(child, closed, graceMs = 5000) {
  if (!child.pid) return closed;
  function signalGroup(signal) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  }
  signalGroup("SIGTERM");
  const deadline = Date.now() + graceMs;
  let forced = false;
  while (signalGroup(0)) {
    if (!forced && Date.now() >= deadline) {
      signalGroup("SIGKILL");
      forced = true;
    }
    if (Date.now() >= deadline + 5000) throw new Error("开发应用进程组未退出，已停止重启");
    await delay(25);
  }
  await closed;
}
