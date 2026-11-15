import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { URL } from "node:url";
import { dashboardUrl } from "../shared/contracts";
import type { Preferences } from "../shared/settings";
import { readManifest, readStatus } from "./http";
import { discoverOrigins, MAX_CANDIDATES } from "./discovery";

type Paseo = PluginHandlerContext["paseo"];
interface Page<T> { entries: T[]; pageInfo: { hasMore: boolean; nextCursor?: string | null } }
async function pages<T>(load: (cursor?: string) => Promise<Page<T>>, alive: () => boolean): Promise<T[]> {
  const entries: T[] = [];
  const visited = new Set<string>();
  let cursor: string | undefined;
  do {
    if (!alive()) throw new Error("Billion Context 已停止");
    const result = await load(cursor);
    if (!alive()) throw new Error("Billion Context 已停止");
    entries.push(...result.entries);
    if (entries.length > 10000) throw new Error("宿主条目超过 10000");
    if (!result.pageInfo.hasMore) break;
    cursor = result.pageInfo.nextCursor ?? undefined;
    if (!cursor || visited.has(cursor)) throw new Error("宿主分页游标无效");
    visited.add(cursor);
  } while (cursor);
  return entries;
}
export async function listAgents(paseo: Paseo, alive: () => boolean) {
  const entries = await pages((cursor) => paseo.agents.list({
    filter: { includeArchived: false, includeInternal: false }, page: { limit: 200, cursor },
  }), alive);
  return entries.flatMap(({ agent }) => !agent.archivedAt && !agent.internal && agent.workspaceId
    ? [{ agentId: agent.id, workspaceId: agent.workspaceId }] : []);
}
export async function listWorkspaces(paseo: Paseo, alive: () => boolean) {
  const entries = await pages((cursor) => paseo.workspaces.list({ page: { limit: 200, cursor } }), alive);
  return entries.filter((entry) => !entry.archivingAt).map((entry) => ({ id: entry.id, name: entry.title ?? entry.name }));
}
const statusSchema = z.object({
  ok: z.literal(true), sessionId: z.string().min(1).max(2048), fallback: z.literal(false).optional(),
});
const manifestSchema = z.object({ ok: z.literal(true), proxy: z.literal("billion-context"), version: z.string().min(1) });
export async function resolveTarget(
  paseo: Paseo, input: { workspaceId: string; agentId?: string; instanceOrigin?: string }, preferences: Preferences,
  signal: AbortSignal, lookup: typeof readStatus = readStatus,
  discover: typeof discoverOrigins = discoverOrigins, probe: typeof readManifest = readManifest,
) {
  const check = () => { if (signal.aborted) throw new Error("Billion Context 已停止"); };
  check();
  const workspace = await paseo.workspaces.ref(input.workspaceId).refresh();
  check();
  if (!workspace || workspace.archivingAt) throw new Error("工作区不存在或已归档，请重新选择");
  const handle = input.agentId ? paseo.agents.ref(input.agentId) : undefined;
  let conversationId: string | undefined;
  if (handle) {
    const agent = (await handle.refresh())?.agent;
    check();
    if (!agent || agent.archivedAt || agent.internal || agent.workspaceId !== input.workspaceId) throw new Error("当前会话已不可用或不属于此工作区");
    conversationId = agent.persistence?.sessionId;
    if (!conversationId) throw new Error("当前会话尚无 provider session ID，请在会话建立后重试");
  }
  const automatic = !preferences.serverOrigin;
  let origins = automatic ? await discover(signal) : [preferences.serverOrigin];
  check();
  if (input.instanceOrigin) {
    if (!origins.includes(input.instanceOrigin)) throw new Error("实例记录已改变，请重新发现后选择");
    origins = [input.instanceOrigin];
  }
  const matches: { origin: string; sessionId?: string }[] = [];
  // At most 16 known origins, four concurrent probes. No network port enumeration.
  for (let offset = 0; offset < Math.min(origins.length, MAX_CANDIDATES); offset += 4) {
    check();
    const batch = await Promise.all(origins.slice(offset, offset + 4).map(async (origin) => {
      try {
        if (automatic && !manifestSchema.safeParse(await probe(origin, signal, 500)).success) return;
        if (!conversationId) return { origin };
        const parsed = statusSchema.safeParse(await lookup(origin, conversationId, signal, automatic && !input.instanceOrigin ? 1000 : 5000));
        if (!parsed.success) {
          if (!automatic) throw new Error("Dashboard 尚未建立当前会话，或返回了非精确匹配。请在首轮请求后重试；不会打开最近会话。");
          return;
        }
        return { origin, sessionId: parsed.data.sessionId };
      } catch (error) {
        if (!automatic) throw error;
        return;
      }
    }));
    check();
    matches.push(...batch.filter((value): value is { origin: string; sessionId?: string } => !!value));
  }
  if (handle) {
    // Refresh again even before offering a choice; selection repeats all identity checks.
    const latest = (await handle.refresh())?.agent;
    check();
    if (!latest || latest.archivedAt || latest.internal || latest.workspaceId !== input.workspaceId || latest.persistence?.sessionId !== conversationId) {
      throw new Error("当前会话已改变，请重新点击详情入口");
    }
  }
  if (!matches.length) throw new Error(conversationId
    ? "自动发现未找到精确匹配的会话。请在首轮请求后重试，或配置实例地址；不会打开最近会话。"
    : "未发现可用 dashboard。请确认 billion-context 正在运行；默认日志不可读或使用自定义日志时，可配置实例地址。");
  if (matches.length > 1) return { instances: matches.map((match) => match.origin), workspaceId: input.workspaceId };
  const match = matches[0]!;
  let port: string;
  try {
    const instance = new URL(match.origin);
    port = instance.port || (instance.protocol === "https:" ? "443" : "80");
  } catch { throw new Error("实例地址无效，请重新发现后选择"); }
  const browserOrigin = (preferences.browserOrigin || match.origin).replace("{port}", port);
  return { url: dashboardUrl(browserOrigin, match.sessionId), workspaceId: input.workspaceId };
}
