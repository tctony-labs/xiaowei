import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import { createInterface } from "node:readline";

export async function createFixture(binary, now, businessCode) {
  let child;
  const counts = { health: 0, refresh: 0, user: 0, wsUser: 0, login: 0, logout: 0, never: 0 };
  const sockets = new Set();
  const closed = new Map();
  const disconnects = new Map();
  for (const label of ["cancel", "close", "timeout"]) {
    closed.set(label, new Promise((resolve) => disconnects.set(label, resolve)));
  }
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
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const path = request.url;
      assert.equal(request.method, "POST");
      response.setHeader("content-type", "application/json");
      const reply = (data) => response.end(JSON.stringify({ code: 0, msg: "ok", data }));
      if (path === "/fixture/authenticate") {
        assert.match(request.headers.authorization, /^Bearer access_[01]$/);
        response.end(JSON.stringify({ code: "authenticated" }));
      } else if (path.endsWith("/common.Health/Check")) {
        assert.equal(request.headers.authorization, undefined);
        const label = path.split("/")[1];
        if (["cancel", "close", "timeout"].includes(label)) {
          response.on("close", () => disconnects.get(label)());
          if (label !== "timeout") child.stdin.write(`${label}\n`);
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
        counts.refresh += 1;
        reply(tokens(counts.refresh));
      } else if (path === "/api/auth.Auth/GetCurrentUser") {
        counts.user += 1;
        if (request.headers["x-fixture-transport"] === "websocket") counts.wsUser += 1;
        reply({ user: user(true), device, session_id: "fixture-session" });
      } else if (path === "/api/auth.Auth/Logout") {
        counts.logout += 1;
        reply({});
      } else if (path === "/api/auth.Auth/Login") {
        counts.login += 1;
        assert.equal(body.password.password, " synthetic fixture password ");
        reply({ authenticated: { user: user(false), device, tokens: tokens(0) } });
      } else {
        throw new Error(`Unexpected fixture route: ${path}`);
      }
    } catch (error) {
      console.error(error);
      response.destroy(error);
      child?.kill("SIGTERM");
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  const gateway = spawn(binary, [], {
    env: { XIAOWEI_AUTH_FIXTURE_TARGET: url },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const gatewayExit = once(gateway, "exit");
  const reader = createInterface({ input: gateway.stdout });
  const [line] = await once(reader, "line");
  reader.close();
  const address = new URL(line);
  server.on("upgrade", (request, downstream, head) => {
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
    url,
    async run(command, arguments_, env) {
      child = spawn(command, arguments_, { env, stdio: ["pipe", "inherit", "inherit"] });
      const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
      try {
        const [code, signal] = await once(child, "exit");
        assert.equal(signal, null, "binding verification timed out or crashed");
        assert.equal(code, 0, "binding verification failed");
        await Promise.race([
          Promise.all(closed.values()),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("cancelled sockets remained open")), 5000).unref(),
          ),
        ]);
        assert.deepEqual(counts, {
          health: 1,
          refresh: 2,
          user: 3,
          wsUser: 1,
          login: 1,
          logout: 1,
          never: 0,
        });
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      gateway.stdin.end();
      const [code] = await gatewayExit;
      assert.equal(code, 0, "Go fixture or race detector failed");
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
