const { resolve } = require("node:path");
const { getSourcePath, getLogCall, runtime } = require("./rules.cjs");

// Babel/Metro supplies its own parser, presets and AST. No Vite or Node APIs enter the runtime bundle.
module.exports = function sourceLocationBabelPlugin({ types: t }) {
  return {
    name: "xiaowei-log-source",
    visitor: {
      Program: {
        enter(path, state) {
          const enabled = state.opts.enabled ?? process.env.XIAOWEI_LOG_SOURCE !== "0";
          const root = state.opts.workspaceRoot ?? resolve(__dirname, "../..");
          state.sourcePath = enabled ? getSourcePath(state.filename, root) : null;
          state.sourceHelper = path.scope.generateUidIdentifier("sourceLog");
          state.hasSourceCalls = false;
        },
        exit(path, state) {
          if (!state.hasSourceCalls) return;
          path.unshiftContainer(
            "body",
            t.importDeclaration(
              [t.importSpecifier(t.cloneNode(state.sourceHelper), t.identifier("sourceLog"))],
              t.stringLiteral(runtime),
            ),
          );
        },
      },
      CallExpression(path, state) {
        if (!state.sourcePath) return;
        const call = getLogCall(path);
        if (!call) return;
        path.node.callee = t.cloneNode(state.sourceHelper);
        path.node.arguments.unshift(t.stringLiteral(call.method), t.stringLiteral(`${state.sourcePath}:${call.line}`));
        state.hasSourceCalls = true;
      },
    },
  };
};
