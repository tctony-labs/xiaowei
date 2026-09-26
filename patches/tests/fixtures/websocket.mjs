import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";

// Minimal local RFC 6455 peer: exercises the runtime's real WebSocket client without another dependency.
export async function websocketFixture(t, { message, upgrade, http } = {}) {
  const sockets = new Set();
  const requests = [];
  const frames = [];
  let connections = 0;
  let closed = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    requests.push({ method: request.method, url: request.url, headers: request.headers, body });
    if (http) http(request, response, body);
    else response.writeHead(503).end();
  });
  server.on("upgrade", (request, socket, head) => {
    connections++;
    const id = connections;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("end", () => socket.end());
    socket.on("close", () => {
      sockets.delete(socket);
      closed++;
    });
    requests.push({ method: "GET", url: request.url, headers: request.headers, id });
    if (upgrade && upgrade(request, socket) === false) return;
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const sendFrame = (opcode, bytes) => {
      const header = Buffer.alloc(bytes.length < 126 ? 2 : bytes.length < 65536 ? 4 : 10);
      header[0] = 0x80 | opcode;
      if (header.length === 2) header[1] = bytes.length;
      else if (header.length === 4) {
        header[1] = 126;
        header.writeUInt16BE(bytes.length, 2);
      } else {
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(bytes.length), 2);
      }
      socket.write(Buffer.concat([header, bytes]));
    };
    const send = (event) => sendFrame(1, Buffer.from(JSON.stringify(event)));
    let buffer = head;
    let fragments = [];
    const consume = () => {
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15;
        const final = Boolean(buffer[0] & 128);
        const masked = Boolean(buffer[1] & 128);
        let length = buffer[1] & 127;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        if (buffer.length < offset + (masked ? 4 : 0) + length) return;
        const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
        offset += masked ? 4 : 0;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        buffer = buffer.subarray(offset + length);
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        if (opcode === 8) {
          sendFrame(8, payload);
          socket.end();
          return;
        }
        if (opcode === 9) {
          sendFrame(10, payload);
          continue;
        }
        if (opcode === 1 || opcode === 0) {
          fragments.push(payload);
          if (!final) continue;
          const body = JSON.parse(Buffer.concat(fragments).toString());
          fragments = [];
          frames.push({ id, body });
          message?.({ id, body, send, socket, request });
        }
      }
    };
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      consume();
    });
    consume();
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    frames,
    get connections() {
      return connections;
    },
    get closed() {
      return closed;
    },
  };
}

export function textEvents(id = "resp_test", text = "OK") {
  const item = { type: "message", id: `msg_${id}`, role: "assistant", content: [] };
  return [
    { type: "response.created", response: { id } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        ...item,
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id,
        status: "completed",
        output: [],
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      },
    },
  ];
}

export async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for local WebSocket peer");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
