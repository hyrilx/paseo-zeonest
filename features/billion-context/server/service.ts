import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { dashboardUrl } from "../shared/contracts";
import type { Preferences } from "../shared/settings";
import { readStatus } from "./http";

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
export async function resolveTarget(
  paseo: Paseo, input: { workspaceId: string; agentId?: string }, preferences: Preferences,
  signal: AbortSignal, lookup: typeof readStatus = readStatus,
) {
  const check = () => { if (signal.aborted) throw new Error("Billion Context 已停止"); };
  check();
  const workspace = await paseo.workspaces.ref(input.workspaceId).refresh();
  check();
  if (!workspace || workspace.archivingAt) throw new Error("工作区不存在或已归档，请重新选择");
  let sessionId: string | undefined;
  if (input.agentId) {
    const handle = paseo.agents.ref(input.agentId);
    const refreshed = await handle.refresh();
    check();
    const agent = refreshed?.agent;
    if (!agent || agent.archivedAt || agent.internal || agent.workspaceId !== input.workspaceId) throw new Error("当前会话已不可用或不属于此工作区");
    const conversationId = agent.persistence?.sessionId;
    if (!conversationId) throw new Error("当前会话尚无 provider session ID，请在会话建立后重试");
    const parsed = statusSchema.safeParse(await lookup(preferences.serverOrigin, conversationId, signal));
    check();
    if (!parsed.success) throw new Error("Dashboard 尚未建立当前会话，或返回了非精确匹配。请在首轮请求后重试；不会打开最近会话。");
    // A restart/fork while the lookup was running must not open a previous session.
    const latest = (await handle.refresh())?.agent;
    check();
    if (!latest || latest.archivedAt || latest.workspaceId !== input.workspaceId || latest.persistence?.sessionId !== conversationId) {
      throw new Error("当前会话已改变，请重新点击详情入口");
    }
    sessionId = parsed.data.sessionId;
  }
  return { url: dashboardUrl(preferences.browserOrigin || preferences.serverOrigin, sessionId), workspaceId: input.workspaceId };
}
