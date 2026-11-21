import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, Text, View, type TextInput as NativeTextInput } from "react-native";
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { copyText, Icon, Markdown, Modal, TextInput } from "@getpaseo/plugin/client/ui";
import { MAX_NOTE_LENGTH } from "../shared/contracts";
import { formatMarkdown, toggleTaskMarker, type Format, type Selection, type TaskMarker } from "./markdown";
import type { SessionNote } from "./note";
import { previewMarkdown, type PreviewPart } from "./preview";

type Colors = PluginButtonContentProps["theme"]["colors"];
const shortcuts: { format: Format; icon: string; label: string }[] = [
  { format: "bold", icon: "Bold", label: "加粗" },
  { format: "heading", icon: "Heading", label: "标题" },
  { format: "strike", icon: "Strikethrough", label: "删除线" },
  { format: "bullet", icon: "List", label: "无序列表" },
  { format: "checklist", icon: "ListTodo", label: "待办列表" },
  { format: "toggle-task", icon: "SquareCheck", label: "切换勾选状态" },
];
const styles = StyleSheet.create({
  panel: { maxWidth: "100%", gap: 6 },
  header: { flexDirection: "row", alignItems: "center", gap: 8 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 2 },
  row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 2 },
  button: { alignItems: "center", justifyContent: "center", minHeight: 30, paddingHorizontal: 8, borderRadius: 5 },
  label: { fontSize: 13, lineHeight: 18 },
  hint: { fontSize: 12, lineHeight: 16 },
  body: { borderWidth: 1, borderRadius: 7 },
  toolbar: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", paddingHorizontal: 3, borderBottomWidth: 1 },
  editor: { paddingHorizontal: 9, paddingVertical: 7, fontSize: 14, lineHeight: 20, textAlignVertical: "top" },
  preview: { paddingHorizontal: 9, paddingVertical: 7, gap: 4 },
  list: { gap: 2 },
  item: { flexDirection: "row", alignItems: "flex-start", gap: 4 },
  itemBody: { flex: 1, minWidth: 0, gap: 4 },
  bullet: { minWidth: 22, textAlign: "center", fontSize: 13, lineHeight: 23 },
  checkbox: { width: 17, height: 17, alignItems: "center", justifyContent: "center", borderWidth: 1, borderRadius: 4 },
  quote: { borderLeftWidth: 2, paddingLeft: 9, gap: 4 },
});
function Preview({ parts, colors, toggle }: { parts: PreviewPart[]; colors: Colors; toggle(marker: TaskMarker): void }) {
  return parts.map((part, index) => {
    if (part.kind === "text") return <Text key={index} selectable style={[styles.label, { color: colors.foreground }]}>{part.markdown}</Text>;
    if (part.kind === "markdown") return <Markdown key={index}>{part.markdown}</Markdown>;
    if (part.kind === "quote") return <View key={index} style={[styles.quote, { borderLeftColor: colors.border }]}>
      <Preview parts={part.content} colors={colors} toggle={toggle} />
    </View>;
    return <View key={index} style={styles.list}>{part.items.map(({ bullet, task, content }, item) =>
      <View key={item} style={styles.item}>
        {task ? <Pressable accessibilityRole="checkbox" accessibilityLabel={task.label} accessibilityState={{ checked: task.checked }}
          aria-checked={task.checked} onPress={() => toggle(task)} hitSlop={3}
          style={{ width: 24, minHeight: 24, alignItems: "center", justifyContent: "center" }}>
          <View style={[styles.checkbox, { borderColor: task.checked ? colors.accent : colors.foregroundMuted,
            backgroundColor: task.checked ? colors.accent : undefined }]}>
            {task.checked && <Icon name="Check" size={12} color={colors.accentForeground} />}
          </View>
        </Pressable> : <Text accessibilityElementsHidden importantForAccessibility="no" style={[styles.bullet, { color: colors.foregroundMuted }]}>{bullet}</Text>}
        <View style={styles.itemBody}><Preview parts={content} colors={colors} toggle={toggle} /></View>
      </View>)}</View>;
  });
}

export function NotesPanel({ note, theme, layout, close }: PluginButtonContentProps & { note: SessionNote }) {
  const { status, markdown, conflict } = useSyncExternalStore(note.subscribe, note.get, note.get);
  const { colors } = theme;
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [statusOpen, setStatusOpen] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState("");
  const [requested, setRequested] = useState<{ selection: Selection; focus: boolean }>();
  const input = useRef<NativeTextInput>(null);
  const selection = useRef<Selection>(null);
  const preview = useMemo(() => mode === "preview" && markdown.trim() ? previewMarkdown(markdown) : [], [mode, markdown]);
  useEffect(() => note.mount(), [note]);
  useLayoutEffect(() => {
    if (!requested) return;
    if (requested.focus) input.current?.focus();
    setRequested(undefined);
  }, [requested]);

  function format(kind: Format) {
    const current = note.get().markdown;
    const next = formatMarkdown(current, selection.current ?? { start: current.length, end: current.length }, kind);
    if (next.markdown === current) return;
    selection.current = next.selection;
    note.edit(next.markdown);
    setRequested({ selection: next.selection, focus: true });
  }
  function selectMode(next: typeof mode) {
    if (mode === next) return;
    if (next === "edit" && selection.current) setRequested({ selection: selection.current, focus: false });
    setMode(next);
  }

  const iconButton = (label: string, icon: string, onPress: () => void, key?: string) =>
    <Pressable key={key} accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={({ pressed }) => [styles.button, { minWidth: layout.compact ? 39 : 32, minHeight: layout.compact ? 36 : 30,
        paddingHorizontal: 0, backgroundColor: pressed ? colors.surface2 : undefined }]}>
      <Icon name={icon} size={16} color={colors.foregroundMuted} />
    </Pressable>;
  const action = (label: string, onPress: () => void) =>
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: pressed ? colors.surface2 : undefined }]}>
      <Text style={[styles.label, { color: colors.accent }]}>{label}</Text>
    </Pressable>;

  async function copy(text: string, label: string) {
    try { await copyText(text); setCopyFeedback(`已复制${label}`); }
    catch { setCopyFeedback("复制失败，请重试"); }
  }

  const blocked = status === "loading" || status === "load-error";
  const statuses: Record<typeof status, readonly [icon: string, text: string, color: string]> = {
    loading: ["LoaderCircle", "读取中…", colors.foregroundMuted],
    "load-error": ["CircleAlert", "读取失败", colors.statusDanger],
    ready: ["Check", "没有待保存的更改", colors.foregroundMuted],
    pending: ["Clock", "待保存", colors.foregroundMuted],
    saving: ["LoaderCircle", "保存中…", colors.foregroundMuted],
    "save-error": ["CircleAlert", "保存失败，草稿已保留", colors.statusDanger],
    "too-long": ["TriangleAlert", `上限 ${MAX_NOTE_LENGTH.toLocaleString("zh-CN")} 字符，草稿未保存`, colors.statusWarning],
    conflict: ["TriangleAlert", "宿主有新版本，草稿已保留", colors.statusWarning],
  };
  const [statusIcon, statusText, statusColor] = statuses[status];
  let recovery: ReactNode;
  if (conflict && status !== "saving") {
    recovery = <>
      {action("复制草稿", () => { void copy(markdown, "草稿"); })}
      {action("复制宿主版", () => { void copy(conflict.markdown, "宿主版"); })}
      {action("放弃草稿，读取宿主版", note.keepServer)}
      {markdown.length <= MAX_NOTE_LENGTH && action(status === "save-error" ? "重试替换宿主版" : "用草稿替换宿主版", () => { void note.useDraft(); })}
    </>;
  } else if (status === "save-error" || status === "too-long") {
    recovery = <>
      {status === "save-error" && action("重试保存", () => { void note.flush(); })}
      {action("复制草稿", () => { void copy(markdown, "草稿"); })}
    </>;
  } else if (status === "load-error") recovery = action("重新读取", () => { void note.loadAgain(); });

  return <View testID="zeonest-conversation-notes" style={[styles.panel, { width: layout.compact ? undefined : 386 }]}>
    <View style={styles.header}>
      {layout.compact ? null : <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 14, fontWeight: "600" }}>会话笔记</Text>}
      {!blocked && <View accessibilityRole="tablist" accessibilityLabel="笔记模式" style={[styles.row, { padding: 2, backgroundColor: colors.surface1, borderRadius: 6 }]}>
        {(["edit", "preview"] as const).map((item) => <Pressable key={item} accessibilityRole="tab" accessibilityState={{ selected: mode === item }}
          accessibilityLabel={item === "edit" ? "编辑" : "预览"} aria-selected={mode === item} onPress={() => selectMode(item)}
          style={[styles.button, { minHeight: layout.compact ? 30 : 24, backgroundColor: mode === item ? colors.surface2 : undefined }]}>
          <Text style={[styles.label, { color: mode === item ? colors.foreground : colors.foregroundMuted }]}>{item === "edit" ? "编辑" : "预览"}</Text>
        </Pressable>)}
      </View>}
      <View style={{ flex: 1 }} />
      <View style={styles.headerActions}>
        <Pressable testID="conversation-notes-status" accessibilityRole="button"
          accessibilityLabel={`笔记状态：${statusText}`} accessibilityHint="查看状态详情和可用操作"
          onPress={() => { setCopyFeedback(""); setStatusOpen(true); }}
          style={({ pressed }) => [styles.button, { width: layout.compact ? 39 : 32, minHeight: layout.compact ? 36 : 30,
            paddingHorizontal: 0, backgroundColor: pressed ? colors.surface2 : undefined }]}>
          <Icon name={statusIcon} size={16} color={statusColor} />
        </Pressable>
        {layout.compact ? null : iconButton("关闭笔记", "X", close)}
      </View>
    </View>
    {!blocked && <View testID="conversation-notes-body" style={[styles.body, { borderColor: colors.border }]}>
      {mode === "edit" ? <>
        <View accessibilityRole="toolbar" accessibilityLabel="Markdown 格式" style={[styles.toolbar, { borderBottomColor: colors.border }]}>
          {shortcuts.map(({ format: kind, icon, label }) => iconButton(label, icon, () => format(kind), kind))}
        </View>
        <TextInput testID="conversation-notes-editor" ref={input} accessibilityLabel="笔记正文" multiline submitBehavior="newline"
          autoCapitalize="none" autoCorrect={false} spellCheck={false} value={markdown}
          selection={requested?.selection} onSelectionChange={({ nativeEvent }) => { selection.current = nativeEvent.selection; }}
          onChangeText={note.edit} placeholder="写 Markdown…" placeholderTextColor={colors.foregroundMuted}
          style={[styles.editor, { color: colors.foreground, height: layout.compact ? 240 : 270,
            fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }) }]} />
      </> : <View style={styles.preview}>
        {preview.length ? <Preview parts={preview} colors={colors} toggle={(marker) => {
          if (note.get().markdown === markdown) note.edit(toggleTaskMarker(markdown, marker));
        }} /> : <Text style={[styles.hint, { color: colors.foregroundMuted }]}>还没有笔记</Text>}
      </View>}
    </View>}
    <Modal title="笔记状态" open={statusOpen} onOpenChange={setStatusOpen}>
      <Modal.Content>
        <Text accessibilityLiveRegion="polite" style={[styles.label, { color: statusColor }]}>{statusText}</Text>
        {recovery && <View style={styles.row}>{recovery}</View>}
        {copyFeedback ? <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: colors.foregroundMuted }]}>{copyFeedback}</Text> : null}
      </Modal.Content>
    </Modal>
  </View>;
}
