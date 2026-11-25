import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import {
  MAX_PROMPT_NAME_LENGTH,
  MAX_PROMPT_TEMPLATE_LENGTH,
  type PlaceholderDefinition,
  type PlaceholderType,
  type PromptDraft,
  type PromptRecord,
} from "../shared/contracts";
import {
  analyzeTemplate,
  createDefaultPlaceholder,
  createSamplePromptDraft,
} from "../shared/template";
import { PromptApplyModal } from "./apply-modal";
import type { PromptLibrary } from "./library";
import { PlaceholderEditorCard } from "./placeholder-editor";
import { ActionButton, Chip, SectionCard, uiStyles } from "./ui";

const styles = StyleSheet.create({
  page: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  split: {
    flexDirection: "row",
  },
  listPane: {
    width: 320,
    minWidth: 260,
    maxWidth: 380,
    borderRightWidth: StyleSheet.hairlineWidth,
    minHeight: 0,
  },
  listPaneCompact: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  detailPane: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  paneHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  paneTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
    minWidth: 0,
  },
  paneTitle: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "600",
    flexShrink: 1,
  },
  countText: {
    fontSize: 12,
    lineHeight: 16,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 0,
  },
  controls: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 9,
    minHeight: 36,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 6,
    fontSize: 13,
    lineHeight: 18,
  },
  tagRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  listScroll: {
    padding: 10,
    gap: 8,
  },
  listItem: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 11,
    gap: 6,
  },
  listItemTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  listItemTitle: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
    flex: 1,
    minWidth: 0,
  },
  listItemDesc: {
    fontSize: 12,
    lineHeight: 17,
  },
  editorScroll: {
    padding: 16,
    gap: 14,
  },
  editorScrollCompact: {
    padding: 12,
    gap: 12,
  },
  sectionHeadingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    flexWrap: "wrap",
  },
  sectionHeading: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
  },
  toolbar: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  templateInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 11,
    paddingVertical: 10,
    minHeight: 150,
    fontSize: 13,
    lineHeight: 20,
    textAlignVertical: "top",
    fontFamily: "monospace",
  },
  caption: {
    fontSize: 12,
    lineHeight: 17,
  },
  banner: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    gap: 8,
  },
  bannerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    flexWrap: "wrap",
  },
  emptyCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 28,
    gap: 10,
  },
  emptyTitle: {
    fontSize: 15,
    lineHeight: 21,
    fontWeight: "600",
  },
  emptyCopy: {
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    maxWidth: 360,
  },
  unusedRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingVertical: 4,
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    paddingTop: 8,
  },
});

interface EditorState {
  id: string | null;
  revision: string | null;
  name: string;
  description: string;
  tagsText: string;
  template: string;
  placeholders: PlaceholderDefinition[];
  dirty: boolean;
}

function parseTagsText(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of text.split(/[,，\n]/)) {
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function editorFromRecord(record: PromptRecord): EditorState {
  return {
    id: record.id,
    revision: record.revision,
    name: record.name,
    description: record.description,
    tagsText: record.tags.join(", "),
    template: record.template,
    placeholders: record.placeholders,
    dirty: false,
  };
}

function editorFromDraft(draft: PromptDraft): EditorState {
  return {
    id: null,
    revision: null,
    name: draft.name,
    description: draft.description,
    tagsText: draft.tags.join(", "),
    template: draft.template,
    placeholders: draft.placeholders,
    dirty: true,
  };
}

function blankEditor(): EditorState {
  return {
    id: null,
    revision: null,
    name: "",
    description: "",
    tagsText: "",
    template: "",
    placeholders: [],
    dirty: true,
  };
}

function nextUniqueKey(base: string, existingKeys: ReadonlySet<string>): string {
  if (!existingKeys.has(base)) return base;
  for (let n = 2; n < 999; n++) {
    const candidate = `${base}${n}`;
    if (!existingKeys.has(candidate)) return candidate;
  }
  return `${base}_${Date.now()}`;
}

export function PromptManagerHub({
  library,
  theme,
  layout,
  host,
  params,
}: PluginScreenProps & { library: PromptLibrary }) {
  const { colors } = theme;
  const toast = useToast();
  const listState = useSyncExternalStore(library.subscribeList, library.getListState, library.getListState);

  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [conflictRecord, setConflictRecord] = useState<PromptRecord | null | undefined>(undefined);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const hostId = `screen:${host.id}`;
  const appliedParamRef = useRef<string | null>(null);

  useEffect(() => library.registerModalHost(hostId), [library, hostId]);

  useEffect(() => {
    void library.refresh().catch(() => {});
  }, [library]);

  // Fallback support when Command Center opened this screen with modal=apply
  useEffect(() => {
    const token = params.modal === "apply" ? `${params.modal}:${params.promptId ?? ""}:${params.ts ?? ""}` : null;
    if (token && appliedParamRef.current !== token) {
      appliedParamRef.current = token;
      library.openApplyModal({ promptId: params.promptId || undefined });
    }
  }, [library, params.modal, params.promptId, params.ts]);

  // On wide screen, auto-select the first prompt once loaded if nothing is open yet
  useEffect(() => {
    if (!layout.compact && editor === null && listState.status === "ready" && listState.prompts.length > 0) {
      setEditor(editorFromRecord(listState.prompts[0]!));
    }
  }, [layout.compact, editor, listState.status, listState.prompts]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const item of listState.prompts) {
      for (const tag of item.tags) set.add(tag);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [listState.prompts]);

  const filteredPrompts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return listState.prompts.filter((item) => {
      if (activeTag && !item.tags.includes(activeTag)) return false;
      if (!needle) return true;
      const haystack = `${item.name}\n${item.description}\n${item.tags.join(" ")}\n${item.template}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [listState.prompts, query, activeTag]);

  const analysis = useMemo(() => {
    if (!editor) return null;
    return analyzeTemplate(editor.template, editor.placeholders);
  }, [editor]);

  function openExisting(record: PromptRecord) {
    setEditor(editorFromRecord(record));
    setErrorMessage(null);
    setConflictRecord(undefined);
  }

  function startNewPrompt() {
    setEditor(blankEditor());
    setErrorMessage(null);
    setConflictRecord(undefined);
  }

  function startSamplePrompt() {
    setEditor(editorFromDraft(createSamplePromptDraft()));
    setErrorMessage(null);
    setConflictRecord(undefined);
  }

  function patchEditor(patch: Partial<EditorState>) {
    setEditor((prev) => (prev ? { ...prev, ...patch, dirty: true } : prev));
    setErrorMessage(null);
  }

  function upsertPlaceholder(nextDef: PlaceholderDefinition) {
    setEditor((prev) => {
      if (!prev) return prev;
      const exists = prev.placeholders.some((item) => item.key === nextDef.key);
      const nextList = exists
        ? prev.placeholders.map((item) => (item.key === nextDef.key ? nextDef : item))
        : [...prev.placeholders, nextDef];
      return { ...prev, placeholders: nextList, dirty: true };
    });
  }

  function removeUnusedPlaceholder(key: string) {
    setEditor((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        placeholders: prev.placeholders.filter((item) => item.key !== key),
        dirty: true,
      };
    });
  }

  function insertPlaceholderToken(type: PlaceholderType) {
    if (!editor) return;
    const existingKeys = new Set<string>([
      ...editor.placeholders.map((item) => item.key),
      ...(analysis?.discovered.map((item) => item.key) ?? []),
    ]);
    const baseName =
      type === "text" ? "变量" : type === "select" ? "选项" : type === "checkbox" ? "开关" : "可选行";
    const key = nextUniqueKey(baseName, existingKeys);
    const token =
      type === "optional-line"
        ? `${editor.template && !editor.template.endsWith("\n") ? "\n" : ""}{{?${key}}}可选行内容`
        : `{{${key}}}`;
    const def = createDefaultPlaceholder(key, type);
    setEditor((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        template: prev.template + token,
        placeholders: [...prev.placeholders.filter((item) => item.key !== key), def],
        dirty: true,
      };
    });
  }

  function reinsertUnusedPlaceholder(def: PlaceholderDefinition) {
    if (!editor) return;
    const token =
      def.type === "optional-line"
        ? `${editor.template && !editor.template.endsWith("\n") ? "\n" : ""}{{?${def.key}}}可选行内容`
        : `{{${def.key}}}`;
    patchEditor({ template: editor.template + token });
  }

  function buildDraftFromEditor(state: EditorState): PromptDraft {
    const parsed = analyzeTemplate(state.template, state.placeholders);
    const combined = [...parsed.effectivePlaceholders, ...parsed.unusedPlaceholders];
    return {
      name: state.name.trim(),
      description: state.description.trim(),
      tags: parseTagsText(state.tagsText),
      template: state.template,
      placeholders: combined,
    };
  }

  async function saveCurrent(overrideRevision?: string | null) {
    if (!editor || saving) return;
    const trimmedName = editor.name.trim();
    if (!trimmedName) {
      setErrorMessage("请先填写 Prompt 名称。");
      return;
    }
    if (trimmedName.length > MAX_PROMPT_NAME_LENGTH) {
      setErrorMessage(`Prompt 名称不能超过 ${MAX_PROMPT_NAME_LENGTH} 字。`);
      return;
    }
    if (editor.template.length > MAX_PROMPT_TEMPLATE_LENGTH) {
      setErrorMessage(`模板正文不能超过 ${MAX_PROMPT_TEMPLATE_LENGTH} 字。`);
      return;
    }

    const draft = buildDraftFromEditor(editor);
    setSaving(true);
    setErrorMessage(null);
    setConflictRecord(undefined);

    try {
      const result = await library.save({
        ...draft,
        id: editor.id ?? undefined,
        expectedRevision: overrideRevision !== undefined ? overrideRevision : editor.revision,
      });
      if (result.status === "saved") {
        setEditor(editorFromRecord(result.prompt));
        toast.show("Prompt 已保存", { variant: "success" });
      } else {
        setConflictRecord(result.current);
        setErrorMessage(
          result.current
            ? "该 Prompt 已被其他客户端更新，可刷新为最新版本或以当前编辑内容覆盖。"
            : "该 Prompt 已在其他客户端被删除，可重新另存为新 Prompt。",
        );
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "保存 Prompt 失败");
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!editor?.id || deleting) return;
    setDeleting(true);
    setErrorMessage(null);
    try {
      const result = await library.remove({ id: editor.id, expectedRevision: editor.revision });
      setDeleteConfirmOpen(false);
      if (result.status === "deleted" || result.status === "not-found") {
        toast.show("已删除 Prompt", { variant: "info" });
        const remaining = library.getListState().prompts.filter((item) => item.id !== editor.id);
        setEditor(!layout.compact && remaining.length > 0 ? editorFromRecord(remaining[0]!) : null);
      } else {
        setConflictRecord(result.current);
        setErrorMessage("该 Prompt 已被其他客户端修改，请先刷新后再决定是否删除。");
      }
    } catch (error) {
      setDeleteConfirmOpen(false);
      setErrorMessage(error instanceof Error ? error.message : "删除 Prompt 失败");
    } finally {
      setDeleting(false);
    }
  }

  function openApplyForCurrent() {
    if (!editor) return;
    const draft = buildDraftFromEditor({
      ...editor,
      name: editor.name.trim() || "未命名 Prompt",
    });
    library.openApplyModal({ draft });
  }

  const showList = !layout.compact || editor === null;
  const showDetail = !layout.compact || editor !== null;

  return (
    <View testID="prompt-manager-hub" style={[styles.page, !layout.compact && styles.split, { backgroundColor: colors.surface0 }]}>
      {showList ? (
        <View
          testID="prompt-manager-list-pane"
          style={[
            layout.compact ? styles.listPaneCompact : styles.listPane,
            { borderRightColor: colors.border },
          ]}
        >
          <View style={[styles.paneHeader, { borderBottomColor: colors.border }]}>
            <View style={styles.paneTitleRow}>
              <Text accessibilityRole="header" style={[styles.paneTitle, { color: colors.foreground }]}>
                Prompt 模板
              </Text>
              <Text style={[styles.countText, { color: colors.foregroundMuted }]}>
                {listState.prompts.length}
              </Text>
            </View>
            <View style={styles.headerActions}>
              <ActionButton
                colors={colors}
                small
                variant="ghost"
                iconOnly
                icon="RefreshCw"
                accessibilityLabel="刷新 Prompt 列表"
                disabled={listState.status === "loading"}
                onPress={() => { void library.refresh().catch(() => {}); }}
              />
              <ActionButton
                colors={colors}
                small
                variant="primary"
                icon="Plus"
                label="新建"
                testID="prompt-manager-new-btn"
                onPress={startNewPrompt}
              />
            </View>
          </View>

          <View style={[styles.controls, { borderBottomColor: colors.border }]}>
            <View style={[styles.searchBox, { backgroundColor: colors.surface1, borderColor: colors.border }]}>
              <Icon name="Search" size={14} color={colors.foregroundMuted} />
              <TextInput
                testID="prompt-manager-search"
                accessibilityLabel="搜索 Prompt 模板"
                placeholder="搜索名称、说明、标签或正文…"
                placeholderTextColor={colors.foregroundMuted}
                autoCapitalize="none"
                autoCorrect={false}
                value={query}
                onChangeText={setQuery}
                style={[styles.searchInput, { color: colors.foreground }]}
              />
              {query ? (
                <ActionButton
                  colors={colors}
                  small
                  variant="ghost"
                  iconOnly
                  icon="X"
                  accessibilityLabel="清除搜索"
                  onPress={() => setQuery("")}
                />
              ) : null}
            </View>

            {allTags.length > 0 ? (
              <View style={styles.tagRow}>
                <Chip
                  colors={colors}
                  compact
                  label="全部"
                  selected={activeTag === null}
                  onPress={() => setActiveTag(null)}
                />
                {allTags.map((tag) => (
                  <Chip
                    key={tag}
                    colors={colors}
                    compact
                    label={`#${tag}`}
                    selected={activeTag === tag}
                    onPress={() => setActiveTag((prev) => (prev === tag ? null : tag))}
                  />
                ))}
              </View>
            ) : null}

            {listState.status === "error" ? (
              <View style={[styles.banner, { backgroundColor: colors.surface1, borderColor: colors.statusDanger }]}>
                <View style={styles.bannerRow}>
                  <Text style={[styles.caption, { color: colors.statusDanger, flex: 1 }]}>
                    {listState.error ?? "读取 Prompt 列表失败"}
                  </Text>
                  <ActionButton
                    colors={colors}
                    small
                    icon="RefreshCw"
                    label="重试"
                    onPress={() => { void library.refresh().catch(() => {}); }}
                  />
                </View>
              </View>
            ) : null}
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.listScroll}>
            {listState.status === "loading" && listState.prompts.length === 0 ? (
              <Text style={[styles.caption, { color: colors.foregroundMuted, padding: 12 }]}>正在读取 Prompt 模板…</Text>
            ) : filteredPrompts.length === 0 ? (
              <View style={styles.emptyCenter}>
                <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
                  {query || activeTag ? "没有匹配的 Prompt" : "还没有 Prompt 模板"}
                </Text>
                <Text style={[styles.emptyCopy, { color: colors.foregroundMuted }]}>
                  {query || activeTag
                    ? "请调整搜索关键词或标签筛选条件。"
                    : "新建一个模板，使用 {{变量}} 和 {{?可选行}} 定义动态占位符，或一键导入完整示例体验。"}
                </Text>
                {!query && !activeTag ? (
                  <View style={styles.headerActions}>
                    <ActionButton
                      colors={colors}
                      variant="primary"
                      icon="Plus"
                      label="新建 Prompt"
                      onPress={startNewPrompt}
                    />
                    <ActionButton
                      colors={colors}
                      icon="Sparkles"
                      label="导入示例"
                      testID="prompt-manager-sample-btn"
                      onPress={startSamplePrompt}
                    />
                  </View>
                ) : null}
              </View>
            ) : (
              filteredPrompts.map((item) => {
                const selected = editor?.id === item.id;
                const count = analyzeTemplate(item.template, item.placeholders).effectivePlaceholders.length;
                return (
                  <Pressable
                    key={item.id}
                    testID={`prompt-list-item-${item.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={`编辑 Prompt：${item.name}`}
                    accessibilityState={{ selected }}
                    onPress={() => openExisting(item)}
                    style={({ pressed }) => [
                      styles.listItem,
                      {
                        backgroundColor: selected ? colors.surface2 : pressed ? colors.surface1 : colors.surface0,
                        borderColor: selected ? colors.accent : colors.border,
                      },
                    ]}
                  >
                    <View style={styles.listItemTop}>
                      <Text numberOfLines={1} style={[styles.listItemTitle, { color: colors.foreground }]}>
                        {item.name}
                      </Text>
                      <ActionButton
                        colors={colors}
                        small
                        variant="ghost"
                        iconOnly
                        icon="Play"
                        accessibilityLabel={`应用 ${item.name}`}
                        testID={`prompt-list-apply-${item.id}`}
                        onPress={() => library.openApplyModal({ promptId: item.id })}
                      />
                    </View>
                    {item.description ? (
                      <Text numberOfLines={2} style={[styles.listItemDesc, { color: colors.foregroundMuted }]}>
                        {item.description}
                      </Text>
                    ) : null}
                    <View style={styles.tagRow}>
                      <View style={[uiStyles.badge, { backgroundColor: colors.surface1, borderColor: colors.border }]}>
                        <Text style={[uiStyles.badgeText, { color: colors.foregroundMuted }]}>
                          {count > 0 ? `${count} 个占位符` : "无占位符"}
                        </Text>
                      </View>
                      {item.tags.slice(0, 3).map((tag) => (
                        <View key={tag} style={[uiStyles.badge, { backgroundColor: colors.surface1, borderColor: colors.border }]}>
                          <Text style={[uiStyles.badgeText, { color: colors.foregroundMuted }]}>#{tag}</Text>
                        </View>
                      ))}
                    </View>
                  </Pressable>
                );
              })
            )}
          </ScrollView>
        </View>
      ) : null}

      {showDetail ? (
        <View testID="prompt-manager-detail-pane" style={styles.detailPane}>
          {!editor ? (
            <View style={styles.emptyCenter}>
              <Text style={[styles.emptyTitle, { color: colors.foreground }]}>选择或新建一个 Prompt</Text>
              <Text style={[styles.emptyCopy, { color: colors.foregroundMuted }]}>
                支持填空、多选/单选（含自填与间隔符）、勾选展开和可选行嵌套占位符；随时在命令中心搜索「插入 Prompt」快速套用。
              </Text>
              <View style={styles.headerActions}>
                <ActionButton colors={colors} variant="primary" icon="Plus" label="新建 Prompt" onPress={startNewPrompt} />
                <ActionButton colors={colors} icon="Sparkles" label="导入示例模板" onPress={startSamplePrompt} />
              </View>
            </View>
          ) : (
            <>
              <View style={[styles.paneHeader, { borderBottomColor: colors.border }]}>
                <View style={styles.paneTitleRow}>
                  {layout.compact ? (
                    <ActionButton
                      colors={colors}
                      small
                      variant="ghost"
                      icon="ChevronLeft"
                      label="列表"
                      testID="prompt-manager-back-btn"
                      onPress={() => setEditor(null)}
                    />
                  ) : null}
                  <Text numberOfLines={1} style={[styles.paneTitle, { color: colors.foreground }]}>
                    {editor.name.trim() || (editor.id ? "编辑 Prompt" : "新建 Prompt")}
                  </Text>
                  {editor.dirty ? (
                    <View style={[uiStyles.badge, { backgroundColor: colors.surface2, borderColor: colors.statusWarning }]}>
                      <Text style={[uiStyles.badgeText, { color: colors.statusWarning }]}>未保存</Text>
                    </View>
                  ) : null}
                </View>

                <View style={styles.headerActions}>
                  <ActionButton
                    colors={colors}
                    small
                    icon="Play"
                    label={layout.compact ? undefined : "应用"}
                    iconOnly={layout.compact}
                    accessibilityLabel="应用并预览当前 Prompt"
                    testID="prompt-editor-apply-btn"
                    onPress={openApplyForCurrent}
                  />
                  {editor.id ? (
                    <ActionButton
                      colors={colors}
                      small
                      variant="danger"
                      icon="Trash2"
                      label={layout.compact ? undefined : "删除"}
                      iconOnly={layout.compact}
                      accessibilityLabel="删除当前 Prompt"
                      disabled={deleting}
                      testID="prompt-editor-delete-btn"
                      onPress={() => setDeleteConfirmOpen(true)}
                    />
                  ) : null}
                  <ActionButton
                    colors={colors}
                    small
                    variant="primary"
                    icon="Save"
                    label={saving ? "保存中…" : "保存"}
                    disabled={saving || !editor.name.trim()}
                    testID="prompt-editor-save-btn"
                    onPress={() => { void saveCurrent(); }}
                  />
                </View>
              </View>

              <ScrollView
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={layout.compact ? styles.editorScrollCompact : styles.editorScroll}
              >
                {errorMessage ? (
                  <View style={[styles.banner, { backgroundColor: colors.surface1, borderColor: colors.statusDanger }]}>
                    <Text accessibilityLiveRegion="polite" style={[styles.caption, { color: colors.statusDanger }]}>
                      {errorMessage}
                    </Text>
                    {conflictRecord !== undefined ? (
                      <View style={styles.headerActions}>
                        {conflictRecord ? (
                          <ActionButton
                            colors={colors}
                            small
                            label="采用最新版本"
                            onPress={() => openExisting(conflictRecord)}
                          />
                        ) : null}
                        <ActionButton
                          colors={colors}
                          small
                          variant="primary"
                          label={conflictRecord ? "用当前内容覆盖" : "另存为新 Prompt"}
                          onPress={() => {
                            if (conflictRecord) {
                              void saveCurrent(conflictRecord.revision);
                            } else {
                              setEditor((prev) => (prev ? { ...prev, id: null, revision: null } : prev));
                              void saveCurrent(null);
                            }
                          }}
                        />
                      </View>
                    ) : null}
                  </View>
                ) : null}

                <SectionCard colors={colors}>
                  <View style={uiStyles.fieldWrap}>
                    <Text style={[uiStyles.fieldLabel, { color: colors.foreground }]}>Prompt 名称 *</Text>
                    <TextInput
                      testID="prompt-editor-name"
                      accessibilityLabel="Prompt 名称"
                      placeholder="例如：代码审查模板"
                      placeholderTextColor={colors.foregroundMuted}
                      value={editor.name}
                      onChangeText={(name) => patchEditor({ name })}
                      style={[
                        uiStyles.inputBox,
                        { backgroundColor: colors.surface0, borderColor: colors.border, color: colors.foreground },
                      ]}
                    />
                  </View>

                  <View style={uiStyles.fieldWrap}>
                    <Text style={[uiStyles.fieldLabel, { color: colors.foreground }]}>简介（可选）</Text>
                    <TextInput
                      testID="prompt-editor-description"
                      accessibilityLabel="Prompt 简介"
                      placeholder="说明这个 Prompt 的适用场景"
                      placeholderTextColor={colors.foregroundMuted}
                      value={editor.description}
                      onChangeText={(description) => patchEditor({ description })}
                      style={[
                        uiStyles.inputBox,
                        { backgroundColor: colors.surface0, borderColor: colors.border, color: colors.foreground },
                      ]}
                    />
                  </View>

                  <View style={uiStyles.fieldWrap}>
                    <Text style={[uiStyles.fieldLabel, { color: colors.foreground }]}>标签（用逗号分隔）</Text>
                    <TextInput
                      testID="prompt-editor-tags"
                      accessibilityLabel="Prompt 标签"
                      placeholder="例如：代码审查, 重构, 测试"
                      placeholderTextColor={colors.foregroundMuted}
                      value={editor.tagsText}
                      onChangeText={(tagsText) => patchEditor({ tagsText })}
                      style={[
                        uiStyles.inputBox,
                        { backgroundColor: colors.surface0, borderColor: colors.border, color: colors.foreground },
                      ]}
                    />
                  </View>
                </SectionCard>

                <SectionCard colors={colors}>
                  <View style={styles.sectionHeadingRow}>
                    <Text style={[styles.sectionHeading, { color: colors.foreground }]}>Prompt 模板正文</Text>
                    <View style={styles.toolbar}>
                      <ActionButton
                        colors={colors}
                        small
                        icon="Type"
                        label="+ 填空"
                        testID="insert-placeholder-text"
                        onPress={() => insertPlaceholderToken("text")}
                      />
                      <ActionButton
                        colors={colors}
                        small
                        icon="List"
                        label="+ 多选"
                        testID="insert-placeholder-select"
                        onPress={() => insertPlaceholderToken("select")}
                      />
                      <ActionButton
                        colors={colors}
                        small
                        icon="SquareCheck"
                        label="+ 勾选"
                        testID="insert-placeholder-checkbox"
                        onPress={() => insertPlaceholderToken("checkbox")}
                      />
                      <ActionButton
                        colors={colors}
                        small
                        icon="ListTodo"
                        label="+ 可选行"
                        testID="insert-placeholder-optional-line"
                        onPress={() => insertPlaceholderToken("optional-line")}
                      />
                    </View>
                  </View>

                  <TextInput
                    testID="prompt-editor-template"
                    accessibilityLabel="Prompt 模板正文"
                    placeholder={"输入模板正文，使用 {{变量名}} 插入占位符，行首使用 {{?行标识}} 定义可选行（行内可嵌套其他 {{占位符}}）。"}
                    placeholderTextColor={colors.foregroundMuted}
                    multiline
                    value={editor.template}
                    onChangeText={(template) => patchEditor({ template })}
                    style={[
                      styles.templateInput,
                      { backgroundColor: colors.surface0, borderColor: colors.border, color: colors.foreground },
                    ]}
                  />

                  <Text style={[styles.caption, { color: colors.foregroundMuted }]}>
                    语法说明：{"{{名称}}"} 定义填空/多选/勾选占位符；{"{{?名称}}"} 置于行首（或配合 {"{{/?名称}}"}）定义可选行，可选行内可继续使用其他占位符；使用 {"\\{{"} 输出字面量。
                  </Text>
                </SectionCard>

                <View style={{ gap: 10 }}>
                  <View style={styles.sectionHeadingRow}>
                    <Text style={[styles.sectionHeading, { color: colors.foreground }]}>
                      占位符配置（{analysis?.effectivePlaceholders.length ?? 0}）
                    </Text>
                    <Text style={[styles.caption, { color: colors.foregroundMuted }]}>
                      自动从正文识别，点击卡片展开配置
                    </Text>
                  </View>

                  {!analysis || analysis.effectivePlaceholders.length === 0 ? (
                    <SectionCard colors={colors}>
                      <Text style={[styles.caption, { color: colors.foregroundMuted }]}>
                        模板中尚未检测到占位符。点击上方「+ 填空 / + 多选 / + 勾选 / + 可选行」或在正文输入 {"{{名称}}"} 即可自动添加。
                      </Text>
                    </SectionCard>
                  ) : (
                    analysis.effectivePlaceholders.map((def, index) => (
                      <PlaceholderEditorCard
                        key={def.key}
                        colors={colors}
                        compact={layout.compact}
                        def={def}
                        discovered={analysis.discovered.find((item) => item.key === def.key)}
                        defaultExpanded={index === 0 && analysis.effectivePlaceholders.length <= 4}
                        onChange={upsertPlaceholder}
                      />
                    ))
                  )}

                  {analysis && analysis.unusedPlaceholders.length > 0 ? (
                    <SectionCard colors={colors}>
                      <Text style={[styles.sectionHeading, { color: colors.foregroundMuted }]}>
                        未在正文中引用的配置（{analysis.unusedPlaceholders.length}）
                      </Text>
                      {analysis.unusedPlaceholders.map((def) => (
                        <View key={def.key} style={styles.unusedRow}>
                          <Text style={[styles.caption, { color: colors.foreground, flex: 1 }]}>
                            {def.label ? `${def.label} (${def.key})` : def.key}
                          </Text>
                          <ActionButton
                            colors={colors}
                            small
                            label="插入正文"
                            onPress={() => reinsertUnusedPlaceholder(def)}
                          />
                          <ActionButton
                            colors={colors}
                            small
                            variant="ghost"
                            iconOnly
                            icon="Trash2"
                            accessibilityLabel={`移除未使用的占位符 ${def.key}`}
                            onPress={() => removeUnusedPlaceholder(def.key)}
                          />
                        </View>
                      ))}
                    </SectionCard>
                  ) : null}
                </View>
              </ScrollView>
            </>
          )}
        </View>
      ) : null}

      <Modal
        open={deleteConfirmOpen}
        title="删除 Prompt"
        onOpenChange={(next) => {
          if (!next && !deleting) setDeleteConfirmOpen(false);
        }}
      >
        <Modal.Content style={{ backgroundColor: colors.surface1 }}>
          <Text style={[styles.caption, { color: colors.foreground }]}>
            确定删除「{editor?.name.trim() || "该 Prompt"}」吗？删除后无法恢复。
          </Text>
          <View style={styles.modalActions}>
            <ActionButton colors={colors} label="取消" disabled={deleting} onPress={() => setDeleteConfirmOpen(false)} />
            <ActionButton
              colors={colors}
              variant="danger"
              icon="Trash2"
              label={deleting ? "正在删除…" : "确认删除"}
              disabled={deleting}
              testID="prompt-editor-delete-confirm"
              onPress={() => { void confirmDelete(); }}
            />
          </View>
        </Modal.Content>
      </Modal>

      <PromptApplyModal library={library} theme={theme} layout={layout} hostId={hostId} />
    </View>
  );
}
