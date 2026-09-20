import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
import MagicString from "magic-string";
import type { Plugin } from "vite";
import { getLogCall, getSourcePath, runtime } from "./rules.cjs";

const traverse =
  typeof traverseModule === "function"
    ? traverseModule
    : (traverseModule as { default: typeof traverseModule }).default;
const workspace = fileURLToPath(new URL("../../", import.meta.url));

export function sourceLocationPlugin(enabled = process.env.XIAOWEI_LOG_SOURCE !== "0"): Plugin {
  return {
    name: "xiaowei-log-source",
    enforce: "pre",
    transform(code, id) {
      const file = id.split("?")[0];
      const source = getSourcePath(file, workspace);
      if (!enabled || !source || !code.includes("console")) return null;
      const ast = parse(code, {
        sourceType: "module",
        plugins: ["typescript", ...(file.endsWith("x") ? (["jsx"] as const) : [])],
      });
      const output = new MagicString(code);
      let helper = "";
      traverse(ast, {
        Program(path) {
          helper = path.scope.generateUidIdentifier("sourceLog").name;
        },
        CallExpression(path) {
          const call = getLogCall(path);
          if (!call) return;
          const location = `${source}:${call.line}`;
          output.overwrite(call.start, call.end, helper);
          const separator = path.node.arguments.length ? ", " : "";
          output.appendLeft(call.position, `${JSON.stringify(call.method)}, ${JSON.stringify(location)}${separator}`);
        },
      });
      if (!output.hasChanged()) return null;
      const directiveEnd = ast.program.directives.at(-1)?.end ?? 0;
      output.appendLeft(directiveEnd, `\nimport { sourceLog as ${helper} } from ${JSON.stringify(runtime)};\n`);
      return {
        code: output.toString(),
        map: output.generateMap({ hires: true, source: file, includeContent: true }).toString(),
      };
    },
  };
}
