import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Modal as NativeModal, Pressable, StyleSheet, Text, View } from "react-native";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { copyText, Icon, Modal as PaseoModal, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import type { PlaceholderDefinition, PromptDraft, PromptRecord, SelectPlaceholder } from "../shared/contracts";
import {
  analyzeTemplate,
  createInitialValues,
  isPlaceholderActive,
  placeholderDisplayName,
  renderPrompt,
  renderPromptSegments,
  resolveSelectItems,
  type PlaceholderSelectValue,
  type PlaceholderValueMap,
  type RenderedLine,
} from "../shared/template";
import type { PromptLibrary } from "./library";
import {
  ActionButton,
  Chip,
  getPlaceholderSwatch,
  isDarkSurface,
  PlaceholderTypeBadge,
  ToggleRow,
  uiStyles,
  type PlaceholderSwatch,
  type ThemeColors,
} from "./ui";

const styles = StyleSheet.create({
  backdropRoot: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  backdropScrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.54)",
  },
  wideDialog: {
    width: "94%",
    maxWidth: 980,
    height: "84%",
    maxHeight: 760,
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
    elevation: 12,
    shadowColor: "#000",
    shadowOpacity: 0.28,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
  },
  pickerDialog: {
    width: "92%",
    maxWidth: 580,
    height: "74%",
    maxHeight: 620,
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
    elevation: 12,
    shadowColor: "#000",
    shadowOpacity: 0.28,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
  },
  dialogHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingHorizontal: 18,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dialogHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
    minWidth: 0,
  },
  dialogTitle: {
    fontSize: 15,
    lineHeight: 21,
    fontWeight: "600",
    flexShrink: 1,
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
  splitBody: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
  },
  configColumn: {
    flex: 1.15,
    minWidth: 0,
    minHeight: 0,
  },
  previewColumn: {
    flex: 0.95,
    minWidth: 0,
    minHeight: 0,
    borderLeftWidth: StyleSheet.hairlineWidth,
  },
  columnHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  columnTitle: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  searchBox: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    minHeight: 36,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 6,
    fontSize: 13,
    lineHeight: 18,
  },
  scrollContent: {
    padding: 16,
    gap: 12,
  },
  promptRow: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 6,
  },
  promptRowHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  promptTitle: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "600",
    flex: 1,
    minWidth: 0,
  },
  promptDesc: {
    fontSize: 12,
    lineHeight: 17,
  },
  tagWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    alignItems: "center",
  },
  stepHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  stepTitleWrap: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  stepTitle: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "600",
  },
  stepSub: {
    fontSize: 12,
    lineHeight: 16,
  },
  accentCard: {
    borderWidth: 1,
    borderLeftWidth: 3,
    borderRadius: 10,
    padding: 12,
    gap: 10,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  cardTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    flex: 1,
    minWidth: 0,
  },
  colorDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    flexShrink: 0,
  },
  cardTitle: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
    flexShrink: 1,
  },
  keyBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 5,
    borderWidth: 1,
  },
  keyMono: {
    fontSize: 11,
    lineHeight: 15,
    fontFamily: "monospace",
    fontWeight: "600",
  },
  customRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  customInput: {
    flex: 1,
    minWidth: 0,
  },
  branchBox: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 8,
    gap: 4,
  },
  branchLabel: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "600",
  },
  branchText: {
    fontSize: 12,
    lineHeight: 17,
  },
  skippedCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    borderWidth: 1,
    borderLeftWidth: 3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    opacity: 0.62,
  },
  legendWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  legendPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
  },
  legendText: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "600",
  },
  previewBox: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 8,
  },
  previewHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  previewLines: {
    gap: 6,
  },
  previewLine: {
    paddingVertical: 1,
  },
  previewOptionalLine: {
    borderLeftWidth: 3,
    borderRadius: 4,
    paddingLeft: 8,
    paddingRight: 6,
    paddingVertical: 3,
  },
  previewText: {
    fontSize: 13.5,
    lineHeight: 22,
  },
  highlightSpan: {
    fontWeight: "600",
    borderRadius: 4,
  },
  fallbackCopyInput: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    minHeight: 100,
    fontSize: 12,
    lineHeight: 18,
    textAlignVertical: "top",
  },
  footer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    flexWrap: "wrap",
  },
  footerButtons: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginLeft: "auto",
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 32,
    paddingHorizontal: 16,
    gap: 10,
  },
  emptyTitle: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "600",
  },
  emptyHint: {
    fontSize: 12,
    lineHeight: 18,
    textAlign: "center",
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
  },
});

function formatSeparatorDisplay(separator: string): string {
  if (separator === "\n") return "换行";
  if (separator === " ") return "空格";
  if (separator === "") return "无间隔符";
  return `「${separator}」`;
}

function summarizePromptPlaceholders(prompt: PromptDraft): string {
  const analysis = analyzeTemplate(prompt.template, prompt.placeholders);
  const count = analysis.effectivePlaceholders.length;
  if (count === 0) return "无占位符";
  const counts: Record<string, number> = {};
  for (const item of analysis.effectivePlaceholders) {
    const label =
      item.type === "select"
        ? item.multiple
          ? "多选"
          : "单选"
        : item.type === "text"
          ? "填空"
          : item.type === "checkbox"
            ? "勾选"
            : "可选行";
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([label, total]) => `${total} ${label}`)
    .join(" · ");
}

function SelectField({
  colors,
  def,
  value,
  onChange,
}: {
  colors: ThemeColors;
  def: SelectPlaceholder;
  value: PlaceholderSelectValue;
  onChange(next: PlaceholderSelectValue): void;
}) {
  const resolved = resolveSelectItems(def, value);

  function toggleOption(option: string) {
    if (!def.multiple) {
      const already = value.selected.includes(option);
      onChange({
        selected: already ? [] : [option],
        customItems: [],
        customText: "",
      });
      return;
    }
    const exists = value.selected.includes(option);
    const nextSelected = exists
      ? value.selected.filter((item) => item !== option)
      : [...value.selected, option];
    onChange({ ...value, selected: nextSelected });
  }

  function addCustomItem() {
    const trimmed = value.customText.trim();
    if (!trimmed) return;
    if (!def.multiple) {
      onChange({ selected: [], customItems: [], customText: trimmed });
      return;
    }
    if (value.customItems.includes(trimmed) || value.selected.includes(trimmed)) {
      onChange({ ...value, customText: "" });
      return;
    }
    onChange({
      ...value,
      customItems: [...value.customItems, trimmed],
      customText: "",
    });
  }

  function removeCustomItem(item: string) {
    onChange({
      ...value,
      customItems: value.customItems.filter((entry) => entry !== item),
    });
  }

  const selectionSummary =
    resolved.length === 0
      ? "未选择（将置空）"
      : resolved.length === 1
        ? "已选 1 项（单选/单项自动省略间隔符）"
        : `已选 ${resolved.length} 项，间隔符 ${formatSeparatorDisplay(def.separator)}`;

  return (
    <View style={{ gap: 8 }}>
      <View style={styles.tagWrap}>
        {def.options.map((option, index) => {
          const selected = value.selected.includes(option);
          return (
            <Chip
              key={`${option}-${index}`}
              colors={colors}
              label={option}
              selected={selected}
              icon={selected ? "Check" : undefined}
              role={def.multiple ? "checkbox" : "radio"}
              testID={`apply-select-${def.key}-opt-${index}`}
              onPress={() => toggleOption(option)}
            />
          );
        })}
        {def.options.length === 0 ? (
          <Text style={[styles.stepSub, { color: colors.foregroundMuted }]}>未配置预置选项</Text>
        ) : null}
      </View>

      {def.allowCustom ? (
        <View style={{ gap: 6 }}>
          {def.multiple && value.customItems.length > 0 ? (
            <View style={styles.tagWrap}>
              {value.customItems.map((item) => (
                <Chip
                  key={item}
                  colors={colors}
                  label={item}
                  selected
                  compact
                  icon="X"
                  onPress={() => removeCustomItem(item)}
                />
              ))}
            </View>
          ) : null}
          <View style={styles.customRow}>
            <TextInput
              testID={`apply-select-${def.key}-custom`}
              accessibilityLabel={`${placeholderDisplayName(def)} 自定义输入`}
              placeholder={def.multiple ? "输入自定义内容（可直接生效或点击添加多项）" : "或直接输入自定义内容（输入后替代预置单选）"}
              placeholderTextColor={colors.foregroundMuted}
              value={value.customText}
              onChangeText={(text) => {
                if (!def.multiple) {
                  onChange({ selected: text.trim() ? [] : value.selected, customItems: [], customText: text });
                } else {
                  onChange({ ...value, customText: text });
                }
              }}
              onSubmitEditing={def.multiple ? addCustomItem : undefined}
              style={[
                uiStyles.inputBox,
                styles.customInput,
                { backgroundColor: colors.surface0, borderColor: colors.border, color: colors.foreground },
              ]}
            />
            {def.multiple ? (
              <ActionButton
                colors={colors}
                small
                icon="Plus"
                label="添加"
                disabled={!value.customText.trim()}
                testID={`apply-select-${def.key}-add-custom`}
                onPress={addCustomItem}
              />
            ) : null}
          </View>
        </View>
      ) : null}

      <Text style={[styles.stepSub, { color: colors.foregroundMuted }]}>{selectionSummary}</Text>
    </View>
  );
}

function HighlightedPreviewBody({
  colors,
  lines,
  plainText,
  swatchMap,
}: {
  colors: ThemeColors;
  lines: readonly RenderedLine[];
  plainText: string;
  swatchMap: ReadonlyMap<string, PlaceholderSwatch>;
}) {
  if (!plainText) {
    return (
      <Text testID="prompt-apply-preview-text" style={[styles.previewText, { color: colors.foregroundMuted }]}>
        （当前渲染结果为空）
      </Text>
    );
  }

  return (
    <View style={styles.previewLines} testID="prompt-apply-preview-text">
      {lines.map((line) => {
        const optKey = line.controllingOptionalKeys[0];
        const optSwatch = optKey ? swatchMap.get(optKey) : undefined;
        const isBlankLine = line.segments.length === 0;

        return (
          <View
            key={line.lineIndex}
            style={[
              styles.previewLine,
              optSwatch
                ? [
                    styles.previewOptionalLine,
                    {
                      borderLeftColor: optSwatch.solid,
                      backgroundColor: optSwatch.lineBg,
                    },
                  ]
                : null,
            ]}
          >
            <Text selectable style={[styles.previewText, { color: colors.foreground }]}>
              {isBlankLine
                ? " "
                : line.segments.map((segment, segIdx) => {
                    if (!segment.placeholderKey) {
                      return <Text key={segIdx}>{segment.text}</Text>;
                    }
                    const swatch = swatchMap.get(segment.placeholderKey);
                    if (!swatch) {
                      return <Text key={segIdx}>{segment.text}</Text>;
                    }
                    return (
                      <Text
                        key={segIdx}
                        testID={`preview-highlight-${segment.placeholderKey}`}
                        style={[
                          styles.highlightSpan,
                          {
                            backgroundColor: swatch.bg,
                            color: swatch.fg,
                          },
                        ]}
                      >
                        {segment.text}
                      </Text>
                    );
                  })}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

export function PromptApplyModal({
  library,
  theme,
  layout,
  hostId,
  onOpenManager,
}: {
  library: PromptLibrary;
  theme: PluginHostProps["theme"];
  layout: PluginHostProps["layout"];
  hostId: string;
  onOpenManager?: () => void;
}) {
  const { colors } = theme;
  const dark = useMemo(() => isDarkSurface(colors.surface0), [colors.surface0]);
  const toast = useToast();
  const modalState = useSyncExternalStore(library.subscribeModal, library.getModalState, library.getModalState);
  const listState = useSyncExternalStore(library.subscribeList, library.getListState, library.getListState);

  const [query, setQuery] = useState("");
  const [selectedPrompt, setSelectedPrompt] = useState<PromptDraft | null>(null);
  const [cameFromPicker, setCameFromPicker] = useState(true);
  const [values, setValues] = useState<PlaceholderValueMap>({});
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [copySucceeded, setCopySucceeded] = useState(false);

  const isOwner = modalState.activeHostId === hostId;
  const open = isOwner && modalState.open;

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCopyError(null);
    setCopySucceeded(false);
    if (modalState.draftOverride) {
      const analysis = analyzeTemplate(modalState.draftOverride.template, modalState.draftOverride.placeholders);
      setSelectedPrompt(modalState.draftOverride);
      setCameFromPicker(false);
      setValues(createInitialValues(analysis.effectivePlaceholders));
      return;
    }
    if (modalState.initialPromptId) {
      const found = listState.prompts.find((item) => item.id === modalState.initialPromptId);
      if (found) {
        const analysis = analyzeTemplate(found.template, found.placeholders);
        setSelectedPrompt(found);
        setCameFromPicker(false);
        setValues(createInitialValues(analysis.effectivePlaceholders));
        return;
      }
    }
    setSelectedPrompt(null);
    setCameFromPicker(true);
    setValues({});
    void library.refresh().catch(() => {});
  }, [open, modalState.requestId]);

  const filteredPrompts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return listState.prompts;
    return listState.prompts.filter((item) => {
      const haystack = `${item.name}\n${item.description}\n${item.tags.join(" ")}\n${item.template}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [listState.prompts, query]);

  const analysis = useMemo(() => {
    if (!selectedPrompt) return null;
    return analyzeTemplate(selectedPrompt.template, selectedPrompt.placeholders);
  }, [selectedPrompt]);

  const swatchMap = useMemo(() => {
    const map = new Map<string, PlaceholderSwatch>();
    if (!analysis) return map;
    analysis.effectivePlaceholders.forEach((def, index) => {
      map.set(def.key, getPlaceholderSwatch(index, dark));
    });
    return map;
  }, [analysis, dark]);

  const renderedResult = useMemo(() => {
    if (!selectedPrompt) return { text: "", lines: [] as readonly RenderedLine[] };
    return renderPromptSegments(selectedPrompt.template, selectedPrompt.placeholders, values);
  }, [selectedPrompt, values]);

  function selectPromptForApply(prompt: PromptRecord) {
    const parsed = analyzeTemplate(prompt.template, prompt.placeholders);
    setSelectedPrompt(prompt);
    setCameFromPicker(true);
    setValues(createInitialValues(parsed.effectivePlaceholders));
    setCopyError(null);
    setCopySucceeded(false);
  }

  function resetToDefaults() {
    if (!analysis) return;
    setValues(createInitialValues(analysis.effectivePlaceholders));
    setCopyError(null);
  }

  async function applyText(text: string) {
    if (copying) return;
    setCopying(true);
    setCopyError(null);
    try {
      await copyText(text);
      setCopySucceeded(true);
      toast.show("Prompt 已复制到剪贴板，可直接粘贴到对话框", { variant: "success" });
      library.closeApplyModal();
    } catch (error) {
      const message = error instanceof Error ? error.message : "剪贴板不可用";
      setCopyError(`无法写入剪贴板（${message}），请在下方手动全选复制。`);
      toast.error("复制到剪贴板失败");
    } finally {
      setCopying(false);
    }
  }

  if (!open) return null;

  const title = selectedPrompt ? `配置 Prompt：${selectedPrompt.name}` : "插入 Prompt";
  const activePlaceholders = analysis
    ? analysis.effectivePlaceholders.filter((def) => isPlaceholderActive(def.key, analysis, values))
    : [];
  const activeCount = activePlaceholders.length;
  const twoColumn = !layout.compact && selectedPrompt !== null;

  const pickerBody = (
    <>
      <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
        <View style={[styles.searchBox, { backgroundColor: colors.surface1, borderColor: colors.border }]}>
          <Icon name="Search" size={15} color={colors.foregroundMuted} />
          <TextInput
            testID="prompt-apply-search"
            accessibilityLabel="搜索 Prompt"
            placeholder="搜索 Prompt 名称、标签或内容…"
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
              variant="ghost"
              small
              iconOnly
              icon="X"
              accessibilityLabel="清除搜索"
              onPress={() => setQuery("")}
            />
          ) : null}
        </View>
        <ActionButton
          colors={colors}
          variant="ghost"
          iconOnly
          icon="RefreshCw"
          accessibilityLabel="刷新 Prompt 列表"
          disabled={listState.status === "loading"}
          onPress={() => { void library.refresh().catch(() => {}); }}
        />
      </View>

      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scrollContent}>
        {listState.status === "error" ? (
          <View style={[styles.errorBanner, { backgroundColor: colors.surface1, borderColor: colors.statusDanger }]}>
            <Text style={[styles.promptDesc, { color: colors.statusDanger, flex: 1 }]}>
              {listState.error ?? "读取 Prompt 列表失败"}
            </Text>
            <ActionButton
              colors={colors}
              small
              label="重试"
              icon="RefreshCw"
              onPress={() => { void library.refresh().catch(() => {}); }}
            />
          </View>
        ) : null}

        {listState.status === "loading" && listState.prompts.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={[styles.emptyHint, { color: colors.foregroundMuted }]}>正在读取 Prompt 模板…</Text>
          </View>
        ) : filteredPrompts.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
              {query ? "没有匹配的 Prompt" : "还没有可用的 Prompt 模板"}
            </Text>
            <Text style={[styles.emptyHint, { color: colors.foregroundMuted }]}>
              {query ? "试试更换搜索关键词，或在管理器中新建模板。" : "可在侧边栏的「Prompt 管理器」中创建带占位符的模板。"}
            </Text>
            {onOpenManager ? (
              <ActionButton
                colors={colors}
                variant="primary"
                icon="Plus"
                label="打开 Prompt 管理器"
                onPress={() => {
                  library.closeApplyModal();
                  onOpenManager();
                }}
              />
            ) : null}
          </View>
        ) : (
          filteredPrompts.map((prompt) => {
            const summary = summarizePromptPlaceholders(prompt);
            const hasPlaceholders = summary !== "无占位符";
            return (
              <Pressable
                key={prompt.id}
                testID={`prompt-picker-item-${prompt.id}`}
                accessibilityRole="button"
                accessibilityLabel={`选择 Prompt：${prompt.name}`}
                onPress={() => selectPromptForApply(prompt)}
                style={({ pressed }) => [
                  styles.promptRow,
                  {
                    backgroundColor: pressed ? colors.surface2 : colors.surface1,
                    borderColor: colors.border,
                  },
                ]}
              >
                <View style={styles.promptRowHeader}>
                  <Text numberOfLines={1} style={[styles.promptTitle, { color: colors.foreground }]}>
                    {prompt.name}
                  </Text>
                  {!hasPlaceholders ? (
                    <ActionButton
                      colors={colors}
                      small
                      icon="Copy"
                      label="直接复制"
                      onPress={() => { void applyText(renderPrompt(prompt.template, prompt.placeholders, {})); }}
                    />
                  ) : (
                    <Icon name="ChevronRight" size={16} color={colors.foregroundMuted} />
                  )}
                </View>
                {prompt.description ? (
                  <Text numberOfLines={2} style={[styles.promptDesc, { color: colors.foregroundMuted }]}>
                    {prompt.description}
                  </Text>
                ) : null}
                <View style={styles.tagWrap}>
                  <View style={[uiStyles.badge, { backgroundColor: colors.surface2, borderColor: colors.border }]}>
                    <Text style={[uiStyles.badgeText, { color: colors.foregroundMuted }]}>{summary}</Text>
                  </View>
                  {prompt.tags.map((tag) => (
                    <View key={tag} style={[uiStyles.badge, { backgroundColor: colors.surface0, borderColor: colors.border }]}>
                      <Text style={[uiStyles.badgeText, { color: colors.foregroundMuted }]}>#{tag}</Text>
                    </View>
                  ))}
                </View>
              </Pressable>
            );
          })
        )}
      </ScrollView>
    </>
  );

  const placeholderCards = analysis?.effectivePlaceholders.map((def: PlaceholderDefinition) => {
    const active = isPlaceholderActive(def.key, analysis, values);
    const displayName = placeholderDisplayName(def);
    const discovered = analysis.discovered.find((item) => item.key === def.key);
    const swatch = swatchMap.get(def.key) ?? getPlaceholderSwatch(0, dark);

    if (!active) {
      return (
        <View
          key={def.key}
          testID={`apply-skipped-${def.key}`}
          style={[
            styles.skippedCard,
            {
              backgroundColor: colors.surface1,
              borderColor: colors.border,
              borderLeftColor: swatch.border,
            },
          ]}
        >
          <View style={styles.cardTitleRow}>
            <View style={[styles.colorDot, { backgroundColor: swatch.solid }]} />
            <Text numberOfLines={1} style={[styles.cardTitle, { color: colors.foregroundMuted }]}>
              {displayName}
            </Text>
            <PlaceholderTypeBadge colors={colors} type={def.type} multiple={def.type === "select" ? def.multiple : undefined} />
          </View>
          <Text style={[styles.stepSub, { color: colors.foregroundMuted }]}>所属可选行已省略</Text>
        </View>
      );
    }

    return (
      <View
        key={def.key}
        testID={`apply-field-${def.key}`}
        style={[
          styles.accentCard,
          {
            backgroundColor: colors.surface1,
            borderColor: colors.border,
            borderLeftColor: swatch.solid,
          },
        ]}
      >
        <View style={styles.cardHeader}>
          <View style={styles.cardTitleRow}>
            <View style={[styles.colorDot, { backgroundColor: swatch.solid }]} />
            <Text numberOfLines={1} style={[styles.cardTitle, { color: colors.foreground }]}>
              {displayName}
            </Text>
            <View style={[styles.keyBadge, { backgroundColor: swatch.bg, borderColor: swatch.border }]}>
              <Text style={[styles.keyMono, { color: swatch.fg }]}>
                {def.type === "optional-line" ? `{{?${def.key}}}` : `{{${def.key}}}`}
              </Text>
            </View>
          </View>
          <PlaceholderTypeBadge
            colors={colors}
            type={def.type}
            multiple={def.type === "select" ? def.multiple : undefined}
          />
        </View>

        {def.description ? (
          <Text style={[styles.stepSub, { color: colors.foregroundMuted }]}>{def.description}</Text>
        ) : null}

        {def.type === "text" ? (
          <View style={styles.customRow}>
            <TextInput
              testID={`apply-text-${def.key}`}
              accessibilityLabel={displayName}
              placeholder={def.placeholder || "输入内容（留空将置空）"}
              placeholderTextColor={colors.foregroundMuted}
              multiline={def.multiline}
              value={values[def.key] && "text" in values[def.key]! ? (values[def.key] as { text: string }).text : ""}
              onChangeText={(text) => setValues((prev) => ({ ...prev, [def.key]: { text } }))}
              style={[
                uiStyles.inputBox,
                styles.customInput,
                def.multiline ? { minHeight: 82, textAlignVertical: "top" } : null,
                { backgroundColor: colors.surface0, borderColor: colors.border, color: colors.foreground },
              ]}
            />
            {values[def.key] && "text" in values[def.key]! && (values[def.key] as { text: string }).text.length > 0 ? (
              <ActionButton
                colors={colors}
                variant="ghost"
                small
                iconOnly
                icon="X"
                accessibilityLabel={`清空 ${displayName}`}
                onPress={() => setValues((prev) => ({ ...prev, [def.key]: { text: "" } }))}
              />
            ) : null}
          </View>
        ) : null}

        {def.type === "select" ? (
          <SelectField
            colors={colors}
            def={def}
            value={
              values[def.key] && "selected" in values[def.key]!
                ? (values[def.key] as PlaceholderSelectValue)
                : { selected: [], customItems: [], customText: "" }
            }
            onChange={(next) => setValues((prev) => ({ ...prev, [def.key]: next }))}
          />
        ) : null}

        {def.type === "checkbox" ? (
          <View style={{ gap: 8 }}>
            {(() => {
              const checked =
                values[def.key] && "checked" in values[def.key]!
                  ? (values[def.key] as { checked: boolean }).checked
                  : def.defaultChecked;
              return (
                <>
                  <ToggleRow
                    colors={colors}
                    testID={`apply-checkbox-${def.key}`}
                    label={checked ? "已勾选（展开为勾选内容）" : "未勾选（展开为未勾选内容）"}
                    value={checked}
                    onValueChange={(next) => setValues((prev) => ({ ...prev, [def.key]: { checked: next } }))}
                  />
                  <View style={[styles.branchBox, { backgroundColor: colors.surface0, borderColor: colors.border }]}>
                    <Text style={[styles.branchLabel, { color: colors.foregroundMuted }]}>当前将展开为：</Text>
                    <Text style={[styles.branchText, { color: colors.foreground }]}>
                      {(checked ? def.checkedText : def.uncheckedText) || "（空内容）"}
                    </Text>
                  </View>
                </>
              );
            })()}
          </View>
        ) : null}

        {def.type === "optional-line" ? (
          <View style={{ gap: 6 }}>
            {(() => {
              const included =
                values[def.key] && "included" in values[def.key]!
                  ? (values[def.key] as { included: boolean }).included
                  : def.defaultIncluded;
              const linePreview = discovered?.controlledLinePreviews.join(" / ");
              const nestedSummary =
                discovered && discovered.nestedKeys.length > 0
                  ? `行内占位符：${discovered.nestedKeys.map((k) => `{{${k}}}`).join("、")}`
                  : undefined;
              return (
                <ToggleRow
                  colors={colors}
                  testID={`apply-optional-${def.key}`}
                  label={included ? "保留此可选行" : "省略此可选行"}
                  hint={[linePreview, nestedSummary].filter(Boolean).join(" · ") || undefined}
                  value={included}
                  onValueChange={(next) => setValues((prev) => ({ ...prev, [def.key]: { included: next } }))}
                />
              );
            })()}
          </View>
        ) : null}
      </View>
    );
  });

  const colorLegend =
    activePlaceholders.length > 0 ? (
      <View style={[styles.legendWrap, { borderBottomColor: colors.border }]} testID="prompt-apply-color-legend">
        {activePlaceholders.map((def) => {
          const swatch = swatchMap.get(def.key) ?? getPlaceholderSwatch(0, dark);
          return (
            <View key={def.key} style={[styles.legendPill, { backgroundColor: swatch.bg, borderColor: swatch.border }]}>
              <View style={[styles.colorDot, { backgroundColor: swatch.solid }]} />
              <Text style={[styles.legendText, { color: swatch.fg }]}>{placeholderDisplayName(def)}</Text>
            </View>
          );
        })}
      </View>
    ) : null;

  const previewContent = copyError ? (
    <View style={{ gap: 8 }}>
      <Text accessibilityLiveRegion="polite" style={[styles.stepSub, { color: colors.statusDanger }]}>
        {copyError}
      </Text>
      <TextInput
        editable={false}
        multiline
        selectTextOnFocus
        value={renderedResult.text}
        style={[
          styles.fallbackCopyInput,
          { backgroundColor: colors.surface0, borderColor: colors.statusDanger, color: colors.foreground },
        ]}
      />
    </View>
  ) : (
    <HighlightedPreviewBody
      colors={colors}
      lines={renderedResult.lines}
      plainText={renderedResult.text}
      swatchMap={swatchMap}
    />
  );

  const footer = (
    <View style={[styles.footer, { borderTopColor: colors.border, backgroundColor: colors.surface0 }]}>
      <View style={styles.footerRow}>
        <Text style={[styles.stepSub, { color: colors.foregroundMuted, flexShrink: 1 }]}>
          完成后自动复制到剪贴板，可直接粘贴到对话框。
        </Text>
        <View style={styles.footerButtons}>
          <ActionButton colors={colors} label="取消" onPress={() => library.closeApplyModal()} />
          <ActionButton
            colors={colors}
            variant="primary"
            icon={copySucceeded ? "Check" : "Copy"}
            label={copying ? "正在复制…" : "复制到剪贴板"}
            disabled={copying}
            testID="prompt-apply-confirm"
            onPress={() => { void applyText(renderedResult.text); }}
          />
        </View>
      </View>
    </View>
  );

  const configureBody = selectedPrompt ? (
    <>
      <View style={[styles.stepHeader, { borderBottomColor: colors.border }]}>
        {cameFromPicker ? (
          <ActionButton
            colors={colors}
            variant="ghost"
            small
            icon="ChevronLeft"
            label="重选"
            testID="prompt-apply-back"
            onPress={() => {
              setSelectedPrompt(null);
              setCopyError(null);
            }}
          />
        ) : null}
        <View style={styles.stepTitleWrap}>
          <Text numberOfLines={1} style={[styles.stepTitle, { color: colors.foreground }]}>
            {selectedPrompt.name}
          </Text>
          <Text style={[styles.stepSub, { color: colors.foregroundMuted }]}>
            {analysis && analysis.effectivePlaceholders.length > 0
              ? `当前需配置 ${activeCount} / ${analysis.effectivePlaceholders.length} 个占位符 · 右侧高亮颜色与各占位符一一对应`
              : "该 Prompt 不包含占位符，确认后可直接复制"}
          </Text>
        </View>
        {analysis && analysis.effectivePlaceholders.length > 0 ? (
          <ActionButton colors={colors} variant="ghost" small label="重置" onPress={resetToDefaults} />
        ) : null}
      </View>

      {twoColumn ? (
        <View style={styles.splitBody} testID="prompt-apply-split">
          <View style={styles.configColumn} testID="prompt-apply-config-column">
            <View style={[styles.columnHeader, { borderBottomColor: colors.border, backgroundColor: colors.surface0 }]}>
              <Text style={[styles.columnTitle, { color: colors.foreground }]}>占位符配置</Text>
              <Text style={[styles.stepSub, { color: colors.foregroundMuted }]}>{activeCount} 项生效</Text>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scrollContent}>
              {placeholderCards && placeholderCards.length > 0 ? (
                placeholderCards
              ) : (
                <Text style={[styles.stepSub, { color: colors.foregroundMuted }]}>
                  该模板没有可配置的占位符。
                </Text>
              )}
            </ScrollView>
          </View>

          <View
            style={[styles.previewColumn, { borderLeftColor: colors.border, backgroundColor: colors.surface1 }]}
            testID="prompt-apply-preview"
          >
            <View style={[styles.columnHeader, { borderBottomColor: colors.border, backgroundColor: colors.surface1 }]}>
              <Text style={[styles.columnTitle, { color: colors.foreground }]}>最终结果预览</Text>
              <Text style={[styles.stepSub, { color: colors.foregroundMuted }]}>{renderedResult.text.length} 字</Text>
            </View>
            {colorLegend}
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scrollContent}>
              {previewContent}
            </ScrollView>
          </View>
        </View>
      ) : (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scrollContent}>
          {placeholderCards}
          <View
            style={[styles.previewBox, { backgroundColor: colors.surface1, borderColor: colors.border }]}
            testID="prompt-apply-preview"
          >
            <View style={styles.previewHeader}>
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>最终 Prompt 预览</Text>
              <Text style={[styles.stepSub, { color: colors.foregroundMuted }]}>{renderedResult.text.length} 字</Text>
            </View>
            {previewContent}
          </View>
        </ScrollView>
      )}

      {footer}
    </>
  ) : null;

  // Compact layout uses Paseo's native sheet Modal; wide layout uses a centered two-column modal dialog.
  if (layout.compact) {
    return (
      <PaseoModal
        open={open}
        title={title}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) library.closeApplyModal();
        }}
      >
        <PaseoModal.Content scrollable={false} style={{ backgroundColor: colors.surface0 }} contentContainerStyle={{ padding: 0, gap: 0 }}>
          <View style={styles.body} testID="prompt-apply-modal-body">
            {selectedPrompt ? configureBody : pickerBody}
          </View>
        </PaseoModal.Content>
      </PaseoModal>
    );
  }

  return (
    <NativeModal
      visible={open}
      transparent
      animationType="fade"
      onRequestClose={() => library.closeApplyModal()}
    >
      <View style={styles.backdropRoot} accessibilityViewIsModal>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="关闭弹窗"
          onPress={() => library.closeApplyModal()}
          style={styles.backdropScrim}
        />
        <View
          accessibilityRole="none"
          style={[
            selectedPrompt ? styles.wideDialog : styles.pickerDialog,
            { backgroundColor: colors.surface0, borderColor: colors.border },
          ]}
        >
          <View style={[styles.dialogHeader, { borderBottomColor: colors.border }]}>
            <View style={styles.dialogHeaderLeft}>
              <Icon name="Sparkles" size={16} color={colors.accent} />
              <Text numberOfLines={1} style={[styles.dialogTitle, { color: colors.foreground }]}>
                {title}
              </Text>
            </View>
            <ActionButton
              colors={colors}
              variant="ghost"
              small
              iconOnly
              icon="X"
              accessibilityLabel="关闭"
              onPress={() => library.closeApplyModal()}
            />
          </View>
          <View style={styles.body} testID="prompt-apply-modal-body">
            {selectedPrompt ? configureBody : pickerBody}
          </View>
        </View>
      </View>
    </NativeModal>
  );
}
