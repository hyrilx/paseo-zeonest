import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView } from "@getpaseo/plugin/client/ui";

export type Colors = PluginSurfaceProps["theme"]["colors"];
type ControlProps = { colors: Colors; compact?: boolean };
export function Action({ label, text = label, icon, selected, disabled, count, onPress, colors, compact, role = "button", align = "center" }: ControlProps & {
  label: string; text?: string; icon?: string; selected?: boolean; disabled?: boolean; count?: number; onPress(): void;
  role?: "button" | "checkbox" | "radio"; align?: "center" | "flex-start";
}) {
  const color = disabled ? colors.foregroundMuted : selected ? colors.accent : colors.foreground;
  return <Pressable accessibilityRole={role} accessibilityLabel={label}
    aria-checked={role === "checkbox" || role === "radio" ? !!selected : undefined} aria-disabled={!!disabled}
    accessibilityState={{ disabled: !!disabled, ...(role === "checkbox" || role === "radio" ? { checked: !!selected } : selected !== undefined ? { selected } : {}) }}
    disabled={disabled} onPress={onPress} style={({ pressed }) => ({
      minHeight: compact ? 44 : 32, minWidth: compact ? 44 : 32, paddingHorizontal: text ? 8 : 6,
      flexDirection: "row", alignItems: "center", justifyContent: align, gap: 5, flexShrink: 1,
      borderRadius: 5, borderWidth: 1, borderColor: selected ? colors.border : "transparent",
      backgroundColor: selected || pressed ? colors.surface2 : "transparent", opacity: disabled ? 0.5 : 1,
    })}>
    {icon ? <Icon name={icon} size={14} color={color} /> : null}
    {text ? <Text numberOfLines={1} style={{ color, fontSize: 12, fontWeight: selected ? "600" : "400", flexShrink: 1 }}>{text}</Text> : null}
    {count !== undefined ? <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>{count}</Text> : null}
  </Pressable>;
}
export function Choices<Value extends string>({ label, value, options, onChange, ...appearance }: ControlProps & {
  label: string; value: Value; options: readonly { label: string; value: Value }[]; onChange(value: Value): void;
}) {
  return <View accessibilityRole="radiogroup" accessibilityLabel={label}
    style={{ flexDirection: "row", backgroundColor: appearance.colors.surface1, borderRadius: 6, padding: 2, flexShrink: 1 }}>
    {options.map((option) => <Action key={option.value} {...appearance} role="radio" label={option.label}
      selected={option.value === value} onPress={() => onChange(option.value)} />)}
  </View>;
}
export function Picker<Value extends string>({ label, value, options, onChange, display, ...appearance }: ControlProps & {
  label: string; value: Value; options: readonly { label: string; value: Value }[]; onChange(value: Value): void; display?: string;
}) {
  const [open, setOpen] = useState(false);
  const colors = appearance.colors;
  return <View style={{ minWidth: 0, flexShrink: 1 }}>
    <Action {...appearance} label={label} text={display ?? options.find((option) => option.value === value)?.label ?? label}
      icon="ChevronsUpDown" align="flex-start" onPress={() => setOpen(true)} />
    {open ? <Modal title={label} open onOpenChange={setOpen}><Modal.Content scrollable={false} contentContainerStyle={{ padding: 8 }}>
      <ScrollView style={{ maxHeight: 400 }}>
        {options.map((option) => <Pressable key={option.value} accessibilityRole="radio" accessibilityLabel={option.label}
          aria-checked={option.value === value} accessibilityState={{ checked: option.value === value }} testID={"file-activity-option-" + option.value}
          onPress={() => { onChange(option.value); setOpen(false); }} style={({ pressed }) => ({
            minHeight: 44, paddingHorizontal: 10, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 8,
            borderRadius: 5, backgroundColor: pressed || option.value === value ? colors.surface2 : "transparent",
          })}>
          <Icon name={option.value === value ? "Check" : "Minus"} size={14} color={option.value === value ? colors.accent : colors.foregroundMuted} />
          <Text style={{ color: colors.foreground, fontSize: 13, flex: 1 }}>{option.label}</Text>
        </Pressable>)}
      </ScrollView>
    </Modal.Content></Modal> : null}
  </View>;
}
