import { z } from "zod";
import { instanceIdentity, type DashboardInstance } from "../shared/contracts";
import { discoverOrigins, MAX_CANDIDATES } from "./discovery";
import { DashboardRequestError, readHealth, readManifest, readStatus } from "./http";

const manifestSchema = z.object({ ok: z.literal(true), proxy: z.literal("billion-context"), version: z.string().min(1) });
const healthSchema = z.object({
  ok: z.literal(true), instanceId: z.string().regex(/^[a-zA-Z0-9-]{1,128}$/),
  pid: z.number().int().positive().safe(), startedAt: z.number().int().positive().max(8640000000000000),
});
const statusSchema = z.object({ ok: z.literal(true), sessionId: z.string().min(1).max(2048), fallback: z.literal(false).optional() });
type Match = DashboardInstance & { sessionId?: string };
const failureLabels = {
  unreachable: "个历史地址无法连接或响应中断", timeout: "个实例请求超时，请稍后重试或固定实例地址",
  http: "个实例接口返回 HTTP 错误，请检查服务状态",
  foreign: "个地址未通过 Billion Context 标识校验", missing: "个实例未收录当前 provider session ID",
  pending: "个实例尚未建立压缩会话，请在首轮请求完成后重试", invalid: "个实例返回无效或非精确映射，已拒绝跳转",
} as const;
type Failure = keyof typeof failureLabels;

export async function resolveInstances(
  conversationId: string | undefined, serverOrigin: string, selectedOrigin: string | undefined, signal: AbortSignal,
  lookup: typeof readStatus = readStatus, discover: typeof discoverOrigins = discoverOrigins,
  probe: typeof readManifest = readManifest, health: typeof readHealth = readHealth, expectedIdentity?: string,
): Promise<Match[]> {
  const check = () => { if (signal.aborted) throw new Error("Billion Context 已停止"); };
  check();
  const automatic = !serverOrigin;
  let origins = automatic ? [...new Set(await discover(signal))].slice(0, MAX_CANDIDATES) : [serverOrigin];
  check();
  if (expectedIdentity && !selectedOrigin) throw new Error("实例身份缺少对应地址，请重新选择");
  if (selectedOrigin) {
    if (!origins.includes(selectedOrigin)) throw new Error("实例记录已改变，请重新发现后选择");
    origins = [selectedOrigin];
  }
  if (!origins.length) throw new Error("没有发现 dashboard 地址。请确认默认日志可读；自定义或关闭日志时需配置实例地址。不会打开最近会话。");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  let expired = false;
  let identityChanged = false;
  const deadline = setTimeout(() => { expired = true; controller.abort(); }, 12000);
  const failures: Partial<Record<Failure, number>> = {};
  const fail = (kind: Failure) => { failures[kind] = (failures[kind] ?? 0) + 1; };
  const results: (Match | undefined)[] = new Array(origins.length);
  let next = 0;
  async function inspect(origin: string): Promise<Match | undefined> {
    let stage: "manifest" | "status" = "manifest";
    try {
      let identity: z.infer<typeof healthSchema> | undefined;
      if (automatic) {
        if (!manifestSchema.safeParse(await probe(origin, controller.signal, 2000)).success) { fail("foreign"); return; }
        if (controller.signal.aborted) return;
        // Older versions may not expose identity. Keep their origin distinct rather than guessing.
        try {
          const parsed = healthSchema.safeParse(await health(origin, controller.signal, 2000));
          if (parsed.success) identity = parsed.data;
        } catch { /* Identity is optional; status still has to match exactly. */ }
      }
      if (controller.signal.aborted) return;
      const match: Match = { origin, ...(identity ? { instanceId: identity.instanceId, pid: identity.pid, startedAt: identity.startedAt } : {}) };
      if (expectedIdentity && instanceIdentity(match) !== expectedIdentity) { identityChanged = true; return; }
      if (!conversationId) return match;
      stage = "status";
      const value = await lookup(origin, conversationId, controller.signal, 5000);
      const parsed = statusSchema.safeParse(value);
      if (!parsed.success) {
        const pending = !!value && typeof value === "object" && "ok" in value && value.ok === true
          && "sessionId" in value && value.sessionId === null && !("fallback" in value && value.fallback === true);
        if (!automatic) throw new Error("Dashboard 尚未建立当前会话，或返回了非精确匹配。请在首轮请求后重试；不会打开最近会话。");
        fail(pending ? "pending" : "invalid"); return;
      }
      return { ...match, sessionId: parsed.data.sessionId };
    } catch (error) {
      if (!automatic) throw error;
      fail(error instanceof DashboardRequestError
        ? error.kind === "http" ? (error.statusCode === 404 && stage === "status" ? "missing" : "http") : error.kind
        : "invalid");
      return;
    }
  }
  async function worker() {
    // A worker consumes another known address as soon as a stale one fails; no port enumeration.
    while (next < origins.length && !controller.signal.aborted) {
      const index = next++;
      results[index] = await inspect(origins[index]!);
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(8, origins.length) }, worker));
    check();
    if (expired) throw new Error(`自动发现达到 12 秒时限（已检查 ${next}/${origins.length} 个地址），不能确认唯一实例。请重试或配置实例地址。`);
    if (identityChanged) throw new Error("所选地址的实例身份已改变或无法验证，请重新发现后选择");
    const matches: Match[] = [];
    const identities = new Map<string, Match>();
    for (const match of results) {
      if (!match) continue;
      const key = instanceIdentity(match);
      const previous = key ? identities.get(key) : undefined;
      if (previous) {
        if (previous.sessionId !== match.sessionId) throw new Error("同一实例返回了不一致的会话映射，请重试");
        continue;
      }
      if (key) identities.set(key, match);
      matches.push(match);
    }
    if (!matches.length) {
      const detail = (Object.keys(failureLabels) as Failure[]).filter((kind) => failures[kind])
        .map((kind) => `${failures[kind]} ${failureLabels[kind]}`).join("；");
      throw new Error(`未找到${conversationId ? "可读取当前精确会话的" : "可用的"} dashboard：${detail}。不会打开最近会话。`);
    }
    if (matches.length > 16) throw new Error("发现超过 16 个可用实例，请在配置中固定实例地址后打开");
    return matches;
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", abort);
    controller.abort();
  }
}
