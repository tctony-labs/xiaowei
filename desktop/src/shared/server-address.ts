export function normalizeServerAddress(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("请输入完整的服务器地址，例如 https://example.com。");
  }

  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("请输入 HTTPS 地址；本地开发可使用 HTTP。");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("服务器地址不能包含账号、密码、查询参数或片段。");
  }
  return url.href.replace(/\/+$/, "");
}
