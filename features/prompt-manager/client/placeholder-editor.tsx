import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Icon, TextInput } from "@getpaseo/plugin/client/ui";
import type { PlaceholderDefinition, PlaceholderType, SelectPlaceholder } from "../shared/contracts";
import { convertPlaceholderType, placeholderDisplayName, type DiscoveredPlaceholder } from "../shared/template";
import { ActionButton, Chip, PLACEHOLDER_TYPE_META, PlaceholderTypeBadge, SectionCard, ToggleRow, uiStyles, type ThemeColors } from "./ui";

const PLACEHOLDER_TYPES: readonly PlaceholderType[] = ["text", "select", "checkbox", "optional-line"];

const SEPARATOR_PRESETS: readonly { label: string; value: string }[] = [
  { label: "顿号 、", value: "、" },
  { label: "逗号 , ", value: ", " },
  { label: "斜杠 / ", value: " / " },
  { label: "空格", value: " " },
  { label: "换行", value: "\n" },
];

const styles = StyleSheet.create({
  headerPress: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    minHeight: 32,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
    flexShrink: 1,
  },
  keyText: {
    fontSize: 11,
    lineHeight: 15,
    fontFamily: "monospace",
  },
  body: {
    gap: 10,
    paddingTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  rowWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  optionInput: {
    flex: 1,
    minWidth: 0,
  },
  infoBox: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 8,
    gap: 4,
  },
  caption: {
    fontSize: 12,
    lineHeight: 17,
  },
  gridTwo: {
    flexDirection: "row",
    gap: 8,
  },
  flexOne: {
    flex: 1,
    minWidth: 0,
  },
});

function SelectConfigEditor({
  colors,
  def,
  onChange,
}: {
  colors: ThemeColors;
  def: SelectPlaceholder;
  onChange(next: SelectPlaceholder): void;
}) {
  const [newOption, setNewOption] = useState("");

  function updateOption(index: number, nextValue: string) {
    const oldValue = def.options[index];
    const nextOptions = def.options.map((item, idx) => (idx === index ? nextValue : item));
    const nextDefault = def.defaultSelected.map((item) => (item === oldValue ? nextValue : item)).filter(Boolean);
    onChange({ ...def, options: nextOptions, defaultSelected: nextDefault });
  }

  function removeOption(index: number) {
    const removed = def.options[index];
    const nextOptions = def.options.filter((_, idx) => idx !== index);
    const nextDefault = def.defaultSelected.filter((item) => item !== removed);
    onChange({ ...def, options: nextOptions, defaultSelected: nextDefault });
  }

  function moveOption(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= def.options.length) return;
    const nextOptions = [...def.options];
    const current = nextOptions[index]!;
    nextOptions[index] = nextOptions[target]!;
    nextOptions[target] = current;
    onChange({ ...def, options: nextOptions });
  }

  function toggleDefault(option: string) {
    if (!option.trim()) return;
    const exists = def.defaultSelected.includes(option);
    if (!def.multiple) {
      onChange({ ...def, defaultSelected: exists ? [] : [option] });
      return;
    }
    onChange({
      ...def,
      defaultSelected: exists
        ? def.defaultSelected.filter((item) => item !== option)
        : [...def.defaultSelected, option],
    });
  }

  function addOption() {
    const trimmed = newOption.trim();
    if (!trimmed) return;
    onChange({ ...def, options: [...def.options, trimmed] });
    setNewOption("");
  }

  return (
    <View style={{ gap: 10 }}>
      <ToggleRow
        colors={colors}
        testID={`editor-select-multiple-${def.key}`}
        label="允许多选"
        hint={def.multiple ? "多选模式：可选多项并用间隔符拼接；仅选一项时自动省略间隔符" : "单选模式：仅选择一项并省略间隔符"}
        value={def.multiple}
        onValueChange={(multiple) =>
          onChange({
            ...def,
            multiple,
            defaultSelected: multiple ? def.defaultSelected : def.defaultSelected.slice(0, 1),
          })
        }
      />

      <ToggleRow
        colors={colors}
        testID={`editor-select-custom-${def.key}`}
        label="允许自填"
        hint="应用时除预置选项外，也可手动输入自定义内容"
        value={def.allowCustom}
        onValueChange={(allowCustom) => onChange({ ...def, allowCustom })}
      />

      {def.multiple ? (
        <View style={uiStyles.fieldWrap}>
          <View style={styles.rowWrap}>
            <Text style={[uiStyles.fieldLabel, { color: colors.foreground }]}>多选间隔符</Text>
            <Text style={[uiStyles.fieldHint, { color: colors.foregroundMuted }]}>（选中 1 项时自动省略）</Text>
          </View>
          <View style={styles.rowWrap}>
            {SEPARATOR_PRESETS.map((preset) => (
              <Chip
                key={preset.label}
                colors={colors}
                compact
                label={preset.label}
                selected={def.separator === preset.value}
                onPress={() => onChange({ ...def, separator: preset.value })}
              />
            ))}
          </View>
          <TextInput
            testID={`editor-select-separator-${def.key}`}
            accessibilityLabel={`${def.key} 间隔符`}
            placeholder="自定义间隔符，例如：、 或 , "
            placeholderTextColor={colors.foregroundMuted}
            value={def.separator === "\n" ? "\\n" : def.separator}
            onChangeText={(text) => onChange({ ...def, separator: text === "\\n" ? "\n" : text })}
            style={[
              uiStyles.inputBox,
              { backgroundColor: colors.surface0, borderColor: colors.border, color: colors.foreground },
            ]}
          />
        </View>
      ) : null}

      <View style={uiStyles.fieldWrap}>
        <Text style={[uiStyles.fieldLabel, { color: colors.foreground }]}>
          预置选项（点击左侧方块可设为默认选中）
        </Text>
        <View style={{ gap: 6 }}>
          {def.options.map((option, index) => {
            const isDefault = def.defaultSelected.includes(option) && option.length > 0;
            return (
              <View key={index} style={styles.optionRow}>
                <ActionButton
                  colors={colors}
                  small
                  iconOnly
                  variant={isDefault ? "primary" : "ghost"}
                  icon={isDefault ? "SquareCheck" : "Square"}
                  accessibilityLabel={isDefault ? `取消默认选中 ${option}` : `默认选中 ${option}`}
                  onPress={() => toggleDefault(option)}
                />
                <TextInput
                  testID={`editor-select-option-${def.key}-${index}`}
                  accessibilityLabel={`选项 ${index + 1}`}
                  value={option}
                  onChangeText={(value) => updateOption(index, value)}
                  placeholder={`选项 ${index + 1}`}
                  placeholderTextColor={colors.foregroundMuted}
                  style={[
                    uiStyles.inputBox,
                    styles.optionInput,
                    { backgroundColor: colors.surface0, borderColor: colors.border, color: colors.foreground },
                  ]}
                />
                <ActionButton
                  colors={colors}
                  small
                  iconOnly
                  variant="ghost"
                  icon="ArrowUp"
                  accessibilityLabel="上移选项"
                  disabled={index === 0}
                  onPress={() => moveOption(index, -1)}
                />
                <ActionButton
                  colors={colors}
                  small
                  iconOnly
                  variant="ghost"
                  icon="ArrowDown"
                  accessibilityLabel="下移选项"
                  disabled={index === def.options.length - 1}
                  onPress={() => moveOption(index, 1)}
                />
                <ActionButton
                  colors={colors}
                  small
                  iconOnly
                  variant="ghost"
                  icon="Trash2"
                  accessibilityLabel={`删除选项 ${option}`}
                  onPress={() => removeOption(index)}
                />
              </View>
            );
          })}
          <View style={styles.optionRow}>
            <TextInput
              testID={`editor-select-new-option-${def.key}`}
              accessibilityLabel={`为 ${def.key} 新增选项`}
              placeholder="输入新选项内容…"
              placeholderTextColor={colors.foregroundMuted}
              value={newOption}
              onChangeText={setNewOption}
              onSubmitEditing={addOption}
              style={[
                uiStyles.inputBox,
                styles.optionInput,
                { backgroundColor: colors.surface0, borderColor: colors.border, color: colors.foreground },
              ]}
            />
            <ActionButton
              colors={colors}
              small
              icon="Plus"
              label="添加选项"
              disabled={!newOption.trim()}
              testID={`editor-select-add-option-${def.key}`}
              onPress={addOption}
            />
          </View>
        </View>
      </View>
    </View>
  );
}

export function PlaceholderEditorCard({
  colors,
  compact,
  def,
  discovered,
  defaultExpanded = false,
  onChange,
}: {
  colors: ThemeColors;
  compact: boolean;
  def: PlaceholderDefinition;
  discovered?: DiscoveredPlaceholder;
  defaultExpanded?: boolean;
  onChange(next: PlaceholderDefinition): void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const displayName = placeholderDisplayName(def);

  return (
    <SectionCard colors={colors} testID={`placeholder-card-${def.key}`}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`展开或收起占位符 ${displayName}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((prev) => !prev)}
        style={styles.headerPress}
      >
        <View style={styles.headerLeft}>
          <Text numberOfLines={1} style={[styles.title, { color: colors.foreground }]}>
            {displayName}
          </Text>
          <Text style={[styles.keyText, { color: colors.foregroundMuted }]}>
            {def.type === "optional-line" ? `{{?${def.key}}}` : `{{${def.key}}}`}
          </Text>
        </View>
        <PlaceholderTypeBadge
          colors={colors}
          type={def.type}
          multiple={def.type === "select" ? def.multiple : undefined}
        />
        <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={15} color={colors.foregroundMuted} />
      </Pressable>

      {expanded ? (
        <View style={[styles.body, { borderTopColor: colors.border }]}>
          <View style={uiStyles.fieldWrap}>
            <Text style={[uiStyles.fieldLabel, { color: colors.foreground }]}>占位符类型</Text>
            <View style={styles.rowWrap}>
              {PLACEHOLDER_TYPES.map((type) => (
                <Chip
                  key={type}
                  colors={colors}
                  compact
                  icon={PLACEHOLDER_TYPE_META[type].icon}
                  label={PLACEHOLDER_TYPE_META[type].shortLabel}
                  selected={def.type === type}
                  role="radio"
                  testID={`placeholder-type-${def.key}-${type}`}
                  onPress={() => onChange(convertPlaceholderType(def, type))}
                />
              ))}
            </View>
            <Text style={[styles.caption, { color: colors.foregroundMuted }]}>
              {PLACEHOLDER_TYPE_META[def.type].summary}
            </Text>
          </View>

          <View style={compact ? { gap: 8 } : styles.gridTwo}>
            <View style={[uiStyles.fieldWrap, !compact && styles.flexOne]}>
              <Text style={[uiStyles.fieldLabel, { color: colors.foreground }]}>显示名称</Text>
              <TextInput
                testID={`editor-label-${def.key}`}
                accessibilityLabel={`${def.key} 显示名称`}
                placeholder={`默认显示 ${def.key}`}
                placeholderTextColor={colors.foregroundMuted}
                value={def.label}
                onChangeText={(label) => onChange({ ...def, label })}
                style={[
                  uiStyles.inputBox,
                  { backgroundColor: colors.surface0, borderColor: colors.border, color: colors.foreground },
                ]}
              />
            </View>
            <View style={[uiStyles.fieldWrap, !compact && styles.flexOne]}>
              <Text style={[uiStyles.fieldLabel, { color: colors.foreground }]}>引导说明（可选）</Text>
              <TextInput
                testID={`editor-desc-${def.key}`}
                accessibilityLabel={`${def.key} 引导说明`}
                placeholder="填写时的简短提示"
                placeholderTextColor={colors.foregroundMuted}
                value={def.description}
                onChangeText={(description) => onChange({ ...def, description })}
                style={[
                  uiStyles.inputBox,
                  { backgroundColor: colors.surface0, borderColor: colors.border, color: colors.foreground },
                ]}
              />
            </View>
          </View>

          {def.type === "text" ? (
            <View style={{ gap: 8 }}>
              <View style={uiStyles.fieldWrap}>
                <Text style={[uiStyles.fieldLabel, { color: colors.foreground }]}>默认值（应用时可留空置空）</Text>
                <TextInput
                  testID={`editor-text-default-${def.key}`}
                  accessibilityLabel={`${def.key} 默认值`}
                  placeholder="留空表示默认空值"
                  placeholderTextColor={colors.foregroundMuted}
                  multiline={def.multiline}
                  value={def.defaultValue}
                  onChangeText={(defaultValue) => onChange({ ...def, defaultValue })}
                  style={[
                    uiStyles.inputBox,
                    def.multiline ? { minHeight: 68, textAlignVertical: "top" } : null,
                    { backgroundColor: colors.surface0, borderColor: colors.border, color: colors.foreground },
                  ]}
                />
              </View>
              <View style={uiStyles.fieldWrap}>
                <Text style={[uiStyles.fieldLabel, { color: colors.foreground }]}>输入提示（Placeholder）</Text>
                <TextInput
                  testID={`editor-text-placeholder-${def.key}`}
                  accessibilityLabel={`${def.key} 输入提示`}
                  placeholder="例如：请输入模块名或文件路径"
                  placeholderTextColor={colors.foregroundMuted}
                  value={def.placeholder}
                  onChangeText={(placeholder) => onChange({ ...def, placeholder })}
                  style={[
                    uiStyles.inputBox,
                    { backgroundColor: colors.surface0, borderColor: colors.border, color: colors.foreground },
                  ]}
                />
              </View>
              <ToggleRow
                colors={colors}
                label="多行输入"
                hint="适合需要粘贴较长文本或代码片段的填空项"
                value={def.multiline}
                onValueChange={(multiline) => onChange({ ...def, multiline })}
              />
            </View>
          ) : null}

          {def.type === "select" ? (
            <SelectConfigEditor colors={colors} def={def} onChange={onChange} />
          ) : null}

          {def.type === "checkbox" ? (
            <View style={{ gap: 8 }}>
              <ToggleRow
                colors={colors}
                testID={`editor-checkbox-default-${def.key}`}
                label="默认勾选"
                hint="应用该 Prompt 时该开关的初始状态"
                value={def.defaultChecked}
                onValueChange={(defaultChecked) => onChange({ ...def, defaultChecked })}
              />
              <View style={uiStyles.fieldWrap}>
                <Text style={[uiStyles.fieldLabel, { color: colors.foreground }]}>勾选时展开内容</Text>
                <TextInput
                  testID={`editor-checkbox-checked-${def.key}`}
                  accessibilityLabel={`${def.key} 勾选时展开内容`}
                  placeholder="勾选后替换到 Prompt 中的文本"
                  placeholderTextColor={colors.foregroundMuted}
                  multiline
                  value={def.checkedText}
                  onChangeText={(checkedText) => onChange({ ...def, checkedText })}
                  style={[
                    uiStyles.inputBox,
                    { minHeight: 64, textAlignVertical: "top", backgroundColor: colors.surface0, borderColor: colors.border, color: colors.foreground },
                  ]}
                />
              </View>
              <View style={uiStyles.fieldWrap}>
                <Text style={[uiStyles.fieldLabel, { color: colors.foreground }]}>未勾选时展开内容</Text>
                <TextInput
                  testID={`editor-checkbox-unchecked-${def.key}`}
                  accessibilityLabel={`${def.key} 未勾选时展开内容`}
                  placeholder="未勾选时替换的文本（可留空）"
                  placeholderTextColor={colors.foregroundMuted}
                  multiline
                  value={def.uncheckedText}
                  onChangeText={(uncheckedText) => onChange({ ...def, uncheckedText })}
                  style={[
                    uiStyles.inputBox,
                    { minHeight: 64, textAlignVertical: "top", backgroundColor: colors.surface0, borderColor: colors.border, color: colors.foreground },
                  ]}
                />
              </View>
            </View>
          ) : null}

          {def.type === "optional-line" ? (
            <View style={{ gap: 8 }}>
              <ToggleRow
                colors={colors}
                testID={`editor-optional-default-${def.key}`}
                label="默认包含此行"
                hint="取消勾选时将移除整行并自动跳过仅属于该行的子占位符"
                value={def.defaultIncluded}
                onValueChange={(defaultIncluded) => onChange({ ...def, defaultIncluded })}
              />
              <View style={[styles.infoBox, { backgroundColor: colors.surface0, borderColor: colors.border }]}>
                <Text style={[uiStyles.fieldLabel, { color: colors.foregroundMuted }]}>控制行预览</Text>
                <Text style={[styles.caption, { color: colors.foreground }]}>
                  {discovered && discovered.controlledLinePreviews.length > 0
                    ? discovered.controlledLinePreviews.join("\n")
                    : `在模板行首添加 {{?${def.key}}} 即可控制整行显示或省略`}
                </Text>
                {discovered && discovered.nestedKeys.length > 0 ? (
                  <Text style={[styles.caption, { color: colors.foregroundMuted }]}>
                    行内嵌套占位符：{discovered.nestedKeys.map((key) => `{{${key}}}`).join("、")}
                  </Text>
                ) : null}
              </View>
            </View>
          ) : null}
        </View>
      ) : null}
    </SectionCard>
  );
}
