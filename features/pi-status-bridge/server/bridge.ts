import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import type { BridgeSnapshot } from "../shared/contracts";
import type { Preferences } from "../shared/settings";
import { plainStatus } from "../shared/text";

const packetSchema = z.object({
  version: z.literal(1), sequence: z.number().int().nonnegative(),
  statuses: z.array(z.object({ key: z.string().min(1).max(256), text: z.string().max(65536) })).max(128),
  warning: z.string().max(1024).nullable(),
});
interface Session {
  token: string; agentId: string; workspaceId: string;
  seenAt: number; sequence: number; received: boolean;
  statuses: { key: string; text: string }[]; warning: string | null;
}
export const LEASE_MS = 16000;
export function createBridge(now = Date.now) {
  const sessions = new Map<string, Session>();
  const tokens = new Map<string, Session>();
  let stopped = false;
  let start: Promise<string> | undefined;
  const http = createServer((req, res) => { void receive(req, res); });
  http.requestTimeout = 5000;
  http.headersTimeout = 5000;
  http.keepAliveTimeout = 1000;

  async function receive(req: IncomingMessage, res: ServerResponse) {
    // Browser origins are never an ingestion client, even when on this machine.
    const auth = req.headers.authorization;
    const session = typeof auth === "string" ? tokens.get(auth.replace(/^Bearer /, "")) : undefined;
    if (stopped || req.method !== "POST" || req.url !== "/snapshot" || req.headers.origin || !auth?.startsWith("Bearer ") || !session) {
      res.writeHead(403).end(); req.resume(); return;
    }
    try {
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 524288) { res.writeHead(413).end(); req.destroy(); return; }
        chunks.push(buffer);
      }
      const packet = packetSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      // Closing/reopening the agent may invalidate the token while a request is in flight.
      if (stopped || tokens.get(session.token) !== session) { res.writeHead(403).end(); return; }
      if (packet.sequence > session.sequence) {
        session.sequence = packet.sequence;
        session.seenAt = now(); session.received = true;
        session.statuses = [...new Map(packet.statuses.map(({ key, text }) => [key, { key, text: plainStatus(text) }])).values()];
        session.warning = packet.warning;
      }
      res.writeHead(204).end();
    } catch {
      if (!res.headersSent) res.writeHead(400).end();
    }
  }
  function listen(): Promise<string> {
    if (stopped) return Promise.reject(new Error("Pi 状态桥接已停止"));
    return start ??= new Promise<string>((resolve, reject) => {
      http.once("error", reject);
      http.listen(0, "127.0.0.1", () => {
        http.off("error", reject);
        if (stopped) { http.close(); reject(new Error("Pi 状态桥接已停止")); return; }
        const address = http.address();
        if (!address || typeof address === "string") { reject(new Error("无法创建状态桥接端口")); return; }
        resolve(`http://127.0.0.1:${address.port}/snapshot`);
      });
    });
  }
  function remove(agentId: string) {
    const session = sessions.get(agentId);
    if (session) tokens.delete(session.token);
    sessions.delete(agentId);
  }
  async function open(agentId: string, workspaceId: string) {
    const url = await listen();
    if (stopped) throw new Error("Pi 状态桥接已停止");
    remove(agentId);
    const session: Session = { token: randomBytes(32).toString("hex"), agentId, workspaceId, seenAt: now(), sequence: -1, received: false, statuses: [], warning: null };
    sessions.set(agentId, session); tokens.set(session.token, session);
    return { ZEONEST_PI_STATUS_URL: url, ZEONEST_PI_STATUS_TOKEN: session.token };
  }
  function snapshot(preferences: Preferences): BridgeSnapshot {
    if (stopped) throw new Error("Pi 状态桥接已停止");
    const statuses: BridgeSnapshot["statuses"] = [];
    const warnings: BridgeSnapshot["warnings"] = [];
    for (const session of sessions.values()) {
      const fresh = now() - session.seenAt < LEASE_MS;
      if (!fresh) {
        warnings.push({ agentId: session.agentId, workspaceId: session.workspaceId, message: session.received
          ? "Pi 状态通道已断开，旧状态已隐藏。请检查观察器日志；若刚重载插件，请在 agent 空闲时手动重新打开会话。"
          : "尚未收到 Pi 预加载观察器连接。请检查 Node 预加载支持与观察器日志，并在 agent 空闲时手动重新打开会话。" });
        continue;
      }
      if (session.warning) warnings.push({ agentId: session.agentId, workspaceId: session.workspaceId, message: session.warning });
      for (const status of session.statuses) {
        if (!status.text.trim() || preferences.hiddenKeys.includes(status.key)) continue;
        statuses.push({ agentId: session.agentId, workspaceId: session.workspaceId, ...status,
          command: preferences.actions.find((action) => action.key === status.key)?.command ?? null,
          pinned: preferences.pinnedKeys.includes(status.key) });
      }
    }
    return { statuses, warnings };
  }
  async function close() {
    if (stopped) return;
    stopped = true; sessions.clear(); tokens.clear();
    if (!start) return;
    await start.catch(() => {});
    http.closeAllConnections();
    if (http.listening) await new Promise<void>((resolve) => http.close(() => resolve()));
  }
  return { open, remove, snapshot, close };
}
export type Bridge = ReturnType<typeof createBridge>;
