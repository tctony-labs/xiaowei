import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFixture } from "../../crates/xiaowei-mobile/ffi/scripts/binding-fixture.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const target = join(root, "target/flutter-rust");
const fixtureBinary = join(target, "go-fixture");

function run(command, args, options) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed`);
}

mkdirSync(target, { recursive: true });
run("cargo", [
  "build",
  "--locked",
  "-p",
  "xiaowei-mobile-ffi",
  "--features",
  "flutter",
  "--lib",
  "--target-dir",
  target,
]);
run("go", ["build", "-race", "-o", fixtureBinary, "./internal/httpapi/ws/testfixture"], {
  cwd: join(root, "server"),
});

const fixture = await createFixture(fixtureBinary, Date.now(), 10008, {
  scenario: "account",
  samples: {},
});
try {
  const args = [
    "flutter",
    "--suppress-analytics",
    "test",
    "test/account_flow_test.dart",
    "--no-pub",
  ];
  await new Promise((resolve, reject) => {
    const child = spawnFlutter(args);
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Flutter account test failed (${code})`)),
    );
  });
  const result = await fetch(`${fixture.controlUrl}/case/flutter`);
  assert.equal(result.status, 200, "Flutter account fixture did not settle");
  const { counts, connections } = fixture.summary();
  assert.equal(counts.login, 2);
  assert.equal(counts.logout, 1);
  assert.ok(
    connections >= 4,
    "Expected authenticated sockets for login, reconnect, resume and recovery",
  );
} finally {
  await fixture.close();
}

function spawnFlutter(args) {
  return spawn("fvm", args, {
    cwd: join(root, "mobile"),
    env: {
      ...process.env,
      XIAOWEI_FLUTTER_TEST_LIBRARY: join(target, "debug/libxiaowei_mobile_ffi.dylib"),
      XIAOWEI_FLUTTER_TEST_SERVER: fixture.url,
      XIAOWEI_FLUTTER_TEST_CONTROL: fixture.controlUrl,
    },
    stdio: "inherit",
  });
}
