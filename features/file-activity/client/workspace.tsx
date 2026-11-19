import { useEffect } from "react";
import { Text, View } from "react-native";
import { usePaseo, useTabState, type PluginClientContext, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Action, Picker } from "./controls";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { FileActivityPanel, viewSchema, type Observe } from "./panel";

type Paseo = PluginClientContext["paseo"];
type Choice = { id: string; label: string };
export type DirectoryLoader = (paseo: Paseo, workspaceId: string, signal: AbortSignal) => Promise<Choice[]>;
const workspaceViewSchema = z.object({ selectedAgentId: z.string(), views: z.record(z.string(), viewSchema) });

// The 0.15.4 directory cannot filter by workspace. Page the directory and filter locally.
export const listWorkspaceAgents: DirectoryLoader = async (paseo, workspaceId, signal) => {
  const agents = new Map<string, Choice>();
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    if (signal.aborted) throw new Error("会话列表读取已取消。");
    const result = await paseo.agents.list({ scope: "active", sort: [{ key: "created_at", direction: "asc" }], page: { limit: 200, ...(cursor ? { cursor } : {}) }, signal });
    if (signal.aborted) throw new Error("会话列表读取已取消。");
    for (const { agent } of result.entries) {
      if (agent.workspaceId === workspaceId && !agent.archivedAt) agents.set(agent.id, { id: agent.id, label: (agent.title || agent.provider) + " · " + agent.id.slice(0, 8) });
    }
    if (!result.pageInfo.hasMore) return [...agents.values()];
    const next = result.pageInfo.nextCursor;
    if (!next || seen.has(next)) throw new Error("会话列表分页未前进，请重新读取。");
    seen.add(next); cursor = next;
  }
};

export function WorkspaceFileActivityPanel(props: PluginWorkspacePanelProps & { observe: Observe; loadAgents: DirectoryLoader }) {
  const paseo = usePaseo();
  const [state, setState] = useTabState(props.tab, workspaceViewSchema, { selectedAgentId: "", views: {} });
  const query = useQuery({
    queryKey: ["zeonest", "file-activity", "workspace-agents", props.host.id, props.workspaceId],
    queryFn: ({ signal }) => props.loadAgents(paseo, props.workspaceId, signal),
    retry: false, staleTime: 10_000, gcTime: 60_000, refetchOnWindowFocus: false,
  });
  const agents = query.data ?? [];
  useEffect(() => {
    if (!state.selectedAgentId && agents.length === 1) setState({ ...state, selectedAgentId: agents[0]!.id });
  }, [state, agents, setState]);
  const agentId = state.selectedAgentId;
  const available = agents.some((agent) => agent.id === agentId);
  const tab = {
    ...props.tab, state: state.views[agentId],
    setState(value: Parameters<typeof props.tab.setState>[0]) {
      const parsed = viewSchema.safeParse(value);
      if (parsed.success) setState({ ...state, views: { ...state.views, [agentId]: parsed.data } });
    },
  };
  const colors = props.theme.colors;
  return <View style={{ flex: 1, minHeight: 0, backgroundColor: colors.surface0 }}>
    <View style={{ paddingHorizontal: props.layout.compact ? 8 : 12, paddingVertical: 4, gap: 4, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <View style={{ flex: 1, minWidth: 0 }}><Picker label="会话" value={agentId} colors={colors} compact={props.layout.compact} options={[
          { label: "选择会话", value: "" },
          ...(!available && agentId ? [{ label: "所选会话（当前不可用）", value: agentId }] : []),
          ...agents.map((agent) => ({ label: agent.label, value: agent.id })),
        ]} onChange={(selectedAgentId) => setState({ ...state, selectedAgentId })} /></View>
        <Action label="重新读取会话列表" text="" icon="RefreshCw" colors={colors} compact={props.layout.compact}
          disabled={query.isFetching} onPress={() => { void query.refetch(); }} />
      </View>
      {query.isPending ? <Text style={{ color: colors.foregroundMuted }}>正在读取工作区会话…</Text> : null}
      {query.isError ? <Text accessibilityLiveRegion="polite" style={{ color: colors.statusDanger }}>会话列表读取失败：{query.error.message}</Text> : null}
      {!query.isPending && !query.isError && !agents.length ? <Text style={{ color: colors.foregroundMuted }}>当前工作区没有可用会话。</Text> : null}
      {!agentId && agents.length > 1 ? <Text style={{ color: colors.foregroundMuted }}>请选择要查看的会话。</Text> : null}
      {agentId && !available && !query.isPending ? <Text style={{ color: colors.statusWarning }}>所选会话当前不可用，请重新选择或刷新列表。</Text> : null}
    </View>
    {available ? <FileActivityPanel key={props.host.id + ":" + props.workspaceId + ":" + agentId} {...props} context="agent" agentId={agentId} params={{ agentId }} tab={tab} observe={props.observe} /> : null}
  </View>;
}
