const { isAbsolute, relative } = require("node:path");

const methods = new Set(["log", "info", "warn", "error", "debug", "trace"]);
const runtime = require.resolve("./runtime.ts");

function getSourcePath(file, workspaceRoot) {
  const source = relative(workspaceRoot, file).replaceAll("\\", "/");
  if (
    !isAbsolute(file) ||
    !/\.[cm]?[jt]sx?$/.test(file) ||
    isAbsolute(source) ||
    source.startsWith("../") ||
    file === runtime ||
    /(?:^|\/)(?:node_modules|dist|out|target|coverage|storybook-static|\.git|\.vite)(?:\/|$)/.test(source)
  )
    return null;
  return source;
}

function getLogCall(path) {
  const { node } = path;
  const callee = node.callee;
  if (
    callee.type !== "MemberExpression" ||
    callee.computed ||
    callee.object.type !== "Identifier" ||
    callee.object.name !== "console" ||
    callee.property.type !== "Identifier" ||
    !methods.has(callee.property.name) ||
    path.scope.hasBinding("console", { noGlobals: true }) ||
    callee.start == null ||
    callee.end == null ||
    node.end == null ||
    !node.loc
  )
    return null;
  return {
    method: callee.property.name,
    line: node.loc.start.line,
    start: callee.start,
    end: callee.end,
    position: node.arguments[0]?.start ?? node.end - 1,
  };
}

module.exports = { getSourcePath, getLogCall, runtime };
