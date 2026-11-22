import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import type { Target } from "../shared/contracts";
import { Button, Caption, Code, styles } from "./panel-ui.tsx";
import type { Colors } from "./panel-ui.tsx";
import { commonOptions } from "./common-options";

export function OptionPicker({ colors, target, context, close, apply }: {
  colors: Colors; target: Target; context: string; close(): void; apply(flags: string[]): void;
}) {
  const [checked, setChecked] = useState<string[]>([]);
  const options = commonOptions(target);
  return <Modal open title="常用选项" onOpenChange={(open) => { if (!open) close(); }}>
    <Modal.Content style={{ backgroundColor: colors.surface1 }} contentContainerStyle={local.content}>
      <View style={local.body}>
        <Caption colors={colors}>勾选后插入到命令选项末尾，保留已有输入。</Caption>
        <View accessibilityLabel={context} style={[local.group, { borderColor: colors.border }]}>
          <View style={[local.legend, { backgroundColor: colors.surface1 }]}><Caption colors={colors}>{context}</Caption></View>
          {options.map(([flag, description]) => {
            const active = checked.includes(flag);
            return <Pressable key={flag} accessibilityRole="checkbox" accessibilityLabel={flag + " · " + description}
              accessibilityState={{ checked: active }} onPress={() => setChecked((old) => old.includes(flag) ? old.filter((item) => item !== flag) : [...old, flag])}
              style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [local.option, (pressed || hovered) && { backgroundColor: colors.surface2 }]}>
              {active ? <View pointerEvents="none" style={[styles.tint, { backgroundColor: colors.accent }]} /> : null}
              <View style={[local.check, { borderColor: active ? colors.accent : colors.foregroundMuted, backgroundColor: active ? colors.accent : "transparent" }]}>
                {active ? <Icon name="Check" size={12} color={colors.accentForeground} /> : null}
              </View>
              <View style={styles.fieldBody}>
                <Code colors={colors}>{flag}</Code>
                <Caption colors={colors}>{description}</Caption>
              </View>
            </Pressable>;
          })}
        </View>
        <View style={[styles.actions, local.actions]}>
          <Button colors={colors} label="取消" onPress={close} />
          <Button colors={colors} label="应用选项" primary disabled={!checked.length} onPress={() => apply(options.map(([flag]) => flag).filter((flag) => checked.includes(flag)))} />
        </View>
      </View>
    </Modal.Content>
  </Modal>;
}

const local = StyleSheet.create({
  content: { padding: 14 },
  body: { gap: 12 },
  group: { position: "relative", borderWidth: 1, borderRadius: 5, padding: 6, paddingTop: 11, marginTop: 7 },
  legend: { position: "absolute", left: 7, top: -9, paddingHorizontal: 5 },
  option: { flexDirection: "row", alignItems: "flex-start", padding: 6, gap: 8, borderRadius: 4, overflow: "hidden" },
  check: { width: 14, height: 14, marginTop: 2, alignItems: "center", justifyContent: "center", borderWidth: 1, borderRadius: 3 },
  actions: { justifyContent: "flex-end" },
});
