import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

// nodemon may exit before pnpm/Electron descendants. Its private process group
// remains identifiable even after those descendants are reparented.
export async function stopProcessGroup(child, closed, graceMs = 5000) {
  if (!child.pid) return closed;
  let reportedExitRace = false;

  function signalGroup(signal) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;

      let members;
      let snapshotAvailable = false;

      try {
        const snapshot = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,uid=,stat="], {
          encoding: "utf8",
          timeout: 1000,
        });
        members = snapshot.split("\n").filter((line) => Number(line.trim().split(/\s+/)[2]) === child.pid);
        snapshotAvailable = true;
      } catch (diagnosticError) {
        members = [`ps failed: ${diagnosticError.message}`];
      }

      error.message += ` (pgid=${child.pid}, signal=${signal}, node=${process.version}, platform=${process.platform})`;
      error.message += `\nProcess group snapshot (PID PPID PGID UID STAT):\n${members.join("\n") || "<empty>"}`;

      if (error.code === "EPERM" && signal === 0 && process.platform === "darwin" && snapshotAvailable) {
        if (members.length === 0) return false;

        const allExiting = members.every((line) => {
          const fields = line.trim().split(/\s+/);
          return Number(fields[3]) === process.getuid() && (fields[4].includes("E") || fields[4].startsWith("Z"));
        });

        if (allExiting) {
          // Darwin can deny the probe while the last group members are exiting.
          // Keep waiting for ESRCH; an exiting process is not yet a reaped process.
          if (!reportedExitRace) console.warn(`等待 macOS 回收退出中的开发进程组：${error.message}`);
          reportedExitRace = true;
          return true;
        }
      }

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
