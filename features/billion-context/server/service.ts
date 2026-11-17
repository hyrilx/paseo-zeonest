import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { URL } from "node:url";
import { dashboardUrl } from "../shared/contracts";
import type { Preferences } from "../shared/settings";
import { readHealth, readManifest, readStatus } from "./http";
import { discoverOrigins } from "./discovery";
import { resolveInstances } from "./instances";

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
export async function resolveTarget(
  paseo: Paseo, input: { workspaceId: string; agentId?: string; instanceOrigin?: string; instanceKey?: string }, preferences: Preferences,
  signal: AbortSignal, lookup: typeof readStatus = readStatus,
  discover: typeof discoverOrigins = discoverOrigins, probe: typeof readManifest = readManifest, health: typeof readHealth = readHealth,
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
  const matches = await resolveInstances(conversationId, preferences.serverOrigin, input.instanceOrigin, signal, lookup, discover, probe, health, input.instanceKey);
  check();
  if (handle) {
    // Refresh again even before offering a choice; selection repeats all identity checks.
    const latest = (await handle.refresh())?.agent;
    check();
    if (!latest || latest.archivedAt || latest.internal || latest.workspaceId !== input.workspaceId || latest.persistence?.sessionId !== conversationId) {
      throw new Error("当前会话已改变，请重新点击详情入口");
    }
  }
  if (matches.length > 1) return {
    instances: matches.map((match) => match.origin),
    instanceDetails: matches.map(({ origin, instanceId, pid, startedAt }) => ({ origin, instanceId, pid, startedAt })),
    workspaceId: input.workspaceId,
  };
  const match = matches[0]!;
  let port: string;
  try {
    const instance = new URL(match.origin);
    port = instance.port || (instance.protocol === "https:" ? "443" : "80");
  } catch { throw new Error("实例地址无效，请重新发现后选择"); }
  const browserOrigin = (preferences.browserOrigin || match.origin).replace("{port}", port);
  return { url: dashboardUrl(browserOrigin, match.sessionId), workspaceId: input.workspaceId };
}
