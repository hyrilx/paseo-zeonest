import { useState } from "react";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView, SettingsCard } from "@getpaseo/plugin/client/ui";
import { Pressable, Text, View } from "react-native";

export function ConfigWarnings({ warnings, theme, layout }: Pick<PluginSurfaceProps, "theme" | "layout"> & { warnings: readonly string[] }) {
  const [expanded, setExpanded] = useState(false);
  if (warnings.length === 0) return null;
  const c = theme.colors;
  const textStyle = { color: c.statusWarning, fontSize: 13, lineHeight: 20 };
  return <SettingsCard>
    <Pressable accessibilityRole="button" accessibilityLabel={`${expanded ? "收起" : "展开"}配置警告，共 ${warnings.length} 条`}
      accessibilityState={{ expanded }} onPress={() => setExpanded((value) => !value)}
      style={({ pressed }) => ({ minHeight: 44, padding: 12, flexDirection: "row", flexWrap: "wrap", alignItems: "center",
        justifyContent: "space-between", gap: 8, backgroundColor: pressed ? c.surface2 : c.surface1 })}>
      <Text style={{ ...textStyle, fontWeight: "600" }}>配置警告（{warnings.length}）</Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>{expanded ? "收起" : "展开全部"}</Text>
    </Pressable>
    <View style={{ paddingHorizontal: 12, paddingBottom: 12 }}>
      {expanded
        ? <ScrollView accessibilityLabel="配置警告列表" nestedScrollEnabled showsVerticalScrollIndicator
            style={{ maxHeight: layout.compact ? 180 : 240, flexGrow: 0 }} contentContainerStyle={{ gap: 8 }}>
            {warnings.map((warning, index) => <Text key={index} selectable style={textStyle}>{warning}</Text>)}
          </ScrollView>
        : <Text selectable numberOfLines={2} ellipsizeMode="tail" style={textStyle}>{warnings[0]}</Text>}
    </View>
  </SettingsCard>;
}
