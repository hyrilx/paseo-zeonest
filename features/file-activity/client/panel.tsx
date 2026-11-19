import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { usePaseo, useSettings, useTabState, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { FlatList, ScrollView, SettingsAction, SettingsCard, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { z } from "zod";
import { preferences, preferencesSchema, type Preferences } from "../shared/settings";
import { kinds, projectActivity, selectActivities } from "./activity";
import { createTimelineStore, observeTimeline, type TimelineStore } from "./timeline";
import type { Activity, Agent, Kind, Turn } from "./types";

export const viewSchema = z.object({
  mode: z.enum(["latest", "manual", "all"]),
  turnId: z.string(),
  sort: z.enum(["time", "kind", "path"]),
  descending: z.boolean(),
  includeUnsuccessful: z.boolean(),
  kinds: z.array(z.enum(["create", "delete", "edit", "read"])).max(4),
});
export type Observe = (agent: Agent, limit: number, source: TimelineStore) => ReturnType<typeof observeTimeline> | null;
type Colors = PluginAgentPanelProps["theme"]["colors"];
const statusLabels = { completed: "已完成", running: "进行中", failed: "失败", canceled: "已取消" };
function Button({ label, selected, colors, onPress }: { label: string; selected?: boolean; colors: Colors; onPress(): void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: !!selected }}
    onPress={onPress} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 12, borderWidth: 1, borderRadius: 6,
      borderColor: selected ? colors.accent : colors.border, backgroundColor: selected ? colors.surface2 : colors.surface0 }}>
    <Text style={{ color: selected ? colors.accent : colors.foreground }}>{label}</Text>
  </Pressable>;
}
function Code({ text, diff, colors, previewLines }: { text: string; diff: boolean; colors: Colors; previewLines: number }) {
  const [count, setCount] = useState(previewLines);
  const lines = useMemo(() => text.split("\n"), [text]);
  return <View style={{ gap: 8 }}>
    <ScrollView horizontal style={{ maxHeight: 400, backgroundColor: colors.surface0 }} accessibilityLabel={diff ? "差异内容" : "文件正文"}>
      <ScrollView nestedScrollEnabled style={{ maxHeight: 400 }}><Text selectable style={{ fontFamily: "monospace", fontSize: 12, lineHeight: 19, color: colors.foreground }}>
        {lines.slice(0, count).map((line, index) => <Text key={index} style={{ color: diff && line.startsWith("+") ? colors.statusSuccess : diff && line.startsWith("-") ? colors.statusDanger : colors.foreground }}>
          {diff ? "" : String(index + 1).padStart(4) + "  "}{line}{index < Math.min(count, lines.length) - 1 ? "\n" : ""}
        </Text>)}
      </Text></ScrollView>
    </ScrollView>
    {count < lines.length ? <Button label={"继续显示（" + Math.min(count, lines.length) + " / " + lines.length + " 行）"} colors={colors} onPress={() => setCount((value) => value + previewLines)} /> : null}
  </View>;
}
function ActivityRow({ item, turn, colors, previewLines, open, toggle, chooseTurn }: {
  item: Activity; turn?: Turn; colors: Colors; previewLines: number; open: boolean; toggle(): void; chooseTurn(): void;
}) {
  const title = kinds.find((kind) => kind.value === item.kind)!.label;
  const body = item.diff ?? item.content;
  return <View style={{ borderBottomWidth: 1, borderColor: colors.border, paddingVertical: 10, gap: 8 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={title + " " + item.path} accessibilityState={{ expanded: open }} onPress={toggle}
      style={{ minHeight: 44, gap: 4, justifyContent: "center" }}>
      <Text style={{ color: colors.foreground, fontWeight: "600" }}>{open ? "▾" : "▸"} {title} · {item.path}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{turn ? "第 " + turn.number + " 轮 · " : ""}{statusLabels[item.status]} · {item.timestamp || "时间未记录"}</Text>
    </Pressable>
    {open ? <View style={{ gap: 8 }}>
      <Text selectable style={{ color: colors.foregroundMuted }}>{item.tool} · {item.callId}</Text>
      {item.status !== "completed" ? <Text style={{ color: colors.statusWarning }}>这是{statusLabels[item.status]}的工具请求；内容不能作为已完成文件变更的证明。</Text> : null}
      {item.range ? <Text selectable style={{ color: colors.foreground }}>{item.range}</Text> : null}
      {item.note ? <Text style={{ color: colors.foregroundMuted }}>{item.note}</Text> : null}
      {body !== undefined ? <Code key={item.id} text={body} diff={item.diff !== undefined} colors={colors} previewLines={previewLines} />
        : <Text style={{ color: colors.foregroundMuted }}>{item.kind === "read" ? "工具未提供查看正文。" : item.kind === "delete" ? "已记录删除操作，未提供删除前正文。" : "工具未提供正文或可用差异。"}</Text>}
      <Button label={"查看第 " + (turn?.number ?? "?") + " 轮的活动"} colors={colors} onPress={chooseTurn} />
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
  return <View style={{ flex: 1, minHeight: 0, backgroundColor: colors.surface0, padding: props.layout.compact ? 8 : 12, gap: 8 }}>
    <FlatList data={activities} keyExtractor={(item) => item.id} extraData={expanded}
      ListHeaderComponent={<View style={{ gap: 8, paddingBottom: 12 }}>
        <SettingsCard>
          <SettingsSelect label="查看范围" value={view.mode} options={[{ label: "跟随最新轮", value: "latest" }, { label: "手动选轮", value: "manual" }, { label: "全会话", value: "all" }]}
            onValueChange={(mode) => setView({ ...view, mode, turnId: selectedTurn ?? projection.turns.at(-1)?.id ?? "" })} />
          {view.mode === "manual" && projection.turns.length ? <SettingsSelect label="轮次" value={selectedTurn ?? ""}
            options={[...(!selected && selectedTurn ? [{ label: "所选轮次（未加载）", value: selectedTurn }] : []),
              ...projection.turns.map((turn) => ({ label: "第 " + turn.number + " 轮 · " + turn.title, value: turn.id }))]} onValueChange={choose} /> : null}
          <SettingsSelect label="排序" value={view.sort} options={[{ label: "时间", value: "time" }, { label: "类别", value: "kind" }, { label: "路径", value: "path" }]}
            onValueChange={(sort) => setView({ ...view, sort })} />
          <SettingsSwitch label="降序" value={view.descending} onValueChange={(descending) => setView({ ...view, descending })} />
          <SettingsSwitch label="显示进行中、失败及取消的请求" value={view.includeUnsuccessful} onValueChange={(includeUnsuccessful) => setView({ ...view, includeUnsuccessful })} />
        </SettingsCard>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{kinds.map((kind) => <Button key={kind.value} label={kind.label} selected={view.kinds.includes(kind.value)} colors={colors} onPress={() => flipKind(kind.value)} />)}</View>
        {selected ? <Text style={{ color: colors.foreground }} numberOfLines={3}>第 {selected.number} 轮 · {selected.title}</Text> : null}
        {view.mode === "manual" && view.turnId && !selected && snapshot.status !== "loading"
          ? <Text style={{ color: colors.statusWarning }}>所选轮次不在已加载历史中，请重新选择轮次或提高历史记录上限。</Text> : null}
        {view.mode === "manual" ? <View style={{ flexDirection: "row", gap: 8 }}>
          {index > 0 ? <Button label="上一轮" colors={colors} onPress={() => choose(projection.turns[index - 1]!.id)} /> : null}
          {index >= 0 && index < projection.turns.length - 1 ? <Button label="下一轮" colors={colors} onPress={() => choose(projection.turns[index + 1]!.id)} /> : null}
        </View> : null}
        <Text style={{ color: colors.foregroundMuted }}>{activities.length} 项活动 · {projection.turns.length} 个已加载轮次</Text>
        {snapshot.status === "loading" ? <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted }}>正在读取文件活动…</Text> : null}
        {snapshot.warning ? <Text accessibilityLiveRegion="polite" style={{ color: snapshot.status === "error" ? colors.statusDanger : colors.statusWarning }}>{snapshot.warning}</Text> : null}
        <SettingsAction label="重新读取会话历史" actionLabel="重新读取" disabled={snapshot.status === "loading"} onPress={retry} />
      </View>}
      ListEmptyComponent={snapshot.status === "ready" ? <Text style={{ color: colors.foregroundMuted }}>{view.kinds.length ? "当前范围没有可识别的文件活动。" : "请选择要显示的活动类别。"}</Text> : null}
      renderItem={({ item }) => <ActivityRow item={item} turn={projection.turns.find((turn) => turn.id === item.turnId)} colors={colors}
        previewLines={defaults.previewLines} open={expanded === item.id} toggle={() => setExpanded((value) => value === item.id ? null : item.id)} chooseTurn={() => choose(item.turnId)} />}
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
