import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { usePaseo, useSettings, useTabState, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { FlatList, Icon, SettingsAction } from "@getpaseo/plugin/client/ui";
import { z } from "zod";
import { preferences, preferencesSchema, type Preferences } from "../shared/settings";
import { kinds, projectActivity, selectActivities } from "./activity";
import { createTimelineStore, observeTimeline, type TimelineStore } from "./timeline";
import type { Activity, Agent, Kind, Turn } from "./types";
import { Action, Choices, Picker, type Colors } from "./controls";
import { Code } from "./code";

export const viewSchema = z.object({
  mode: z.enum(["latest", "manual", "all"]),
  turnId: z.string(),
  sort: z.enum(["time", "kind", "path"]),
  descending: z.boolean(),
  includeUnsuccessful: z.boolean(),
  kinds: z.array(z.enum(["create", "delete", "edit", "read"])).max(4),
});
export type Observe = (agent: Agent, limit: number, source: TimelineStore) => ReturnType<typeof observeTimeline> | null;
const statusLabels = { completed: "已完成", running: "进行中", failed: "失败", canceled: "已取消" };
function ActivityRow({ item, turn, colors, previewLines, compact, open, toggle, chooseTurn }: {
  item: Activity; turn?: Turn; colors: Colors; previewLines: number; compact: boolean; open: boolean; toggle(): void; chooseTurn(): void;
}) {
  const title = kinds.find((kind) => kind.value === item.kind)!.label;
  const body = item.diff ?? item.content;
  const slash = Math.max(item.path.lastIndexOf("/"), item.path.lastIndexOf("\\"));
  const filename = item.path.slice(slash + 1) || item.path;
  const directory = slash >= 0 ? item.path.slice(0, slash + 1) : "";
  const color = item.kind === "create" ? colors.statusSuccess : item.kind === "delete" ? colors.statusDanger : item.kind === "edit" ? colors.accent : colors.foregroundMuted;
  const date = item.timestamp ? new Date(item.timestamp) : null;
  const time = date && Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "";
  return <View style={{ borderBottomWidth: 1, borderColor: colors.border }}>
    <Pressable accessibilityRole="button" accessibilityLabel={title + " " + item.path} aria-expanded={open} accessibilityState={{ expanded: open }} onPress={toggle}
      style={({ pressed }) => ({ minHeight: compact ? 52 : 44, paddingVertical: 6, paddingHorizontal: 2, flexDirection: "row", alignItems: "center", gap: 8,
        backgroundColor: pressed ? colors.surface1 : "transparent" })}>
      <Icon name={open ? "ChevronDown" : "ChevronRight"} size={13} color={colors.foregroundMuted} />
      <Text style={{ color, fontSize: 11, fontWeight: "600", width: 28 }}>{title}</Text>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} ellipsizeMode="middle" style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>{filename}</Text>
        {directory ? <Text numberOfLines={1} ellipsizeMode="head" style={{ color: colors.foregroundMuted, fontSize: 11 }}>{directory}</Text> : null}
      </View>
      <View style={{ alignItems: "flex-end", gap: 2 }}>
        {item.status !== "completed" ? <Text style={{ fontSize: 11, color: item.status === "failed" ? colors.statusDanger : colors.statusWarning }}>{statusLabels[item.status]}</Text> : null}
        {time ? <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>{time}</Text> : null}
        {turn ? <Text style={{ color: colors.foregroundMuted, fontSize: 10 }}>轮 {turn.number}</Text> : null}
      </View>
    </Pressable>
    {open ? <View style={{ gap: 6, paddingBottom: 10 }}>
      <Text selectable style={{ color: colors.foregroundMuted, fontSize: 11 }}>{item.path}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: 11, flex: 1 }}>{item.tool}{item.timestamp ? " · " + (date && Number.isFinite(date.getTime()) ? date.toLocaleString() : item.timestamp) : ""}</Text>
        {turn ? <Action label={"查看第 " + turn.number + " 轮的活动"} text={"仅看第 " + turn.number + " 轮"} icon="CornerUpLeft" colors={colors} compact={compact} onPress={chooseTurn} /> : null}
      </View>
      {item.status !== "completed" ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>{statusLabels[item.status]}的请求，尚不能确认文件变更已完成。</Text> : null}
      {item.range ? <Text selectable style={{ color: colors.foregroundMuted, fontSize: 11 }}>{item.range}</Text> : null}
      {item.note ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{item.note}</Text> : null}
      {body !== undefined ? <Code key={item.id} text={body} diff={item.diff !== undefined} colors={colors} compact={compact} previewLines={previewLines} />
        : !item.note ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{item.kind === "read" ? "工具未提供查看正文。" : item.kind === "delete" ? "已记录删除，未提供删除前正文。" : "工具未提供正文或可用差异。"}</Text> : null}
    </View> : null}
  </View>;
}
export function ActivityView({ source, retry, defaults, ...props }: PluginAgentPanelProps & { source: TimelineStore; retry(): void; defaults: Preferences }) {
  const colors = props.theme.colors;
  const snapshot = useSyncExternalStore(source.subscribe, source.get, source.get);
  const projection = useMemo(() => projectActivity(snapshot.records), [snapshot.records]);
  const [view, setView] = useTabState(props.tab, viewSchema, {
    mode: defaults.defaultMode, turnId: "", sort: defaults.defaultSort, descending: defaults.descending,
    includeUnsuccessful: defaults.includeUnsuccessful, kinds: kinds.map((kind) => kind.value),
  });
  const [expanded, setExpanded] = useState<string | null>(null);
  const selectedTurn = view.mode === "all" ? null : view.mode === "latest" ? projection.turns.at(-1)?.id ?? ""
    : view.turnId || projection.turns.at(-1)?.id || "";
  useEffect(() => {
    if (view.mode === "manual" && !view.turnId && snapshot.status === "ready" && selectedTurn) setView({ ...view, turnId: selectedTurn });
  }, [view, snapshot.status, selectedTurn, setView]);
  const activities = useMemo(() => selectActivities(projection, selectedTurn, view.kinds, view.sort, view.descending, view.includeUnsuccessful),
    [projection, selectedTurn, view.kinds, view.sort, view.descending, view.includeUnsuccessful]);
  const choose = (turnId: string) => { setView({ ...view, mode: "manual", turnId }); setExpanded(null); };
  const selected = projection.turns.find((turn) => turn.id === selectedTurn);
  const index = projection.turns.findIndex((turn) => turn.id === selectedTurn);
  const flipKind = (kind: Kind) => setView({ ...view, kinds: view.kinds.includes(kind) ? view.kinds.filter((value) => value !== kind) : [...view.kinds, kind] });
  const appearance = { colors, compact: props.layout.compact };
  const counts = useMemo(() => {
    const values = { create: 0, delete: 0, edit: 0, read: 0 };
    for (const item of projection.activities) if ((selectedTurn === null || item.turnId === selectedTurn) && (view.includeUnsuccessful || item.status === "completed")) values[item.kind]++;
    return values;
  }, [projection, selectedTurn, view.includeUnsuccessful]);
  return <View style={{ flex: 1, minHeight: 0, backgroundColor: colors.surface0, paddingHorizontal: props.layout.compact ? 8 : 12 }}>
    <View testID="activity-toolbar" style={{ gap: 4, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Choices {...appearance} label="查看范围" value={view.mode} options={[{ label: "最新轮", value: "latest" }, { label: "手动选轮", value: "manual" }, { label: "全会话", value: "all" }]}
          onChange={(mode) => setView({ ...view, mode, turnId: selectedTurn ?? projection.turns.at(-1)?.id ?? "" })} />
        <View style={{ flex: 1 }} />
        <Action {...appearance} label="重新读取会话历史" text="" icon="RefreshCw" disabled={snapshot.status === "loading"} onPress={retry} />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: 6, rowGap: 2 }}>
        <View style={{ flexDirection: "row", gap: 2 }}>{kinds.map((kind) => <Action key={kind.value} {...appearance} label={kind.label} role="checkbox"
          selected={view.kinds.includes(kind.value)} count={counts[kind.value]} onPress={() => flipKind(kind.value)} />)}</View>
        <View style={{ flex: 1 }} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
          <Picker {...appearance} label="排序" value={view.sort} options={[{ label: "时间", value: "time" }, { label: "类别", value: "kind" }, { label: "路径", value: "path" }]}
            onChange={(sort) => setView({ ...view, sort })} />
          <Action {...appearance} label="降序" text="" icon={view.descending ? "ArrowDownWideNarrow" : "ArrowUpWideNarrow"} role="checkbox" selected={view.descending}
            onPress={() => setView({ ...view, descending: !view.descending })} />
          <Action {...appearance} label="显示未完成请求" text="未完成" role="checkbox" selected={view.includeUnsuccessful}
            onPress={() => setView({ ...view, includeUnsuccessful: !view.includeUnsuccessful })} />
        </View>
      </View>
      {view.mode === "manual" && projection.turns.length ? <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
        <View style={{ flex: 1, minWidth: 0 }}><Picker {...appearance} label="轮次" value={selectedTurn ?? ""}
          options={[...(!selected && selectedTurn ? [{ label: "所选轮次（未加载）", value: selectedTurn }] : []),
            ...projection.turns.map((turn) => ({ label: "第 " + turn.number + " 轮 · " + turn.title, value: turn.id }))]} onChange={choose} /></View>
        <Action {...appearance} label="上一轮" text="" icon="ChevronLeft" disabled={index <= 0} onPress={() => choose(projection.turns[index - 1]!.id)} />
        <Action {...appearance} label="下一轮" text="" icon="ChevronRight" disabled={index < 0 || index >= projection.turns.length - 1} onPress={() => choose(projection.turns[index + 1]!.id)} />
      </View> : null}
    </View>
    <FlatList data={activities} keyExtractor={(item) => item.id} extraData={expanded}
      ListHeaderComponent={<View style={{ gap: 6, paddingVertical: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: 11, flex: 1 }} numberOfLines={1}>
            {view.mode === "all" ? projection.turns.length + " 轮" : selected ? "第 " + selected.number + " 轮" + (view.mode === "latest" ? " · " + selected.title : "") : "文件活动"}
          </Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{activities.length} 项活动</Text>
        </View>
        {view.mode === "manual" && view.turnId && !selected && snapshot.status !== "loading"
          ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>所选轮次不在已加载历史中，请重新选择轮次或提高历史记录上限。</Text> : null}
        {snapshot.status === "loading" ? <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted, fontSize: 12 }}>正在读取文件活动…</Text> : null}
        {snapshot.warning ? <Text accessibilityLiveRegion="polite" style={{ color: snapshot.status === "error" ? colors.statusDanger : colors.statusWarning, fontSize: 12 }}>{snapshot.warning}</Text> : null}
      </View>}
      ListEmptyComponent={snapshot.status === "ready" ? <Text style={{ color: colors.foregroundMuted, fontSize: 12, paddingVertical: 16 }}>{view.kinds.length ? "当前范围没有可识别的文件活动。" : "请选择要显示的活动类别。"}</Text> : null}
      renderItem={({ item }) => <ActivityRow item={item} turn={projection.turns.find((turn) => turn.id === item.turnId)} {...appearance}
        compact={props.layout.compact} previewLines={defaults.previewLines} open={expanded === item.id} toggle={() => setExpanded((value) => value === item.id ? null : item.id)} chooseTurn={() => choose(item.turnId)} />}
    />
  </View>;
}
function ConnectedPanel(props: PluginAgentPanelProps & { defaults: Preferences; observe: Observe }) {
  const paseo = usePaseo();
  const [defaults] = useState(props.defaults);
  const source = useMemo(createTimelineStore, [paseo, props.params.agentId]);
  const [observer, setObserver] = useState<ReturnType<typeof observeTimeline> | null>(null);
  useEffect(() => {
    const value = props.observe(paseo.agents.ref(props.params.agentId), defaults.maxEntries, source);
    setObserver(value);
    return () => { void value?.stop(); };
  }, [paseo, props.params.agentId, defaults.maxEntries, source, props.observe]);
  return <ActivityView {...props} defaults={defaults} source={source} retry={() => observer?.retry()} />;
}
export function FileActivityPanel(props: PluginAgentPanelProps & { observe: Observe }) {
  const settings = useSettings(preferences);
  if (settings.status === "loading") return <Text style={{ color: props.theme.colors.foregroundMuted }}>正在读取文件活动配置…</Text>;
  return <View style={{ flex: 1, minHeight: 0 }}>
    {settings.status !== "ready" ? <SettingsAction label="配置读取失败，暂用默认值" actionLabel="重新读取配置" onPress={() => { void settings.reload(); }} /> : null}
    <ConnectedPanel key={props.host.id + ":" + props.params.agentId} {...props} defaults={settings.status === "ready" ? settings.values : preferencesSchema.parse({})} />
  </View>;
}
