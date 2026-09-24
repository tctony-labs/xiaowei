import { createHash } from "node:crypto";

export const ICON_SCHEME = "xiaowei-icon";

// URLs identify resources; constructing one never reads an icon or waits for native code.
export function createIconResources(readIcon: (path: string) => Promise<Uint8Array | undefined>) {
  const paths = new Map<string, string>();
  const cache = new Map<string, Promise<Uint8Array | undefined>>();

  return {
    url(path: string): string {
      const key = createHash("sha256").update(path).digest("hex");
      paths.set(key, path);
      return `${ICON_SCHEME}://app/${key}`;
    },

    async respond(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const key = url.pathname.slice(1);
      const path = paths.get(key);
      if (request.method !== "GET" || url.hostname !== "app" || !path) {
        return new Response(null, { status: 404 });
      }

      let pending = cache.get(key);
      if (!pending) {
        pending = readIcon(path);
        cache.set(key, pending);
        const oldest = cache.keys().next().value;
        if (cache.size > 256 && oldest !== undefined) cache.delete(oldest);
      }

      try {
        const png = await pending;
        if (!png) {
          if (cache.get(key) === pending) cache.delete(key);
          return new Response(null, { status: 404 });
        }
        return new Response(new Uint8Array(png), {
          headers: { "Content-Type": "image/png", "Cache-Control": "max-age=3600" },
        });
      } catch (error) {
        if (cache.get(key) === pending) cache.delete(key);
        console.warn("Application icon unavailable", error);
        return new Response(null, { status: 500 });
      } finally {
        if (cache.get(key) === pending) cache.delete(key);
      }
    },

    close() {
      paths.clear();
      cache.clear();
    },
  };
}
