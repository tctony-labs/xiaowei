import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { createUpdateService } from "../../src/main/services/update/service.ts";

function fixture(packaged = true, platform = "darwin") {
  const checks: boolean[] = [];
  let emit = (_event: string) => {};
  let opened = 0;
  let closed = 0;
  let resumed = 0;
  let failCheck = false;
  let finish = () => {};
  const preparation = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let prepared = 0;
  const visibility: boolean[] = [];
  const service = createUpdateService({
    packaged,
    platform,
    frameworkPath: "/test/Sparkle.framework",
    windowVisibilityChanged: (visible) => visibility.push(visible),
    open(path, event) {
      assert.equal(path, "/test/Sparkle.framework");
      opened++;
      emit = event;
      return {
        check(background) {
          if (failCheck) throw new Error("Update session in progress");
          checks.push(background);
        },
        resumeInstall() {
          resumed++;
        },
        close() {
          closed++;
        },
      };
    },
    prepareInstall() {
      prepared++;
      return preparation;
    },
  });
  return {
    service,
    checks,
    visibility,
    emit: (event: string) => emit(event),
    finish: () => finish(),
    failCheck: (value: boolean) => {
      failCheck = value;
    },
    counts: () => ({ opened, closed, resumed, prepared }),
  };
}

test("updates are disabled in development and on other platforms", () => {
  for (const [packaged, platform] of [
    [false, "darwin"],
    [true, "win32"],
    [true, "linux"],
  ] as const) {
    const item = fixture(packaged, platform);
    item.service.start();
    assert.equal(item.counts().opened, 0);
    assert.throws(() => item.service.check(), /unavailable/);
    item.service.close();
  }
});

test("startup checks in the background, manual checks are interactive and failures remain retryable", () => {
  const item = fixture();
  item.service.start();
  item.service.start();
  item.service.check();
  assert.deepEqual(item.checks, [true, false]);
  item.failCheck(true);
  assert.throws(() => item.service.check(), /session in progress/);
  item.failCheck(false);
  item.service.check();
  item.service.close();
  item.service.close();
  item.service.start();
  assert.deepEqual(item.checks, [true, false, false]);
  assert.deepEqual(item.counts(), { opened: 1, closed: 1, resumed: 0, prepared: 0 });
  assert.throws(() => item.service.check(), /unavailable/);
});

test("Sparkle relaunch waits for application shutdown and ignores duplicate preparation events", async () => {
  const item = fixture();
  item.service.start();
  item.emit("update-available 0.2.0");
  item.emit("prepare-install");
  item.emit("prepare-install");
  assert.equal(item.counts().prepared, 1);
  assert.equal(item.counts().resumed, 0);
  item.finish();
  await new Promise(setImmediate);
  assert.equal(item.counts().resumed, 1);
  item.service.close();
});

test("shutdown suppresses late native events and a late installation continuation", async () => {
  const item = fixture();
  item.service.start();
  item.emit("prepare-install");
  item.service.close();
  item.emit("prepare-install");
  item.finish();
  await new Promise(setImmediate);
  assert.equal(item.counts().prepared, 1);
  assert.equal(item.counts().resumed, 0);
});

test("native initialization failure leaves manual checks unavailable without aborting the application", () => {
  const warning = mock.method(console, "warn", () => {});
  const service = createUpdateService({
    packaged: true,
    platform: "darwin",
    frameworkPath: "/missing/Sparkle.framework",
    windowVisibilityChanged() {},
    open() {
      throw new Error("Missing SUPublicEDKey");
    },
    async prepareInstall() {},
  });
  try {
    service.start();
    assert.throws(() => service.check(), /unavailable/);
    assert.equal(warning.mock.callCount(), 1);
    service.close();
  } finally {
    warning.mock.restore();
  }
});

test("failed application preparation blocks installation and records the failure", async () => {
  const error = mock.method(console, "error", () => {});
  let emit = (_message: string) => {};
  let resumed = false;
  const service = createUpdateService({
    packaged: true,
    platform: "darwin",
    frameworkPath: "/test/Sparkle.framework",
    windowVisibilityChanged() {},
    open(_path, callback) {
      emit = callback;
      return {
        check() {},
        close() {},
        resumeInstall() {
          resumed = true;
        },
      };
    },
    async prepareInstall() {
      throw new Error("Storage close failed");
    },
  });
  try {
    service.start();
    emit("prepare-install");
    await new Promise(setImmediate);
    assert.equal(resumed, false);
    assert.equal(error.mock.callCount(), 1);
  } finally {
    service.close();
    error.mock.restore();
  }
});

test("native update windows keep Dock visibility until dismissal and ignore late events", () => {
  const item = fixture();
  item.service.start();
  assert.deepEqual(item.visibility, []);
  item.emit("ui-visible");
  item.emit("ui-visible");
  item.emit("ui-hidden");
  item.service.check();
  item.emit("ui-visible");
  item.emit("ui-hidden");
  assert.deepEqual(item.visibility, [true, false, true, false]);
  item.emit("ui-visible");
  item.service.close();
  item.emit("ui-visible");
  assert.deepEqual(item.visibility, [true, false, true, false, true, false]);
});

test("a rejected manual check restores previous native window visibility", () => {
  const item = fixture();
  item.service.start();
  item.failCheck(true);
  assert.throws(() => item.service.check());
  assert.deepEqual(item.visibility, [true, false]);
  item.emit("ui-visible");
  assert.throws(() => item.service.check());
  assert.deepEqual(item.visibility, [true, false, true]);
  item.service.close();
});
