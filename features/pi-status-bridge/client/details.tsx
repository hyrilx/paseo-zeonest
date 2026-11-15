import { useRef, useState, useSyncExternalStore } from "react";
import { Text, View, Pressable } from "react-native";
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { ScrollView, copyText } from "@getpaseo/plugin/client/ui";
import type { DisplayEntry, StatusStore } from "./store";
import { errorMessage } from "../shared/text";

type Props = PluginButtonContentProps & {
  source: StatusStore; entryId: string;
  expand(entry: DisplayEntry): Promise<{ message: string }>;
};
export function StatusDetails({ source, entryId, expand, theme, layout }: Props) {
  const entries = useSyncExternalStore(source.subscribe, source.get, source.get);
  const entry = entries.find((value) => value.id === entryId);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const lock = useRef(false);
  const colors = theme.colors;
  async function run(action: () => Promise<string>) {
    if (lock.current) return;
    lock.current = true; setPending(true); setError(""); setMessage("");
    try { setMessage(await action()); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { lock.current = false; setPending(false); }
  }
  const button = { minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 8, justifyContent: "center" as const };
  return <View style={{ width: layout.compact ? undefined : 420, maxWidth: "100%", gap: 12, padding: 16, backgroundColor: colors.surface0 }}>
    <Text style={{ color: colors.foreground, fontSize: 17, fontWeight: "600" }}>{entry?.key ?? "Pi 状态"}</Text>
    {!entry ? <Text style={{ color: colors.foregroundMuted }}>此状态已移除或通道已断开，请关闭后重新查看。</Text> : <>
      <ScrollView style={{ maxHeight: layout.compact ? 360 : 480 }}>
        <Text selectable style={{ color: entry.warning ? colors.statusWarning : colors.foreground, fontSize: 14, lineHeight: 22 }}>{entry.text}</Text>
      </ScrollView>
      {entry.command && <Text selectable style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 20 }}>
        展开将发送 {entry.command}。请仅映射可信插件命令，不要填写提示词模板或技能。插件可能修改会话或调用模型；普通对话框在聊天中显示，终端自定义界面无法桥接。
      </Text>}
      {!entry.command && !entry.warning && <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>尚未配置此状态的展开命令，可在 Pi 状态桥接设置中添加。</Text>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="复制完整内容" disabled={pending} style={button}
          onPress={() => { void run(async () => { await copyText(entry.text); return "已复制完整内容"; }); }}>
          <Text style={{ color: colors.foreground }}>复制完整内容</Text>
        </Pressable>
        {entry.command && <Pressable accessibilityRole="button" accessibilityLabel="执行 Pi 展开命令" disabled={pending} style={button}
          onPress={() => { void run(async () => (await expand(entry)).message); }}>
          <Text style={{ color: colors.accent }}>{pending ? "正在处理…" : "执行 Pi 展开命令"}</Text>
        </Pressable>}
      </View>
    </>}
    {message ? <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted, lineHeight: 20 }}>{message}</Text> : null}
    {error ? <Text accessibilityLiveRegion="polite" style={{ color: colors.statusDanger, lineHeight: 20 }}>{error}</Text> : null}
  </View>;
}
