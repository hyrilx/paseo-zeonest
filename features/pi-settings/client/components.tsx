import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Modal, SettingsAction, TextInput } from "@getpaseo/plugin/client/ui";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { Preview } from "../shared/contracts";

type Theme = PluginSurfaceProps["theme"];
export const controlHeight = 34;
export function Button({ label, onPress, disabled, theme, active = false, primary = false }: { label: string; onPress(): void; disabled?: boolean; theme: Theme; active?: boolean; primary?: boolean }) {
  const c = theme.colors;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, selected: active || undefined }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => ({ justifyContent: "center", minHeight: controlHeight, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 5, borderWidth: 1, borderColor: active || primary ? c.accent : c.border,
      backgroundColor: primary ? c.accent : active || pressed ? c.surface2 : c.surface1, opacity: disabled ? 0.5 : 1 })}>
    <Text style={{ color: primary ? c.accentForeground : active ? c.accent : c.foreground, fontSize: 13, fontWeight: "500" }}>{label}</Text>
  </Pressable>;
}
export function CodeInput({ text, onChangeText, theme, readOnly = false, label = "JSON / 文本配置" }: { text: string; onChangeText(text: string): void; theme: Theme; readOnly?: boolean; label?: string }) {
  return <TextInput accessibilityLabel={label} multiline value={text} onChangeText={onChangeText} editable={!readOnly} autoCapitalize="none" autoCorrect={false} spellCheck={false}
    textAlignVertical="top" style={{ color: theme.colors.foreground, backgroundColor: theme.colors.surface1, borderWidth: 1, borderColor: theme.colors.border,
      borderRadius: 5, padding: 10, fontFamily: "monospace", fontSize: 13, lineHeight: 19, minHeight: 200 }} />;
}
export function DiffModal({ preview, onCancel, onCommit, busy, theme, error }: { preview: Preview | null; onCancel(): void; onCommit(): void; busy: boolean; theme: Theme; error: string | null }) {
  const [reveal, setReveal] = useState(false);
  useEffect(() => { setReveal(false); }, [preview?.token]);
  const c = theme.colors;
  const hasChanges = preview && (preview.changes.length > 0 || preview.artifacts.length > 0);
  return <Modal open={preview !== null} title="确认配置改动" onOpenChange={(open) => { if (!open && !busy) { setReveal(false); onCancel(); } }}>
    <Modal.Content>
      <Text style={{ color: c.foreground, fontSize: 16, fontWeight: "600" }}>{preview?.title}</Text>
      <Text style={{ color: c.foregroundMuted, lineHeight: 20 }}>尚未写入。预览保留 20 分钟；应用前会再次校验版本。</Text>
      {preview?.warnings.map((warning) => <Text key={warning} style={{ color: c.statusWarning, lineHeight: 20 }}>{warning}</Text>)}
      {preview?.artifacts.map((artifact) => <View key={artifact.path} style={{ gap: 4 }}>
        <Text selectable style={{ color: c.foreground, fontWeight: "500" }}>{artifact.path}</Text>
        <Text style={{ color: c.foregroundMuted }}>安装目录：新增 {artifact.added} / 删除 {artifact.removed} / 修改 {artifact.changed} 项</Text>
      </View>)}
      {preview?.changes.length ? <SettingsAction label="文件差异" hint="完整 diff 可能包含密钥或私有内容。" actionLabel={reveal ? "隐藏 diff" : "展开完整 diff"} onPress={() => setReveal(!reveal)} /> : null}
      {preview?.changes.map((change) => <View key={change.path} style={{ gap: 8 }}>
        <Text selectable style={{ color: c.foreground, fontWeight: "600" }}>{change.path}</Text>
        <Text style={{ color: c.foregroundMuted }}>+{change.additions} / -{change.deletions}</Text>
        {reveal && <View style={{ padding: 10, borderRadius: 5, backgroundColor: c.surface1 }}>
          {change.diff.split("\n").map((line, index) => <Text key={index} selectable style={{ fontFamily: "monospace", fontSize: 12, lineHeight: 18,
            color: line.startsWith("+") && !line.startsWith("+++") ? c.statusSuccess : line.startsWith("-") && !line.startsWith("---") ? c.statusDanger : c.foregroundMuted }}>{line || " "}</Text>)}
        </View>}
      </View>)}
      {error && <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>{error}</Text>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button label="取消，不写入" onPress={() => { setReveal(false); onCancel(); }} disabled={busy} theme={theme} />
        <Button label={busy ? "正在应用…" : "确认应用"} onPress={onCommit} disabled={busy || !hasChanges} theme={theme} primary />
      </View>
    </Modal.Content>
  </Modal>;
}
