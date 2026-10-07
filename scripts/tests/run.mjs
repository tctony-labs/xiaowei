import { runPnpm, withRustNapiFixtures } from "./rust-napi-fixtures.mjs";

runPnpm(["test:patches"]);
runPnpm(["build:rust"]);

await withRustNapiFixtures(
  ["search", "clipboard"],
  () => {
    runPnpm(["-r", "--workspace-concurrency=1", "test"], {
      ...process.env,
      XIAOWEI_TEST_NAPI_PREPARED: "1",
    });
  },
  { prepared: false, productionPrepared: true },
);

runPnpm(["test:tooling"]);
