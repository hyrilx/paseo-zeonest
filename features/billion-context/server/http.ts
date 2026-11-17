import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { URL } from "node:url";

export class DashboardRequestError extends Error {
  constructor(readonly kind: "unreachable" | "timeout" | "http" | "invalid", message: string, readonly statusCode?: number) {
    super(message);
    this.name = "DashboardRequestError";
  }
}
export function readStatus(origin: string, conversationId: string, signal: AbortSignal, timeoutMs = 5000): Promise<unknown> {
  const url = new URL("/__bili/plugin/status", origin);
  url.searchParams.set("conversationId", conversationId);
  return readJson(url, signal, timeoutMs);
}
export function readManifest(origin: string, signal: AbortSignal, timeoutMs = 2000): Promise<unknown> {
  return readJson(new URL("/__bili/plugin/manifest", origin), signal, timeoutMs);
}
export function readHealth(origin: string, signal: AbortSignal, timeoutMs = 2000): Promise<unknown> {
  return readJson(new URL("/__bili/health", origin), signal, timeoutMs);
}
// No redirects, cookies, authorization or response bodies in errors.
function readJson(url: URL, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const fail = (error: unknown) => reject(signal.aborted ? new Error("Billion Context 已停止")
      : timedOut ? new DashboardRequestError("timeout", "Dashboard 请求超时，请检查实例连接及请求时限")
      : error instanceof DashboardRequestError ? error
      : new DashboardRequestError("unreachable", "Dashboard 实例无法连接或响应中断，请检查实例地址"));
    const request = (url.protocol === "https:" ? httpsGet : httpGet)(url, {
      signal, headers: { accept: "application/json" },
    }, (response) => {
      response.on("error", fail);
      if (response.statusCode !== 200) {
        fail(new DashboardRequestError("http", response.statusCode === 404
          ? "此 dashboard 未找到当前会话。请确认实例地址，并在 billion-context 处理首轮请求后重试。"
          : "Dashboard 状态接口返回 HTTP " + response.statusCode, response.statusCode));
        response.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 262144) { request.destroy(new DashboardRequestError("invalid", "Dashboard 状态响应超过 256 KiB")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { fail(new DashboardRequestError("invalid", "Dashboard 状态接口未返回有效 JSON")); }
      });
    });
    const deadline = setTimeout(() => { timedOut = true; request.destroy(new DashboardRequestError("timeout", "Dashboard 请求超时")); }, timeoutMs);
    request.on("close", () => clearTimeout(deadline));
    request.on("error", fail);
  });
}
