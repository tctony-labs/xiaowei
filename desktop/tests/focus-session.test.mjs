import assert from "node:assert/strict";
import { test } from "node:test";
import { createFocusSession } from "../src/main/windows/focus-session.ts";

function fixture() {
  const state = { foreground: 2, captures: 0, restores: 0, releases: 0 };
  const target = {
    processId: 2,
    async restore() {
      state.restores++;
      state.foreground = 2;
      return true;
    },
    async isFrontmost() {
      return state.foreground === 2;
    },
    release() {
      state.releases++;
    },
  };
  const session = createFocusSession({
    ownProcess: 1,
    frontmostProcess: () => state.foreground,
    async capture() {
      state.captures++;
      return target;
    },
  });
  return { state, target, session };
}

test("mode changes preserve one source and restoring releases it", async () => {
  const { state, session } = fixture();
  assert.equal(await session.begin(), true);
  state.foreground = 1;
  assert.equal(await session.begin(), true);
  assert.equal(state.captures, 1);
  assert.equal(await session.restore(), true);
  assert.equal(state.restores, 1);
  assert.equal(state.releases, 1);
});

test("a user-selected third application is never replaced by the old source", async () => {
  const { state, session } = fixture();
  await session.begin();
  state.foreground = 3;
  assert.equal(await session.restore(), false);
  assert.equal(state.restores, 0);
  assert.equal(state.releases, 1);
});

test("abandoning a pending capture prevents showing and releases its result", async () => {
  let finish;
  let releases = 0;
  const session = createFocusSession({
    ownProcess: 1,
    frontmostProcess: () => 2,
    capture: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const begun = session.begin();
  session.abandon();
  finish({
    release() {
      releases++;
    },
  });
  assert.equal(await begun, false);
  assert.equal(releases, 1);
});

test("a new invocation supersedes a pending restoration", async () => {
  const { state, target, session } = fixture();
  await session.begin();
  state.foreground = 1;
  let finish;
  target.restore = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const restored = session.restore();
  session.abandon();
  finish(true);
  assert.equal(await restored, false);
  assert.equal(state.releases, 1);
});
