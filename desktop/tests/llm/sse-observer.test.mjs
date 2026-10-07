import assert from "node:assert/strict";
import { test } from "node:test";
import { observeSseFetch } from "../../src/main/services/llm/worker/sse-observer.ts";

// Exercise the per-request fetch adapter without a provider SDK substituting text arrival time.
test("SSE observation handles split bytes, heartbeat, CR/LF and forwards original bytes exactly once", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const separator of ["\n", "\r\n", "\r"]) {
      const bytes = new TextEncoder().encode(
        `:heartbeat${separator}${separator}data: {"usage":1}${separator}${separator}data: text${separator}${separator}`,
      );
      const timestamps = [];
      globalThis.fetch = async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream; charset=utf-8" } },
        );
      const response = await observeSseFetch((time) => timestamps.push(time))("http://fixture.test");
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
      assert.equal(timestamps.length, 1);
      assert.ok(timestamps[0] > 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("headers, partial data and non-SSE responses do not produce first SSE", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [type, text] of [
      ["text/event-stream", "data: unfinished\n"],
      ["application/json", "data: text\n\n"],
    ]) {
      globalThis.fetch = async () => new Response(text, { headers: { "content-type": type } });
      let observed = false;
      const response = await observeSseFetch(() => {
        observed = true;
      })("http://fixture.test");
      assert.equal(observed, false);
      assert.equal(await response.text(), text);
      assert.equal(observed, false);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cancel and stream failure reach the original response body", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let cancelled = false;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    const response = await observeSseFetch(() => assert.fail("no data received"))("http://fixture.test");
    await response.body.cancel();
    assert.equal(cancelled, true);
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("upstream failure"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    const failed = await observeSseFetch(() => assert.fail("no data received"))("http://fixture.test");
    await assert.rejects(failed.text(), /upstream failure/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
