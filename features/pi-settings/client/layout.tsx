import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Button, controlHeight } from "./components";

export type Theme = PluginSurfaceProps["theme"];
export const row = { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 } as const;
export const fieldRow = { ...row, alignItems: "flex-end" } as const;
export function Caption({ theme, children, selectable }: { theme: Theme; children: ReactNode; selectable?: boolean }) {
  return <Text selectable={selectable} style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{children}</Text>;
}
export function Heading({ title, detail, action, theme }: { title: string; detail?: string; action?: ReactNode; theme: Theme }) {
  return <View style={{ ...row, justifyContent: "space-between", alignItems: "flex-start" }}>
    <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 100, gap: 3 }}>
      <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: 18, fontWeight: "600" }}>{title}</Text>
      {detail ? <Caption theme={theme} selectable>{detail}</Caption> : null}
    </View>{action}
  </View>;
}
export function ListRow({ theme, label, detail, badge, active, disabled, onPress }: { theme: Theme; label: string; detail?: string; badge?: string; active?: boolean; disabled?: boolean; onPress(): void }) {
  const c = theme.colors;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: active, disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => ({ flexDirection: "row", gap: 8, alignItems: "center", minHeight: 32, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 5, backgroundColor: active || pressed ? c.surface2 : "transparent", opacity: disabled ? 0.6 : 1 })}>
    <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
      <Text numberOfLines={1} style={{ color: active ? c.accent : c.foreground, fontWeight: active ? "600" : "500", fontSize: 13 }}>{label}</Text>
      {detail ? <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 11 }}>{detail}</Text> : null}
    </View>
    {badge ? <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 11, maxWidth: 80 }}>{badge}</Text> : null}
  </Pressable>;
}
export function Field({ label, value, onChangeText, theme, disabled, placeholder, secret, onSubmit, search, action }: { label: string; value: string; onChangeText(value: string): void; theme: Theme; disabled?: boolean; placeholder?: string; secret?: boolean; onSubmit?(): void; search?: boolean; action?: ReactNode }) {
  const c = theme.colors;
  const input = <TextInput accessibilityLabel={label} value={value} onChangeText={onChangeText} onSubmitEditing={onSubmit} editable={!disabled} secureTextEntry={secret} placeholder={placeholder}
    placeholderTextColor={c.foregroundMuted} autoCapitalize="none" autoCorrect={false} spellCheck={false}
    style={{ color: c.foreground, backgroundColor: c.surface1, minHeight: controlHeight, borderWidth: 1, borderColor: c.border, borderRadius: 5, paddingHorizontal: 8, paddingVertical: 4, fontSize: 13 }} />;
  return <View style={{ gap: 3, minWidth: 0 }}>
    {!search && <Text style={{ color: c.foregroundMuted, fontSize: 12, fontWeight: "500" }}>{label}</Text>}
    {action ? <View style={fieldRow}><View style={{ flex: 1, minWidth: 95 }}>{input}</View>{action}</View> : input}
  </View>;
}
export function Pane({ theme, compact, inDetail, onBack, list, tools, detail, revision }: { theme: Theme; compact: boolean; inDetail: boolean; onBack(): void; list: ReactNode; tools?: ReactNode; detail: ReactNode; revision?: string }) {
  const c = theme.colors;
  const showList = !compact || !inDetail;
  return <View style={{ flex: 1, flexDirection: "row", minHeight: 0 }}>
    {showList && <View style={{ ...(compact ? { flex: 1 } : { width: 232, borderRightWidth: 1, borderRightColor: c.border }), minHeight: 0, backgroundColor: c.surface1 }}>
      {tools && <View style={{ padding: 8, gap: 5, borderBottomWidth: 1, borderBottomColor: c.border }}>{tools}</View>}
      <ScrollView keyboardShouldPersistTaps="handled" style={{ flex: 1 }} contentContainerStyle={{ padding: 6, gap: 1 }}>{list}</ScrollView>
    </View>}
    {(!compact || inDetail) && <ScrollView key={revision} keyboardShouldPersistTaps="handled" style={{ flex: 1, minWidth: 0 }} contentContainerStyle={{ paddingHorizontal: compact ? 10 : 16, paddingVertical: 9, gap: 8 }}>
      {compact && <View style={{ alignSelf: "flex-start" }}><Button label="返回列表" theme={theme} onPress={onBack} /></View>}
      {detail}
    </ScrollView>}
  </View>;
}
export function matches(search: string, ...values: (string | undefined)[]) {
  const query = search.trim().toLowerCase();
  return values.some((value) => value?.toLowerCase().includes(query));
}
