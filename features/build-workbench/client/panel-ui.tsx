import type { ReactNode } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import type { Command, Run } from "../shared/contracts";
import { formatArguments } from "../shared/arguments";

export type Colors = PluginWorkspacePanelProps["theme"]["colors"];
export const labels: Record<Run["status"], string> = { queued: "排队中", running: "运行中", stopping: "正在停止", success: "成功", failed: "失败", stopped: "已停止", interrupted: "中断 · 进程状态未知" };
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const control = 36;

export function Caption({ colors, children, tone }: { colors: Colors; children: ReactNode; tone?: "warning" | "danger" | "success" }) {
  return <Text selectable style={[styles.wrapText, { color: tone === "warning" ? colors.statusWarning : tone === "danger" ? colors.statusDanger : tone === "success" ? colors.statusSuccess : colors.foregroundMuted, lineHeight: 18, fontSize: 12 }]}>{children}</Text>;
}
export function Heading({ colors, children }: { colors: Colors; children: ReactNode }) {
  return <Text accessibilityRole="header" style={[styles.wrapText, { color: colors.foreground, fontSize: 14, fontWeight: "700" }]}>{children}</Text>;
}
export function Button({ colors, label, onPress, disabled, primary, active }: { colors: Colors; label: string; onPress(): void; disabled?: boolean; primary?: boolean; active?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled, selected: active }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.button, { borderColor: primary || active ? colors.accent : colors.border, backgroundColor: primary ? colors.accent : colors.surface1,
      opacity: disabled ? 0.5 : pressed ? 0.75 : 1 }]}>
    <Text style={{ color: primary ? colors.accentForeground : active ? colors.accent : colors.foreground, fontSize: 13, fontWeight: primary || active ? "600" : "400" }}>{label}</Text>
  </Pressable>;
}
export function Choice({ colors, children, active, onPress, disabled }: { colors: Colors; children: ReactNode; active?: boolean; onPress(): void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ selected: active, disabled }} onPress={onPress} disabled={disabled}
    style={({ pressed }) => [styles.tile, { borderColor: active ? colors.accent : colors.border, backgroundColor: active ? colors.surface2 : colors.surface1, opacity: pressed ? 0.75 : 1 }]}>{children}</Pressable>;
}
export function Field({ colors, label, value, set, placeholder, multiline, error, action, hideLabel, maxLength = 2048 }: {
  colors: Colors; label: string; value: string; set(value: string): void; placeholder?: string; multiline?: boolean; error?: string; action?: ReactNode; hideLabel?: boolean; maxLength?: number;
}) {
  return <View style={styles.field}>
    {!hideLabel ? <Text style={{ color: colors.foreground, fontSize: 13 }}>{label}</Text> : null}
    <View style={styles.inline}>
      <TextInput accessibilityLabel={label} onChangeText={set} value={value} placeholder={placeholder} placeholderTextColor={colors.foregroundMuted}
        autoCapitalize="none" autoCorrect={false} multiline={multiline} maxLength={maxLength}
        style={[styles.input, { minHeight: multiline ? 58 : control, backgroundColor: colors.surface0, borderColor: error ? colors.statusDanger : colors.border, color: colors.foreground }]} />
      {action}
    </View>
    {error ? <Caption colors={colors} tone="danger">{error}</Caption> : null}
  </View>;
}
export function PaneHead({ colors, children }: { colors: Colors; children: ReactNode }) {
  return <View style={[styles.head, { borderColor: colors.border, backgroundColor: colors.surface1 }]}>{children}</View>;
}
export function Region({ children, label }: { children: ReactNode; label: string }) {
  return <ScrollView accessibilityLabel={label} style={styles.region} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" nestedScrollEnabled>{children}</ScrollView>;
}
export function CommandPreview({ plan, colors }: { plan: Command; colors: Colors }) {
  return <View style={[styles.tile, { borderColor: colors.border, backgroundColor: colors.surface1 }]}>
    {plan.preparation?.map((step, i) => <View key={i} style={styles.field}>
      <Caption colors={colors}>先准备依赖 · 目录：{step.cwd}</Caption>
      <Code colors={colors}>{formatArguments(step.argv)}</Code>
    </View>)}
    {plan.preparation?.length ? <Caption colors={colors}>准备成功后执行</Caption> : null}
    <Code colors={colors}>{formatArguments(plan.argv)}</Code>
    <Caption colors={colors}>目录：{plan.cwd} · 来源：{plan.source}{"\n"}{plan.tool.version ?? "版本未检查"}</Caption>
    <Code colors={colors}>{plan.tool.paths.join("\n")}</Code>
    {plan.notes?.map((note, i) => <Caption key={i} colors={colors}>{note}</Caption>)}
  </View>;
}
export function Code({ colors, children }: { colors: Colors; children: ReactNode }) {
  return <Text selectable style={[styles.wrapText, { color: colors.foreground, fontFamily: "monospace", fontSize: 12, lineHeight: 18 }]}>{children}</Text>;
}
// Preserve the exact string for copying, even when a path/task has no natural break point.
const webWrap = { overflowWrap: "anywhere" };
export const styles = StyleSheet.create({
  wrapText: { minWidth: 0, ...(Platform.OS === "web" ? webWrap : {}) },
  field: { gap: 5, minWidth: 0 },
  inline: { flexDirection: "row", gap: 6, alignItems: "center", minWidth: 0 },
  actions: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, minWidth: 0 },
  head: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, paddingHorizontal: 8, paddingVertical: 5, minHeight: 37, borderBottomWidth: 1 },
  region: { flex: 1, minHeight: 0, minWidth: 0 },
  content: { padding: 8, gap: 8 },
  pane: { minHeight: 0, minWidth: 0, flex: 1 },
  frame: { borderRightWidth: 1 },
  tile: { borderRadius: 5, borderWidth: 1, padding: 8, gap: 3, minWidth: 0 },
  input: { flex: 1, minWidth: 0, borderRadius: 5, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 6, fontSize: 13 },
  button: { borderRadius: 5, borderWidth: 1, minHeight: control, paddingHorizontal: 8, justifyContent: "center" },
});
