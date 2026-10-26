import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import { createInterface } from "node:readline";

async function within(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function createFixture(binary, now, businessCode, options = {}) {
  const listenHost = options.listenHost ?? "127.0.0.1";
  const advertisedHost = options.advertisedHost ?? listenHost;
  const controlPrefix = options.samples ? `/__test/${randomUUID()}` : null;
  let child;
  let failed;
  let publicUrl;
  let completed = false;
  let connections = 0;
  let mode = "normal";
  const accountMode = options.scenario === "account" || options.scenario === "account-ui";
  const cases = [];
  const counts = { health: 0, refresh: 0, user: 0, wsUser: 0, login: 0, logout: 0, never: 0 };
  const sockets = new Set();
  const webSockets = new Set();
  const events = new Set();
  const waiters = new Map();
  const resetWaiters = () => {
    waiters.clear();
    events.clear();
    for (const event of [
      "request-cancel",
      "request-close",
      "request-timeout",
      "closed-cancel",
      "closed-close",
      "closed-timeout",
      "request-login",
      "closed-login",
      "request-user",
      "closed-user",
      "request-refresh",
      "closed-refresh",
    ]) {
      let resolve;
      const promise = new Promise((finish) => {
        resolve = finish;
      });
      waiters.set(event, { promise, resolve });
    }
  };
  resetWaiters();
  const mark = (event) => {
    events.add(event);
    waiters.get(event)?.resolve();
  };
  const summary = () => ({
    counts: { ...counts },
    connections,
    openWebSockets: webSockets.size,
    events: [...events],
    completed,
    failed: Boolean(failed),
    cases: [...cases],
  });
  const ensureHealthy = () => {
    if (failed) throw new Error(`Fixture request validation failed (${failed.name})`);
  };
  const assertComplete = async (kind = "runtime") => {
    ensureHealthy();
    if (kind === "runtime") {
      await within(
        Promise.all(
          ["cancel", "close", "timeout"].map((label) => waiters.get(`closed-${label}`).promise),
        ),
        5000,
        "cancelled sockets remained open",
      );
      assert.deepEqual(counts, {
        health: 1,
        refresh: 2,
        user: 3,
        wsUser: 1,
        login: 1,
        logout: 1,
        never: 0,
      });
    } else if (kind === "ui") {
      assert.deepEqual(counts, {
        health: 3,
        refresh: 0,
        user: 3,
        wsUser: 3,
        login: 0,
        logout: 0,
        never: 0,
      });
      assert.ok(connections >= 3, "foreground resume or client recreation did not reconnect");
    } else if (kind === "account") {
      assert.deepEqual(cases.map((item) => item.name).sort(), [
        "checkpoint-cancel",
        "checkpoint-save-failure",
        "invalidated",
        "login",
        "login-rollback",
        "login-save-cancel",
        "logout-delete-failure",
        "logout-offline",
        "offline-retained",
        "restore",
      ]);
    } else if (kind === "account-ui") {
      assert.ok(counts.login >= 3, "UI did not exercise failure, success and cancellation");
      assert.ok(counts.logout >= 1, "UI did not log out its synthetic session");
      assert.ok(counts.user >= 3, "UI did not validate on reconnect and process relaunch");
      assert.ok(connections >= 3, "UI did not reconnect and restore after relaunch");
    } else {
      throw new Error("Unknown fixture scenario");
    }
    assert.equal(webSockets.size, 0, "client WebSocket remained open");
    ensureHealthy();
    completed = true;
    return summary();
  };
  const tokens = (index) => ({
    session_id: "fixture-session",
    access_token: `access_${index}`,
    refresh_token: `refresh_${index}`,
    access_expires_at_ms: String(now + 7_200_000),
    refresh_expires_at_ms: String(now + 86_400_000),
  });
  const user = (updated) => ({
    user_id: "fixture-user",
    created_at_ms: "42",
    email: updated ? "updated@example.test" : "before@example.test",
  });
  const device = {
    device_id: "00000000-0000-4000-8000-000000000001",
    device_name: "fixture-device",
  };
  const server = createServer(async (request, response) => {
    try {
      response.setHeader("content-type", "application/json");
      response.setHeader("cache-control", "no-store");
      const path = request.url;
      if (controlPrefix && path.startsWith(`${controlPrefix}/`)) {
        ensureHealthy();
        assert.equal(request.method, "GET");
        const command = path.slice(controlPrefix.length + 1);
        if (command === "bootstrap") {
          response.end(
            JSON.stringify({
              server: publicUrl,
              samples: Object.fromEntries(
                Object.entries(options.samples)
                  .filter(([, value]) => Array.isArray(value))
                  .map(([key, value]) => [key, Buffer.from(value).toString("base64")]),
              ),
            }),
          );
        } else if (command === "state") {
          response.end(JSON.stringify(summary()));
        } else if (accountMode && command === "disconnect") {
          for (const socket of webSockets) socket.destroy();
          response.end("{}");
        } else if (accountMode && command === "reset") {
          await within(
            Promise.all([...webSockets].map((socket) => once(socket, "close"))),
            5000,
            "close the previous account owner before reset",
          );
          for (const key of Object.keys(counts)) counts[key] = 0;
          connections = 0;
          mode = "normal";
          resetWaiters();
          response.end("{}");
        } else if (accountMode && command.startsWith("mode/")) {
          mode = command.slice(5);
          assert.ok(
            [
              "normal",
              "unavailable",
              "invalid",
              "hold-login",
              "hold-user",
              "hold-refresh",
            ].includes(mode),
          );
          response.end("{}");
        } else if (accountMode && command.startsWith("case/")) {
          await within(
            Promise.all([...webSockets].map((socket) => once(socket, "close"))),
            5000,
            "account case left WebSocket open",
          );
          cases.push({ name: command.slice(5), counts: { ...counts } });
          response.end("{}");
        } else if (command.startsWith("wait/")) {
          const waiter = waiters.get(command.slice(5));
          assert.ok(waiter, "Unknown fixture event");
          await within(waiter.promise, 15_000, "fixture event did not arrive");
          ensureHealthy();
          response.end(JSON.stringify(summary()));
        } else if (
          ["complete", "ui-complete", "account-complete", "account-ui-complete"].includes(command)
        ) {
          const kind = {
            complete: "runtime",
            "ui-complete": "ui",
            "account-complete": "account",
            "account-ui-complete": "account-ui",
          }[command];
          response.end(JSON.stringify(await assertComplete(kind)));
        } else {
          throw new Error("Unknown fixture control request");
        }
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      assert.equal(request.method, "POST");
      const reply = (data) => response.end(JSON.stringify({ code: 0, msg: "ok", data }));
      const failure = (code) => response.end(JSON.stringify({ code, msg: "fixture rejected" }));
      const held = (label) => {
        mark(`request-${label}`);
        response.once("close", () => mark(`closed-${label}`));
      };
      if (path === "/fixture/authenticate") {
        assert.match(request.headers.authorization, /^Bearer access_\d+$/);
        response.end(JSON.stringify({ code: "authenticated" }));
      } else if (path.endsWith("/common.Health/Check")) {
        assert.equal(request.headers.authorization, undefined);
        const label = path.split("/")[1];
        if (["cancel", "close", "timeout"].includes(label)) {
          response.on("close", () => mark(`closed-${label}`));
          mark(`request-${label}`);
          if (label !== "timeout") child?.stdin.write(`${label}\n`);
        } else if (label === "never") {
          counts.never += 1;
          reply({});
        } else if (label === "business") {
          response.end(JSON.stringify({ code: businessCode, msg: "fixture rejected" }));
        } else {
          counts.health += 1;
          reply({});
        }
      } else if (path === "/api/auth.Auth/Refresh") {
        assert.equal(body.refresh_token ?? body.refreshToken, `refresh_${counts.refresh}`);
        if (accountMode && mode === "hold-refresh") {
          held("refresh");
          return;
        }
        if (accountMode && mode === "invalid") {
          failure(10002);
          return;
        }
        if (accountMode && mode === "unavailable") {
          failure(10008);
          return;
        }
        counts.refresh += 1;
        reply(tokens(counts.refresh));
      } else if (path === "/api/auth.Auth/GetCurrentUser") {
        counts.user += 1;
        if (request.headers["x-fixture-transport"] === "websocket") counts.wsUser += 1;
        if (accountMode && mode === "hold-user") {
          held("user");
          return;
        }
        if (accountMode && mode === "invalid") {
          failure(10002);
          return;
        }
        if (accountMode && mode === "unavailable") {
          failure(10008);
          return;
        }
        reply({ user: user(true), device, session_id: "fixture-session" });
      } else if (path === "/api/auth.Auth/Logout") {
        counts.logout += 1;
        if (accountMode && mode === "unavailable") {
          failure(10008);
          return;
        }
        reply({});
      } else if (path === "/api/auth.Auth/Login") {
        counts.login += 1;
        if (accountMode && mode === "hold-login") {
          held("login");
          return;
        }
        if (accountMode && body.password.password !== " synthetic fixture password ") {
          failure(10100);
          return;
        }
        assert.equal(body.password.password, " synthetic fixture password ");
        reply({ authenticated: { user: user(false), device, tokens: tokens(0) } });
      } else {
        throw new Error("Unexpected fixture business route");
      }
    } catch (error) {
      failed = error;
      console.error(`[binding-fixture] request failed (${error.name})`);
      response.statusCode = 500;
      response.end(JSON.stringify({ error: "fixture validation failed" }));
      child?.kill("SIGTERM");
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, listenHost);
  await once(server, "listening");
  const port = server.address().port;
  publicUrl = `http://${advertisedHost}:${port}`;
  const internalHost = listenHost === "0.0.0.0" ? "127.0.0.1" : listenHost;
  const gateway = spawn(binary, [], {
    env: { XIAOWEI_AUTH_FIXTURE_TARGET: `http://${internalHost}:${port}` },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const gatewayExit = once(gateway, "exit");
  const reader = createInterface({ input: gateway.stdout });
  let address;
  try {
    const [line] = await within(
      Promise.race([
        once(reader, "line"),
        gatewayExit.then(() => {
          throw new Error("Go fixture exited before becoming ready");
        }),
      ]),
      15_000,
      "Go fixture did not become ready",
    );
    address = new URL(line);
  } catch (error) {
    gateway.kill("SIGKILL");
    await gatewayExit.catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    throw error;
  } finally {
    reader.close();
  }
  server.on("upgrade", (request, downstream, head) => {
    connections += 1;
    webSockets.add(downstream);
    downstream.once("close", () => webSockets.delete(downstream));
    const upstream = connect(Number(address.port), address.hostname, () => {
      upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n`);
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        upstream.write(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}\r\n`);
      }
      upstream.write("\r\n");
      upstream.write(head);
      downstream.pipe(upstream).pipe(downstream);
    });
    sockets.add(upstream);
    upstream.on("close", () => {
      sockets.delete(upstream);
      downstream.destroy();
    });
    downstream.on("close", () => upstream.destroy());
    upstream.on("error", () => downstream.destroy());
    downstream.on("error", () => upstream.destroy());
  });

  return {
    url: publicUrl,
    controlUrl: controlPrefix ? publicUrl + controlPrefix : null,
    summary,
    assertComplete,
    async run(command, arguments_, env) {
      child = spawn(command, arguments_, { env, stdio: ["pipe", "inherit", "inherit"] });
      try {
        const [code, signal] = await within(once(child, "exit"), 45_000, "binding test timed out");
        assert.equal(signal, null, "binding verification crashed");
        assert.equal(code, 0, "binding verification failed");
        await assertComplete();
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      gateway.stdin.end();
      let result;
      try {
        result = await within(gatewayExit, 5000, "Go fixture did not close");
      } finally {
        if (gateway.exitCode === null && gateway.signalCode === null) {
          gateway.kill("SIGKILL");
          await gatewayExit;
        }
        await new Promise((resolve) => server.close(resolve));
      }
      const [code] = result;
      assert.equal(code, 0, "Go fixture or race detector failed");
    },
  };
}
