import { useRef, useState, useSyncExternalStore } from "react";
import { Text, View, Pressable } from "react-native";
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { copyText } from "@getpaseo/plugin/client/ui";
import type { DisplayEntry, StatusStore } from "./store";
import { errorMessage } from "../shared/text";

export interface StatusScope { agentId: string; workspaceId: string; entryId?: string }
type Props = PluginButtonContentProps & {
  source: StatusStore; scope: StatusScope;
  expand(entry: DisplayEntry): Promise<{ message: string }>;
};
export function StatusDetails({ source, scope, expand, theme, layout }: Props) {
  const snapshot = useSyncExternalStore(source.subscribe, source.get, source.get);
  const entries = snapshot.filter((entry) => entry.agentId === scope.agentId && entry.workspaceId === scope.workspaceId
    && (scope.entryId ? entry.id === scope.entryId : !entry.pinned || entry.warning));
  const [pending, setPending] = useState<{ id: string; kind: "copy" | "expand" } | null>(null);
  const [feedback, setFeedback] = useState<{ id: string; message: string; error: boolean } | null>(null);
  const lock = useRef(false);
  const colors = theme.colors;
  async function run(entry: DisplayEntry, kind: "copy" | "expand", action: () => Promise<string>) {
    if (lock.current) return;
    lock.current = true; setPending({ id: entry.id, kind }); setFeedback(null);
    try { setFeedback({ id: entry.id, message: await action(), error: false }); }
    catch (failure) { setFeedback({ id: entry.id, message: errorMessage(failure), error: true }); }
    finally { lock.current = false; setPending(null); }
  }
  const button = { minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 8, justifyContent: "center" as const };
  // Body only: Paseo owns the surface background, padding and vertical scrolling.
  return <View style={{ width: layout.compact ? undefined : 420, maxWidth: "100%", minWidth: 0, gap: 16 }}>
    <View style={{ gap: 4 }}>
      <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 17, fontWeight: "600" }}>Pi 状态</Text>
      {entries.length > 0 && <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
        {scope.entryId ? "单独常驻" : `${entries.filter((entry) => !entry.warning).length} 项状态`}
        {entries.some((entry) => entry.warning) ? " · 状态桥接异常" : ""}
      </Text>}
    </View>
    {!entries.length ? <Text style={{ color: colors.foregroundMuted }}>此状态已移除或通道已断开，请关闭后重新查看。</Text>
      : entries.map((entry, index) => <View key={entry.id} style={{
        gap: 10, minWidth: 0, paddingTop: index ? 16 : 0, borderTopWidth: index ? 1 : 0, borderColor: colors.border,
      }}>
        <Text selectable style={{ color: entry.warning ? colors.statusWarning : colors.foreground, fontSize: 14, fontWeight: "600", lineHeight: 22 }}>{entry.key}</Text>
        <Text selectable style={{ color: entry.warning ? colors.statusWarning : colors.foreground, fontSize: 14, lineHeight: 22, flexShrink: 1 }}>{entry.text}</Text>
        {entry.command && <Text selectable style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
          展开命令：{entry.command}。执行后可能修改会话或调用模型。
        </Text>}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Pressable accessibilityRole="button" accessibilityLabel={`复制 ${entry.key} 完整内容`} disabled={pending !== null} style={button}
            onPress={() => { void run(entry, "copy", async () => { await copyText(entry.text); return "已复制完整内容"; }); }}>
            <Text style={{ color: colors.foregroundMuted }}>{pending?.id === entry.id && pending.kind === "copy" ? "正在复制…" : "复制"}</Text>
          </Pressable>
          {entry.command && <Pressable accessibilityRole="button" accessibilityLabel={`执行 ${entry.key} 的 Pi 展开命令`} disabled={pending !== null} style={button}
            onPress={() => { void run(entry, "expand", async () => (await expand(entry)).message); }}>
            <Text style={{ color: colors.accent }}>{pending?.id === entry.id && pending.kind === "expand" ? "正在处理…" : "执行展开命令"}</Text>
          </Pressable>}
        </View>
        {feedback?.id === entry.id && <Text accessibilityLiveRegion="polite" style={{ color: feedback.error ? colors.statusDanger : colors.foregroundMuted, lineHeight: 20 }}>{feedback.message}</Text>}
      </View>)}
  </View>;
}
