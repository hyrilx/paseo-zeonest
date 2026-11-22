import type { ReactNode } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import type { Command, Run } from "../shared/contracts";
import { formatArguments } from "../shared/arguments";

export type Colors = PluginWorkspacePanelProps["theme"]["colors"];
type Tone = "warning" | "danger" | "success";
export const labels: Record<Run["status"], string> = { queued: "排队中", running: "运行中", stopping: "正在停止", success: "成功", failed: "失败", stopped: "已停止", interrupted: "中断 · 进程状态未知" };
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const control = 32;
// Native reports pressed; RN Web additionally reports hover.
type PressState = { pressed: boolean; hovered?: boolean };
const toneColor = (colors: Colors, tone?: Tone) => tone === "warning" ? colors.statusWarning : tone === "danger" ? colors.statusDanger : tone === "success" ? colors.statusSuccess : colors.foregroundMuted;

export function Caption({ colors, children, tone }: { colors: Colors; children: ReactNode; tone?: Tone }) {
  return <Text selectable style={[styles.wrapText, { color: toneColor(colors, tone), lineHeight: 17, fontSize: 12 }]}>{children}</Text>;
}
export function Heading({ colors, children }: { colors: Colors; children: ReactNode }) {
  return <Text accessibilityRole="header" style={[styles.wrapText, styles.label, { color: colors.foreground, fontWeight: "700" }]}>{children}</Text>;
}
export function Badge({ colors, children, tone, top }: { colors: Colors; children: ReactNode; tone?: Tone; top?: boolean }) {
  return <Text style={[styles.badge, { color: toneColor(colors, tone), borderColor: colors.border }, top && { alignSelf: "flex-start" }]}>{children}</Text>;
}
export function Button({ colors, label, onPress, disabled, primary, icon, iconOnly, small }: {
  colors: Colors; label: string; onPress(): void; disabled?: boolean; primary?: boolean; icon?: string; iconOnly?: boolean; small?: boolean;
}) {
  const color = primary ? colors.accentForeground : iconOnly ? colors.foregroundMuted : colors.foreground;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed, hovered }: PressState) => [styles.button, (small || iconOnly) && styles.smallButton, iconOnly && styles.iconButton,
      { borderColor: primary || iconOnly ? "transparent" : colors.border, backgroundColor: primary ? colors.accent : (pressed || hovered || !iconOnly) ? colors.surface2 : "transparent",
        opacity: disabled ? 0.55 : pressed ? 0.78 : 1 }]}>
    {icon ? <Icon name={icon} size={14} color={color} /> : null}
    {!iconOnly ? <Text style={[styles.label, small && { fontSize: 12 }, { color, fontWeight: primary ? "700" : "400" }]}>{label}</Text> : null}
  </Pressable>;
}
export function Tabs({ children, label, fill }: { children: ReactNode; label: string; fill?: boolean }) {
  return <View accessibilityRole="tablist" accessibilityLabel={label} style={[styles.tabs, fill && styles.fill]}>{children}</View>;
}
export function Tab({ colors, label, active, count, icon, tight, fill, onPress }: {
  colors: Colors; label: string; active: boolean; count?: number; icon?: string; tight?: boolean; fill?: boolean; onPress(): void;
}) {
  const color = active ? colors.foreground : colors.foregroundMuted;
  return <Pressable accessibilityRole="tab" accessibilityState={{ selected: active }} aria-selected={active} onPress={onPress}
    style={({ pressed, hovered }: PressState) => [styles.tab, fill && styles.fill, tight && { paddingHorizontal: 4 }, { borderColor: active ? colors.accent : "transparent",
      backgroundColor: pressed || hovered ? colors.surface2 : "transparent" }]}>
    {icon ? <Icon name={icon} size={14} color={color} /> : null}
    <Text style={[styles.label, { color, fontWeight: active ? "700" : "400" }]}>{label}</Text>
    {count !== undefined ? <Badge colors={colors}>{count}</Badge> : null}
  </Pressable>;
}
export function Choice({ colors, children, active, onPress, disabled, card, label }: {
  colors: Colors; children: ReactNode; active?: boolean; onPress(): void; disabled?: boolean; card?: boolean; label?: string;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: active, disabled }} aria-pressed={active} onPress={onPress} disabled={disabled}
    style={({ pressed, hovered }: PressState) => [styles.choice, { borderColor: active ? colors.accent : card ? colors.border : "transparent",
      backgroundColor: pressed || hovered ? colors.surface2 : card ? colors.surface0 : "transparent" }]}>
    {active ? <View pointerEvents="none" style={[styles.tint, { backgroundColor: colors.accent }]} /> : null}
    {children}
  </Pressable>;
}
export function Field({ colors, label, value, set, placeholder, multiline, error, hint, action, hideLabel, sideLabel, mono, icon, maxLength = 2048 }: {
  colors: Colors; label: string; value: string; set(value: string): void; placeholder?: string; multiline?: boolean; error?: string; hint?: string;
  action?: ReactNode; hideLabel?: boolean; sideLabel?: boolean; mono?: boolean; icon?: string; maxLength?: number;
}) {
  return <View style={sideLabel ? styles.sideField : styles.field}>
    {!hideLabel ? <Text style={[styles.label, sideLabel && styles.sideLabel, { color: colors.foregroundMuted }]}>{label}</Text> : null}
    <View style={styles.fieldBody}>
      <View style={styles.inline}>
        <View style={[styles.inputBox, { backgroundColor: colors.surface0, borderColor: error ? colors.statusDanger : colors.border }]}>
          {icon ? <Icon name={icon} size={14} color={colors.foregroundMuted} /> : null}
          <TextInput accessibilityLabel={label} onChangeText={set} value={value} placeholder={placeholder} placeholderTextColor={colors.foregroundMuted}
            autoCapitalize="none" autoCorrect={false} multiline={multiline} maxLength={maxLength}
            style={[styles.input, mono && styles.mono, multiline ? styles.multiline : styles.singleLine, { color: colors.foreground }]} />
        </View>
        {action}
      </View>
      {error || hint ? <Caption colors={colors} tone={error ? "danger" : undefined}>{error ?? hint}</Caption> : null}
    </View>
  </View>;
}
export function PaneHead({ colors, children, bar }: { colors: Colors; children: ReactNode; bar?: boolean }) {
  return <View style={[styles.head, { borderColor: colors.border, backgroundColor: bar ? colors.surface2 : colors.surface1 }]}>{children}</View>;
}
export function Region({ children, label, content }: { children: ReactNode; label: string; content?: StyleProp<ViewStyle> }) {
  return <ScrollView accessibilityLabel={label} style={styles.region} contentContainerStyle={[styles.content, content]} keyboardShouldPersistTaps="handled" nestedScrollEnabled>{children}</ScrollView>;
}
export function Notice({ colors, title, children, tone, action }: { colors: Colors; title: string; children?: ReactNode; tone?: Tone; action?: ReactNode }) {
  return <View style={[styles.notice, { borderColor: colors.border, borderLeftColor: tone ? toneColor(colors, tone) : colors.accent, backgroundColor: colors.surface1 }]}>
    {tone ? <View pointerEvents="none" style={[styles.tint, { backgroundColor: toneColor(colors, tone) }]} /> : null}
    <Icon name={tone === "success" ? "Check" : tone ? "TriangleAlert" : "Info"} size={14} color={tone ? toneColor(colors, tone) : colors.accent} />
    <View style={styles.fieldBody}><Text style={[styles.label, { fontWeight: "700", color: tone ? toneColor(colors, tone) : colors.foreground }]}>{title}</Text>
      {children ? <Caption colors={colors}>{children}</Caption> : null}</View>
    {action}
  </View>;
}
export function CommandPreview({ plan, colors, heading }: { plan: Command; colors: Colors; heading?: string }) {
  return <View style={[styles.preview, { borderColor: colors.border, backgroundColor: colors.surface1 }]}>
    <View style={[styles.previewHead, { borderColor: colors.border }]}>
      <View style={styles.inline}><Icon name="SquareTerminal" size={14} color={colors.foreground} /><Heading colors={colors}>{heading ?? "命令预览"}</Heading></View>
      <Caption colors={colors}>{plan.cwd ? `工作目录 ${plan.cwd}` : null}</Caption>
    </View>
    <View style={styles.previewBody}>
      {plan.preparation?.map((step, i) => <View key={i} style={styles.field}>
        <Caption colors={colors}>先准备依赖 · 目录：{step.cwd}</Caption>
        <Code colors={colors}>{formatArguments(step.argv)}</Code>
      </View>)}
      {plan.preparation?.length ? <Caption colors={colors}>准备成功后执行</Caption> : null}
      <Code colors={colors} accent>{formatArguments(plan.argv)}</Code>
      <Caption colors={colors}>来源：{plan.source} · {plan.tool.version ?? "版本未检查"}</Caption>
      <Code colors={colors} muted>{plan.tool.paths.join("\n")}</Code>
      {plan.notes?.map((note, i) => <Caption key={i} colors={colors}>{note}</Caption>)}
    </View>
  </View>;
}
export function Code({ colors, children, muted, accent }: { colors: Colors; children: ReactNode; muted?: boolean; accent?: boolean }) {
  return <Text selectable style={[styles.wrapText, styles.mono, { color: accent ? colors.accent : muted ? colors.foregroundMuted : colors.foreground, lineHeight: 18 }]}>{children}</Text>;
}
// Preserve the exact string for copying, even when a path/task has no natural break point.
const webWrap = { overflowWrap: "anywhere" };
export const styles = StyleSheet.create({
  wrapText: { minWidth: 0, ...(Platform.OS === "web" ? webWrap : {}) },
  label: { fontSize: 13, lineHeight: 17, includeFontPadding: false },
  mono: { fontFamily: "monospace", fontSize: 12 },
  badge: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 5, fontSize: 11, lineHeight: 16, includeFontPadding: false, alignSelf: "center", flexShrink: 0 },
  field: { gap: 4, minWidth: 0 },
  sideField: { flexDirection: "row", gap: 6, alignItems: "flex-start", minWidth: 0 },
  sideLabel: { width: 67, paddingTop: 7 },
  fieldBody: { flex: 1, minWidth: 0, gap: 3 },
  inline: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
  actions: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, minWidth: 0 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 6, paddingHorizontal: 10, minHeight: 37, flexShrink: 0, borderBottomWidth: 1 },
  tabs: { alignSelf: "stretch", flexDirection: "row", gap: 2, minWidth: 0 },
  fill: { flex: 1 },
  tab: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, paddingHorizontal: 8, borderBottomWidth: 2, paddingTop: 2 },
  region: { flex: 1, minHeight: 0, minWidth: 0 },
  content: { padding: 8, gap: 6 },
  pane: { minHeight: 0, minWidth: 0, flex: 1 },
  frame: { borderRightWidth: 1 },
  tile: { borderRadius: 5, borderWidth: 1, padding: 8, gap: 4, minWidth: 0 },
  choice: { borderRadius: 5, borderWidth: 1, padding: 6, gap: 6, minWidth: 0, flexDirection: "row", alignItems: "flex-start", overflow: "hidden" },
  tint: { ...StyleSheet.absoluteFillObject, opacity: 0.12 },
  preview: { borderRadius: 5, borderWidth: 1 },
  previewHead: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 5, borderBottomWidth: 1 },
  previewBody: { padding: 8, gap: 4 },
  notice: { flexDirection: "row", alignItems: "center", gap: 7, borderWidth: 1, borderLeftWidth: 3, borderRadius: 5, padding: 7, overflow: "hidden" },
  inputBox: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", borderRadius: 5, borderWidth: 1, paddingHorizontal: 8, gap: 6 },
  input: { flex: 1, minWidth: 0, padding: 0, fontSize: 13, lineHeight: 18, includeFontPadding: false },
  singleLine: { height: control - 2, paddingVertical: 5 },
  multiline: { minHeight: 52, paddingVertical: 4, textAlignVertical: "top" },
  button: { borderRadius: 5, borderWidth: 1, height: control, paddingHorizontal: 8, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, flexShrink: 0 },
  smallButton: { height: 26, paddingHorizontal: 6 },
  iconButton: { width: 28, paddingHorizontal: 0 },
});
