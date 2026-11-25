import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { PlaceholderType } from "../shared/contracts";

export type ThemeColors = PluginHostProps["theme"]["colors"];

export interface PlaceholderSwatch {
  solid: string;
  fg: string;
  bg: string;
  lineBg: string;
  border: string;
}

const DARK_SWATCHES: readonly PlaceholderSwatch[] = [
  { solid: "#60a5fa", fg: "#93c5fd", bg: "rgba(59,130,246,0.22)", lineBg: "rgba(59,130,246,0.09)", border: "rgba(96,165,250,0.45)" },
  { solid: "#34d399", fg: "#6ee7b7", bg: "rgba(16,185,129,0.22)", lineBg: "rgba(16,185,129,0.09)", border: "rgba(52,211,153,0.45)" },
  { solid: "#fbbf24", fg: "#fde68a", bg: "rgba(245,158,11,0.22)", lineBg: "rgba(245,158,11,0.09)", border: "rgba(251,191,36,0.45)" },
  { solid: "#c084fc", fg: "#d8b4fe", bg: "rgba(168,85,247,0.24)", lineBg: "rgba(168,85,247,0.10)", border: "rgba(192,132,252,0.45)" },
  { solid: "#fb7185", fg: "#fda4af", bg: "rgba(244,63,94,0.22)", lineBg: "rgba(244,63,94,0.09)", border: "rgba(251,113,133,0.45)" },
  { solid: "#2dd4bf", fg: "#5eead4", bg: "rgba(20,184,166,0.22)", lineBg: "rgba(20,184,166,0.09)", border: "rgba(45,212,191,0.45)" },
  { solid: "#fb923c", fg: "#fdba74", bg: "rgba(249,115,22,0.22)", lineBg: "rgba(249,115,22,0.09)", border: "rgba(251,146,60,0.45)" },
  { solid: "#818cf8", fg: "#a5b4fc", bg: "rgba(99,102,241,0.24)", lineBg: "rgba(99,102,241,0.10)", border: "rgba(129,140,248,0.45)" },
];

const LIGHT_SWATCHES: readonly PlaceholderSwatch[] = [
  { solid: "#2563eb", fg: "#1d4ed8", bg: "rgba(37,99,235,0.13)", lineBg: "rgba(37,99,235,0.06)", border: "rgba(37,99,235,0.34)" },
  { solid: "#059669", fg: "#047857", bg: "rgba(5,150,105,0.13)", lineBg: "rgba(5,150,105,0.06)", border: "rgba(5,150,105,0.34)" },
  { solid: "#d97706", fg: "#b45309", bg: "rgba(217,119,6,0.14)", lineBg: "rgba(217,119,6,0.06)", border: "rgba(217,119,6,0.35)" },
  { solid: "#7c3aed", fg: "#6d28d9", bg: "rgba(124,58,237,0.13)", lineBg: "rgba(124,58,237,0.06)", border: "rgba(124,58,237,0.34)" },
  { solid: "#e11d48", fg: "#be123c", bg: "rgba(225,29,72,0.12)", lineBg: "rgba(225,29,72,0.05)", border: "rgba(225,29,72,0.32)" },
  { solid: "#0d9488", fg: "#0f766e", bg: "rgba(13,148,136,0.13)", lineBg: "rgba(13,148,136,0.06)", border: "rgba(13,148,136,0.34)" },
  { solid: "#ea580c", fg: "#c2410c", bg: "rgba(234,88,12,0.13)", lineBg: "rgba(234,88,12,0.06)", border: "rgba(234,88,12,0.34)" },
  { solid: "#4f46e5", fg: "#4338ca", bg: "rgba(79,70,229,0.13)", lineBg: "rgba(79,70,229,0.06)", border: "rgba(79,70,229,0.34)" },
];

export function isDarkSurface(hexOrRgb: string): boolean {
  const hex = hexOrRgb.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const raw = hex[1]!;
    const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
    const r = Number.parseInt(full.slice(0, 2), 16);
    const g = Number.parseInt(full.slice(2, 4), 16);
    const b = Number.parseInt(full.slice(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) < 128;
  }
  const rgb = hexOrRgb.trim().match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) {
    const r = Number(rgb[1]);
    const g = Number(rgb[2]);
    const b = Number(rgb[3]);
    return (0.299 * r + 0.587 * g + 0.114 * b) < 128;
  }
  return true;
}

export function getPlaceholderSwatch(index: number, dark: boolean): PlaceholderSwatch {
  const palette = dark ? DARK_SWATCHES : LIGHT_SWATCHES;
  return palette[((index % palette.length) + palette.length) % palette.length]!;
}

export const PLACEHOLDER_TYPE_META: Record<
  PlaceholderType,
  { label: string; shortLabel: string; icon: string; summary: string }
> = {
  text: {
    label: "填空",
    shortLabel: "填空",
    icon: "Type",
    summary: "应用时输入文本，可留空以置空",
  },
  select: {
    label: "多选 / 单选",
    shortLabel: "多选",
    icon: "List",
    summary: "支持多选或单选、允许自填与自定义间隔符",
  },
  checkbox: {
    label: "勾选",
    shortLabel: "勾选",
    icon: "SquareCheck",
    summary: "勾选与未勾选分别展开为不同内容",
  },
  "optional-line": {
    label: "可选行",
    shortLabel: "可选行",
    icon: "ListTodo",
    summary: "控制整行是否保留，行内可嵌套其他占位符",
  },
};

export const uiStyles = StyleSheet.create({
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minHeight: 36,
    minWidth: 36,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  buttonSmall: {
    minHeight: 30,
    minWidth: 30,
    paddingHorizontal: 9,
    borderRadius: 6,
    gap: 4,
  },
  buttonIconOnly: {
    paddingHorizontal: 0,
  },
  buttonLabel: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
  },
  buttonLabelSmall: {
    fontSize: 12,
    lineHeight: 16,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    minHeight: 32,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipCompact: {
    minHeight: 26,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  chipText: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "500",
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
  },
  badgeText: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "600",
  },
  card: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 10,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    minHeight: 40,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  toggleCopy: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  toggleTitle: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
  },
  toggleHint: {
    fontSize: 12,
    lineHeight: 16,
  },
  switchTrack: {
    width: 38,
    height: 22,
    borderRadius: 11,
    padding: 2,
    justifyContent: "center",
  },
  switchThumb: {
    width: 18,
    height: 18,
    borderRadius: 9,
  },
  fieldWrap: {
    gap: 5,
  },
  fieldLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  fieldLabel: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600",
  },
  fieldHint: {
    fontSize: 12,
    lineHeight: 16,
  },
  inputBox: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    lineHeight: 19,
  },
});

export function ActionButton({
  colors,
  label,
  accessibilityLabel,
  icon,
  variant = "secondary",
  small = false,
  iconOnly = false,
  disabled = false,
  testID,
  onPress,
}: {
  colors: ThemeColors;
  label?: string;
  accessibilityLabel?: string;
  icon?: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  small?: boolean;
  iconOnly?: boolean;
  disabled?: boolean;
  testID?: string;
  onPress(): void;
}) {
  const isPrimary = variant === "primary";
  const isDanger = variant === "danger";
  const isGhost = variant === "ghost";

  const textColor = isPrimary
    ? colors.accentForeground
    : isDanger
      ? colors.statusDanger
      : colors.foreground;

  const iconColor = isPrimary
    ? colors.accentForeground
    : isDanger
      ? colors.statusDanger
      : isGhost
        ? colors.foregroundMuted
        : colors.foreground;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label ?? icon ?? "操作"}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        uiStyles.button,
        small && uiStyles.buttonSmall,
        iconOnly && uiStyles.buttonIconOnly,
        {
          backgroundColor: isPrimary
            ? colors.accent
            : pressed
              ? colors.surface2
              : isGhost
                ? "transparent"
                : colors.surface1,
          borderColor: isPrimary
            ? colors.accent
            : isDanger
              ? colors.statusDanger
              : isGhost
                ? "transparent"
                : colors.border,
          opacity: disabled ? 0.45 : pressed && isPrimary ? 0.88 : 1,
        },
      ]}
    >
      {icon ? <Icon name={icon} size={small ? 14 : 15} color={iconColor} /> : null}
      {!iconOnly && label ? (
        <Text numberOfLines={1} style={[uiStyles.buttonLabel, small && uiStyles.buttonLabelSmall, { color: textColor }]}>
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function Chip({
  colors,
  label,
  selected = false,
  compact = false,
  icon,
  disabled = false,
  role = "button",
  testID,
  onPress,
}: {
  colors: ThemeColors;
  label: string;
  selected?: boolean;
  compact?: boolean;
  icon?: string;
  disabled?: boolean;
  role?: "button" | "checkbox" | "radio";
  testID?: string;
  onPress?(): void;
}) {
  const content = (
    <>
      {icon ? (
        <Icon name={icon} size={13} color={selected ? colors.accentForeground : colors.foregroundMuted} />
      ) : null}
      <Text
        numberOfLines={1}
        style={[
          uiStyles.chipText,
          { color: selected ? colors.accentForeground : colors.foreground },
        ]}
      >
        {label}
      </Text>
    </>
  );

  const baseStyle = [
    uiStyles.chip,
    compact && uiStyles.chipCompact,
    {
      backgroundColor: selected ? colors.accent : colors.surface1,
      borderColor: selected ? colors.accent : colors.border,
      opacity: disabled ? 0.45 : 1,
    },
  ];

  if (!onPress) {
    return <View testID={testID} style={baseStyle}>{content}</View>;
  }

  return (
    <Pressable
      testID={testID}
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityState={role === "button" ? { selected } : { checked: selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        ...baseStyle,
        !selected && pressed ? { backgroundColor: colors.surface2 } : null,
      ]}
    >
      {content}
    </Pressable>
  );
}

export function PlaceholderTypeBadge({
  colors,
  type,
  multiple,
}: {
  colors: ThemeColors;
  type: PlaceholderType;
  multiple?: boolean;
}) {
  const meta = PLACEHOLDER_TYPE_META[type];
  const label = type === "select" ? (multiple === false ? "单选" : "多选") : meta.shortLabel;
  return (
    <View style={[uiStyles.badge, { backgroundColor: colors.surface2, borderColor: colors.border }]}>
      <Icon name={meta.icon} size={11} color={colors.foregroundMuted} />
      <Text style={[uiStyles.badgeText, { color: colors.foregroundMuted }]}>{label}</Text>
    </View>
  );
}

export function ToggleRow({
  colors,
  label,
  hint,
  value,
  disabled = false,
  testID,
  onValueChange,
}: {
  colors: ThemeColors;
  label: string;
  hint?: string;
  value: boolean;
  disabled?: boolean;
  testID?: string;
  onValueChange(next: boolean): void;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      style={({ pressed }) => [
        uiStyles.toggleRow,
        {
          backgroundColor: pressed ? colors.surface2 : colors.surface1,
          borderColor: value ? colors.accent : colors.border,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <View style={uiStyles.toggleCopy}>
        <Text style={[uiStyles.toggleTitle, { color: colors.foreground }]}>{label}</Text>
        {hint ? <Text style={[uiStyles.toggleHint, { color: colors.foregroundMuted }]}>{hint}</Text> : null}
      </View>
      <View
        style={[
          uiStyles.switchTrack,
          {
            backgroundColor: value ? colors.accent : colors.surface2,
            alignItems: value ? "flex-end" : "flex-start",
          },
        ]}
      >
        <View
          style={[
            uiStyles.switchThumb,
            { backgroundColor: value ? colors.accentForeground : colors.foregroundMuted },
          ]}
        />
      </View>
    </Pressable>
  );
}

export function SectionCard({
  colors,
  children,
  highlight = false,
  testID,
}: {
  colors: ThemeColors;
  children: ReactNode;
  highlight?: boolean;
  testID?: string;
}) {
  return (
    <View
      testID={testID}
      style={[
        uiStyles.card,
        {
          backgroundColor: colors.surface1,
          borderColor: highlight ? colors.accent : colors.border,
        },
      ]}
    >
      {children}
    </View>
  );
}
