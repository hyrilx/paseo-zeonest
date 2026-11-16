import { useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { metricOptions } from "../shared/settings";
import type { PreferencesStore } from "./preferences";
import { seconds, speed, type StatsStore } from "./store";

export function SessionStatsDetails({ source, configuration, retry, reloadPreferences, theme, layout }: PluginButtonContentProps & {
  source: StatsStore; configuration: PreferencesStore; retry(): void; reloadPreferences(): void;
}) {
  const stats = useSyncExternalStore(source.subscribe, source.get, source.get);
  const { values, error } = useSyncExternalStore(configuration.subscribe, configuration.get, configuration.get);
  const colors = theme.colors;
  const counts = stats.status === "loading" ? "加载中…" : `${stats.rounds} 轮 ${stats.steps} 步${stats.partial ? "（部分）" : ""}`;
  const rows = metricOptions.flatMap(({ id, label }) => {
    if (!values.visibleMetrics.includes(id)) return [];
    const value = id === "tools" && stats.status === "loading" ? null : stats[id];
    if (value === null && values.missingValues === "hide") return [];
    const formatted = value === null ? "未采集" : id === "tools" ? `${value} 次${stats.partial ? "（部分）" : ""}` : id === "averageTps" ? speed(value) : seconds(value);
    return [{ label, formatted, missing: value === null }];
  });
  const text = { color: colors.foreground, fontSize: 14, lineHeight: 20 };
  return <View style={{ width: layout.compact ? undefined : 300, maxWidth: "100%", gap: 10 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
        <Icon icon="Gauge" size={17} color={colors.foreground} />
        <Text accessibilityRole="header" style={{ ...text, fontWeight: "600" }}>会话统计</Text>
      </View>
      {values.showCounts ? <Text selectable style={{ ...text, fontVariant: ["tabular-nums"] }}>{counts}</Text> : null}
    </View>
    <View style={{ gap: 8 }}>
      {rows.map(({ label, formatted, missing }) => <View key={label} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <Text style={{ ...text, color: colors.foregroundMuted, flexShrink: 1 }}>{label}</Text>
        <Text selectable style={{ ...text, color: missing ? colors.foregroundMuted : colors.foreground, fontVariant: ["tabular-nums"] }}>{formatted}</Text>
      </View>)}
      {!rows.length && stats.status !== "error" ? <Text style={{ ...text, color: colors.foregroundMuted }}>{stats.status === "loading" ? "正在读取统计…" : values.visibleMetrics.length ? "等待采集" : "未选择统计指标"}</Text> : null}
    </View>
    {stats.status === "error" ? <Pressable accessibilityRole="button" accessibilityLabel="重新读取会话统计" onPress={retry}
      style={{ minHeight: 44, justifyContent: "center" }}><Text style={{ ...text, color: colors.accent }}>读取失败，点此重试</Text></Pressable> : null}
    {error ? <Pressable accessibilityRole="button" accessibilityLabel="重新读取统计配置" onPress={reloadPreferences}
      style={{ minHeight: 44, justifyContent: "center" }}><Text style={{ ...text, color: colors.accent }}>配置读取失败，点此重试</Text></Pressable> : null}
  </View>;
}
