const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const { once } = require("node:events");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

// Test-only HTTPS/CONNECT fixture. Production URLs and TLS verification stay intact.
async function webFixture() {
  const requests = [];
  const held = [];
  const sockets = new Set();
  const server = https.createServer(
    {
      cert: readFileSync(join(__dirname, "web/server.pem")),
      key: readFileSync(join(__dirname, "web/server-key.pem")),
    },
    async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
      const url = new URL(request.url, `https://${request.headers.host}`);
      const provider = request.headers.host;
      const query = url.searchParams.get("q") ?? body.query ?? body.q ?? "";
      const key =
        body.api_key ??
        request.headers["x-subscription-token"] ??
        request.headers["x-api-key"] ??
        "";
      requests.push({ provider, query, key, path: url.pathname });
      const send = () => {
        if (url.pathname === "/page" || url.pathname === "/hold-page") {
          response.writeHead(200, { "content-type": "text/html" });
          response.end("<h1>Fixture documentation</h1><p>The answer is 42.</p>");
        } else if (provider === "www.bing.com") {
          response.writeHead(200, { "content-type": "text/html" });
          response.end(
            '<li class="b_algo"><h2><a href="https://example.com/page">Fixture page</a>' +
              '</h2><div class="b_caption"><p>The answer documentation.</p></div></li>',
          );
        } else {
          response.writeHead(key === "invalid-fixture-key" ? 401 : 200, {
            "content-type": "application/json",
          });
          const hit = {
            title: "Fixture page",
            url: "https://example.com/page",
            content: key.endsWith("-b") ? "version-b" : "version-a",
          };
          if (provider === "api.tavily.com") response.end(JSON.stringify({ results: [hit] }));
          else if (provider === "api.search.brave.com") {
            response.end(
              JSON.stringify({ web: { results: [{ ...hit, description: "fixture result" }] } }),
            );
          } else
            response.end(
              JSON.stringify({ organic: [{ ...hit, link: hit.url, snippet: "fixture result" }] }),
            );
        }
      };
      if (query === "hold" || url.pathname === "/hold-page") held.push(send);
      else send();
    },
  );
  const proxy = http.createServer((request, response) => {
    if (request.url === "/release") {
      for (const send of held.splice(0)) send();
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(requests));
  });
  const track = (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  };
  server.on("connection", track);
  proxy.on("connection", track);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  proxy.on("connect", (_request, socket, head) => {
    const upstream = net.connect(server.address().port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    track(upstream);
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  return {
    url: `http://127.0.0.1:${proxy.address().port}`,
    ca: join(__dirname, "web/ca.pem"),
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise((resolve) => server.close(resolve)),
        new Promise((resolve) => proxy.close(resolve)),
      ]);
    },
  };
}

module.exports = { webFixture };
