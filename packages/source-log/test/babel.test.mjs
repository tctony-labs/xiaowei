import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { transformSync } from "@babel/core";
import plugin from "../babel.cjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const filename = `${root}mobile/src/App.tsx`;
function transform(code, options = {}, file = filename) {
  return transformSync(code, {
    filename: file,
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: ["typescript", "jsx"] },
    plugins: [[plugin, { workspaceRoot: root, ...options }]],
    sourceMaps: true,
  });
}

test("Babel adapter injects original RN TSX locations while preserving directives and nested calls", () => {
  const code = '"use strict";\nconst screen: unknown = <View />;\nconsole.info("outer", console.warn("inner"));';
  const result = transform(code);
  assert.ok(result.code.startsWith('"use strict";'));
  assert.equal(result.code.match(/mobile\/src\/App.tsx:3/g).length, 2);
  assert.ok(result.code.includes("sourceLog as"));
  assert.deepEqual(result.map.sourcesContent, [code]);
  assert.ok(transform(`\n${code}`).code.includes("mobile/src/App.tsx:4"));
});

test("Babel and Vite share workspace exclusions, console scope rules and opt-out", () => {
  for (const [code, options, file] of [
    ['console.info("disabled")', { enabled: false }, filename],
    ['function f(console: Console) { console.info("local"); }', {}, filename],
    ['console.info("dependency")', {}, `${root}node_modules/example/index.ts`],
    ['console.info("external")', {}, `${root}../external/index.ts`],
    ['console.info("generated")', {}, `${root}mobile/dist/index.js`],
    ['console.info("runtime")', {}, `${root}packages/source-log/runtime.ts`],
  ]) {
    assert.ok(!transform(code, options, file).code.includes("sourceLog"));
  }
  assert.ok(
    transform('console.info("shared")', {}, `${root}packages/utils/src/index.ts`).code.includes(
      "packages/utils/src/index.ts:1",
    ),
  );
});

test("Babel output executes once and preserves spread arguments and objects", async (context) => {
  const calls = [];
  context.mock.method(console, "info", (...args) => calls.push(args));
  const result = transform('const args = ["hello", { count: 2 }]; console.info("%s %o", ...args);');
  await import(
    `data:text/javascript,${encodeURIComponent(
      result.code.replace(
        /from "([^"]+runtime.ts)"/,
        (_, path) => `from ${JSON.stringify(new URL(`file://${path}`).href)}`,
      ),
    )}`
  );
  assert.deepEqual(calls, [["[mobile/src/App.tsx:1] %s %o", "hello", { count: 2 }]]);
});
