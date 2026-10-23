import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  localUpdateDirectory,
  localUpdateOrigin,
  localUpdatePort,
} from "./local-update-config.mjs";
import { verifySignedAppcast, verifyUpdateArchive } from "./sparkle.mjs";

export function createLocalUpdateServer(directory, scenario = "valid") {
  const scenarios = ["valid", "full-only", "invalid-feed", "invalid-archive", "invalid-delta"];
  if (!scenarios.includes(scenario)) throw new Error("Unknown update scenario");
  const manifest = JSON.parse(readFileSync(join(directory, "test.json"), "utf8"));
  const source = join(directory, "source");
  const fullOnly = scenario === "full-only" || scenario === "invalid-archive";
  const deltas = fullOnly ? [] : (manifest.deltas ?? []);
  const feedName = fullOnly && manifest.deltas?.length ? "appcast-full.xml" : "appcast.xml";
  const feed = readFileSync(join(source, feedName));
  verifySignedAppcast({ feed, key: manifest.key });
  const files = new Map();
  for (const { filename, deltaFrom } of [{ filename: manifest.archive }, ...deltas]) {
    const pathname = `/${encodeURIComponent(filename)}`;
    const path = join(source, filename);
    verifyUpdateArchive({
      xml: feed.toString(),
      archive: readFileSync(path),
      key: manifest.key,
      version: manifest.newVersion,
      url: `${localUpdateOrigin}${pathname}`,
      deltaFrom,
    });
    files.set(pathname, { path, length: statSync(path).size, delta: deltaFrom !== undefined });
  }

  return createServer((request, response) => {
    const pathname = new URL(request.url, localUpdateOrigin).pathname;
    response.on("finish", () =>
      console.info(`Local update ${request.method} ${pathname}: ${response.statusCode}`),
    );
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    if (pathname === "/appcast.xml") {
      const payload =
        scenario === "invalid-feed"
          ? Buffer.from(
              feed.toString().replace("<sparkle:version>", "<!-- tampered --><sparkle:version>"),
            )
          : feed;
      response.writeHead(200, {
        "Content-Type": "application/xml",
        "Content-Length": payload.length,
      });
      response.end(request.method === "HEAD" ? undefined : payload);
      return;
    }
    const file = files.get(pathname);
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": file.delta ? "application/octet-stream" : "application/zip",
      "Content-Length": file.length,
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    const tampered =
      (scenario === "invalid-archive" && !file.delta) ||
      (scenario === "invalid-delta" && file.delta);
    if (tampered) response.write(Buffer.from([0]));
    const stream = createReadStream(file.path, tampered ? { start: 1 } : undefined);
    stream.on("error", (error) => {
      console.error("Local update archive read failed", error.message);
      response.destroy(error);
    });
    response.on("close", () => stream.destroy());
    stream.pipe(response);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3)
    throw new Error(
      "Usage: local-update-server.mjs [valid|full-only|invalid-feed|invalid-archive|invalid-delta]",
    );
  const scenario = process.argv[2] ?? "valid";
  const server = createLocalUpdateServer(localUpdateDirectory, scenario);
  server.on("error", (error) => {
    console.error("Local update source failed", error.message);
    process.exitCode = 1;
  });
  server.listen(localUpdatePort, "127.0.0.1", () => {
    console.info(
      `Local update source ready: ${localUpdateOrigin}/appcast.xml; scenario=${scenario}`,
    );
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close());
}
