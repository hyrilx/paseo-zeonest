import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Pressable, Text, View, type TextInput as NativeTextInput } from "react-native";
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { copyText, Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { MAX_NOTE_LENGTH } from "../shared/contracts";
import { toMarkdown } from "./blocks";
import type { Cursor, SessionNote } from "./note";

export function NotesPanel({ note, theme, layout, close }: PluginButtonContentProps & { note: SessionNote }) {
  const { status, blocks, conflict } = useSyncExternalStore(note.subscribe, note.get, note.get);
  const { colors } = theme;
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [selected, setSelected] = useState<number>();
  const [copyFeedback, setCopyFeedback] = useState("");
  const inputs = useRef(new Map<number, NativeTextInput>());
  useEffect(() => note.mount(), [note]);
  useLayoutEffect(() => {
    if (!cursor) return;
    inputs.current.get(cursor.id)?.focus();
    setCursor(null);
  }, [cursor]);

  const action = (label: string, onPress: () => void, icon?: "X" | "Plus" | "Trash2", iconOnly = false) =>
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={({ pressed }) => ({ minHeight: 44, minWidth: 44, paddingHorizontal: 8, borderRadius: 6,
        justifyContent: "center", alignItems: "center", flexDirection: "row", gap: 5, backgroundColor: pressed ? colors.surface2 : undefined })}>
      {icon && <Icon icon={icon} size={16} color={colors.foregroundMuted} />}
      {!iconOnly && <Text style={{ color: colors.accent, fontSize: 13 }}>{label}</Text>}
    </Pressable>;

  async function copy(markdown: string, label: string) {
    try { await copyText(markdown); setCopyFeedback(`已复制${label}`); }
    catch { setCopyFeedback("复制失败，请重试"); }
  }

  const blocked = status === "loading" || status === "load-error";
  const statusText = {
    loading: "正在读取笔记…", "load-error": "读取失败", ready: "已同步到宿主",
    pending: "待保存", saving: "正在保存…", "save-error": "保存失败，草稿已保留",
    "too-long": `笔记超过 ${MAX_NOTE_LENGTH.toLocaleString("zh-CN")} 字符，请缩短后保存`,
    conflict: "宿主已有新版本，草稿已保留",
  }[status];
  const statusColor = status === "load-error" || status === "save-error" ? colors.statusDanger
    : status === "conflict" || status === "too-long" ? colors.statusWarning : colors.foregroundMuted;

  let recovery: ReactNode;
  if (conflict && status !== "saving") {
    const overLimit = toMarkdown(blocks).length > MAX_NOTE_LENGTH;
    recovery = <>
      {status === "too-long" && <Text style={{ color: colors.statusWarning }}>草稿与宿主版本仍有冲突。</Text>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 4 }}>
        {action("复制草稿", () => { void copy(toMarkdown(blocks), "草稿"); })}
        {action("复制宿主版本", () => { void copy(conflict.markdown, "宿主版本"); })}
        {action("放弃草稿，读取宿主版", note.keepServer)}
        {!overLimit && action(status === "save-error" ? "重试替换宿主版" : "用草稿替换宿主版", () => { void note.useDraft(); })}
      </View>
    </>;
  } else if (status === "save-error" || status === "too-long") {
    recovery = <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 4 }}>
      {status === "save-error" && action("重试保存", () => { void note.flush(); })}
      {action("复制草稿", () => { void copy(toMarkdown(blocks), "草稿"); })}
    </View>;
  } else if (status === "load-error") {
    recovery = <View style={{ alignItems: "flex-start" }}>{action("重新读取", () => { void note.loadAgain(); })}</View>;
  }

  return <View testID="zeonest-conversation-notes" style={{ width: layout.compact ? undefined : 386, maxWidth: "100%", gap: 6 }}>
    <View style={{ borderBottomWidth: 1, borderBottomColor: colors.border, paddingBottom: 4,
      flexDirection: "row", alignItems: "center", gap: 9 }}>
      <Icon icon="FileText" size={17} color={colors.foregroundMuted} />
      <Text accessibilityRole="header" style={{ flex: 1, color: colors.foreground, fontSize: 16, fontWeight: "600" }}>会话笔记</Text>
      {action("关闭笔记", close, "X", true)}
    </View>
    {!blocked && <>
      <ScrollView style={{ maxHeight: layout.compact ? 248 : 296 }} keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingVertical: 4, gap: 3 }}>
        {blocks.map((block, index) => {
          const heading = block.kind === "heading";
          const inputStyle = { paddingHorizontal: 8, paddingVertical: 10, fontSize: heading ? 20 : 15,
            fontWeight: heading ? "700" : "400", lineHeight: heading ? 26 : 22 } as const;
          return <View key={block.id} style={{ flexDirection: "row", gap: 3, alignItems: "flex-start",
            borderRadius: 6, backgroundColor: selected === block.id ? colors.surface1 : undefined }}>
            {block.kind === "task" ? <Pressable accessibilityRole="checkbox" accessibilityLabel={block.text || "待办"}
              aria-checked={block.checked} accessibilityState={{ checked: block.checked }} onPress={() => note.toggle(block.id)}
              style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
              <View style={{ width: 18, height: 18, alignItems: "center", justifyContent: "center",
                borderColor: block.checked ? colors.accent : colors.foregroundMuted, borderWidth: 1, borderRadius: 4,
                backgroundColor: block.checked ? colors.accent : undefined }}>
                {block.checked && <Icon icon="Check" size={13} color={colors.accentForeground} />}
              </View>
            </Pressable> : block.kind === "bullet" ? <Text accessible={false}
              style={{ width: 24, textAlign: "center", paddingTop: 11, color: colors.foregroundMuted, fontSize: 16 }}>•</Text> : null}
            <View style={{ flex: 1, minWidth: 0, minHeight: 44 }}>
              {/* Measure wrapped lines without relying on TextInput's platform-specific scroll height. */}
              <Text aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none" selectable={false}
                style={{ ...inputStyle, opacity: 0 }}>{block.text || "\u00a0"}</Text>
              <TextInput ref={(input) => { if (input) inputs.current.set(block.id, input); else inputs.current.delete(block.id); }}
                accessibilityLabel={`第 ${index + 1} 块 · ${{ paragraph: "正文", heading: "标题", task: "待办", bullet: "列表" }[block.kind]}`}
                multiline submitBehavior="newline" textAlignVertical="top" value={block.text}
                selection={cursor?.id === block.id ? { start: cursor.offset, end: cursor.offset } : undefined}
                onFocus={() => setSelected(block.id)}
                onChangeText={(value) => { const target = note.edit(block.id, value); if (target) setCursor(target); }}
                placeholder={block.kind === "task" ? "待办" : heading ? "标题" : block.kind === "bullet" ? "列表项"
                  : blocks.length === 1 ? "记下这场会话的结论…" : undefined}
                placeholderTextColor={colors.foregroundMuted}
                style={{ ...inputStyle, position: "absolute", top: 0, bottom: 0, left: 0, right: 0,
                  width: "100%", height: "100%", color: colors.foreground,
                  textDecorationLine: block.kind === "task" && block.checked ? "line-through" : "none" }} />
            </View>
          </View>;
        })}
      </ScrollView>
      <View style={{ borderTopColor: colors.border, borderTopWidth: 1, flexDirection: "row", flexWrap: "wrap",
        alignItems: "center", justifyContent: "space-between", paddingTop: 2 }}>
        {action("添加一块", () => setCursor(note.append()), "Plus")}
        {blocks.some((block) => block.id === selected) && action("删除当前块", () => { if (selected !== undefined) note.remove(selected); }, "Trash2", true)}
      </View>
    </>}
    <Text accessibilityLiveRegion="polite" style={{ color: statusColor, fontSize: 12, lineHeight: 17 }}>{statusText}</Text>
    {recovery}
    {copyFeedback ? <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted, fontSize: 12 }}>{copyFeedback}</Text> : null}
    {status === "ready" && blocks.length === 1 && !blocks[0]?.text && blocks[0]?.kind === "paragraph" &&
      <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>用 # 加空格写标题，- 加空格写列表；在列表项开头输入 [ ] 加空格添加待办。</Text>}
  </View>;
}
