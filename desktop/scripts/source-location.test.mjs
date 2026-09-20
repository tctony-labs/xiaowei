import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { hasSourceLocation, sourceLog } from "@xiaowei/source-log/runtime";
import { sourceLocationPlugin } from "@xiaowei/source-log/vite";

const id = fileURLToPath(new URL("../src/renderer/src/example.tsx", import.meta.url));
function transform(code, enabled = true, file = id) {
  return sourceLocationPlugin(enabled).transform(code, file);
}

test("injects original TSX lines, preserves directives and handles nested calls and comments", () => {
  const code =
    '"use client";\nconst element = <div />;\nconsole.info /* ( */ ("hello", console.warn("inner"));\nconsole.log();';
  const result = transform(code);
  assert.ok(result.code.startsWith('"use client";'));
  assert.match(result.code, /example.tsx:3/);
  assert.match(result.code, /example.tsx:4/);
  assert.equal(result.code.match(/example.tsx:3/g).length, 2);
  parse(result.code, { sourceType: "module", plugins: ["typescript", "jsx"] });
  assert.deepEqual(JSON.parse(result.map).sourcesContent, [code]);
  const updated = transform(`\n${code}`);
  assert.match(updated.code, /example.tsx:5/);
});

test("does not rewrite shadowed console, aliases, dependencies or disabled modules", () => {
  assert.equal(transform('function f(console: Console) { console.info("local"); }'), null);
  assert.equal(transform('import console from "custom"; console.info("local");'), null);
  assert.equal(transform('const { info } = console; info("alias");'), null);
  assert.equal(transform('console.info("off")', false), null);
  assert.equal(transform('console.info("dependency")', true, "/node_modules/dependency/index.ts"), null);
  assert.equal(transform('const x = "console.info()";'), null);
});

test("helper preserves format strings, object identity, Error and spread arguments", (context) => {
  const calls = [];
  context.mock.method(console, "info", (...args) => calls.push(args));
  const error = new Error("failure");
  const object = { count: 2 };
  sourceLog("info", "desktop/src/main/example.ts:5", "%s %o", "hello", object, error);
  sourceLog("info", "desktop/src/main/example.ts:6", object, error);
  assert.deepEqual(calls[0], ["[desktop/src/main/example.ts:5] %s %o", "hello", object, error]);
  assert.deepEqual(calls[1], ["[desktop/src/main/example.ts:6]", object, error]);
  assert.equal(hasSourceLocation(calls[0][0]), true);
  assert.equal(hasSourceLocation("ordinary message (bundle.js:1)"), false);
});

test("covers workspace packages and rejects external paths and build output", () => {
  const root = new URL("../../", import.meta.url);
  for (const path of ["packages/utils/src/index.ts", "contracts/ts/src/log.ts", "scripts/task.mjs"]) {
    const result = transform('console.info("workspace");', true, fileURLToPath(new URL(path, root)));
    assert.ok(result.code.includes(`${path}:1`));
    assert.equal(hasSourceLocation(`[${path}:1] workspace`), true);
  }
  for (const path of [
    "../outside/index.ts",
    "../prometheus-extra/index.ts",
    "packages/utils/dist/index.js",
    "desktop/out/main/index.js",
    "target/generated.js",
    "node_modules/example/index.ts",
    "packages/source-log/runtime.ts",
  ]) {
    assert.equal(transform('console.info("excluded");', true, fileURLToPath(new URL(path, root))), null, path);
  }
});

test("Vite bundles workspace package sources with their original locations", async () => {
  const { build } = await import("vite");
  const entry = fileURLToPath(new URL("../src/log-fixture.ts", import.meta.url));
  const dependency = fileURLToPath(new URL("../../packages/log-fixture/src/index.ts", import.meta.url));
  for (const enabled of [false, true]) {
    const result = await build({
      configFile: false,
      logLevel: "silent",
      plugins: [
        sourceLocationPlugin(enabled),
        {
          name: "workspace-log-fixture",
          resolveId(id) {
            if (id === entry || id === dependency) return id;
          },
          load(id) {
            if (id === entry) return `import ${JSON.stringify(dependency)};`;
            if (id === dependency) return '\nconsole.info("cross-package-marker");';
          },
        },
      ],
      build: { write: false, minify: false, rollupOptions: { input: entry } },
    });
    const code = result.output.map((item) => item.code ?? "").join("\n");
    assert.ok(code.includes("cross-package-marker"));
    assert.equal(code.includes("packages/log-fixture/src/index.ts:2"), enabled);
  }
});
