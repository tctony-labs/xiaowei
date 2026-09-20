import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";

export function forwardOutput(input, output, isStopping) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const text = stripVTControlCharacters(line).trim();
    const stopNotice =
      /^\[?ELIFECYCLE\]?\s+Command failed\.$/.test(text) ||
      /^\/.+\/electron\/dist\/Electron\.app\/Contents\/MacOS\/Electron exited with signal SIGTERM$/.test(text);
    if (isStopping() && stopNotice) return;
    output.write(`${line}\n`);
  });
  return lines;
}
