import { useEffect, useMemo, useState } from "react";
import { Platform, Text, View } from "react-native";
import { copyText, ScrollView } from "@getpaseo/plugin/client/ui";
import { Action, type Colors } from "./controls";
import { codeLines } from "./code-lines";

export function Code({ text, diff, colors, previewLines, compact }: { text: string; diff: boolean; colors: Colors; previewLines: number; compact: boolean }) {
  const [count, setCount] = useState(previewLines);
  const [copy, setCopy] = useState<"idle" | "pending" | "done" | "error">("idle");
  useEffect(() => { setCopy("idle"); }, [text]);
  const lines = useMemo(() => codeLines(text, diff).filter((line) => !diff || line.kind !== "meta" || !/^(?:Index: |={3,}$|--- |\+\+\+ |diff --git |index [0-9a-f])/.test(line.text)), [text, diff]);
  const added = lines.filter((line) => line.kind === "add").length;
  const removed = lines.filter((line) => line.kind === "remove").length;
  const visible = Math.min(count, lines.length);
  const font = { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 12, lineHeight: 20 } as const;
  const digits = lines.reduce((max, line) => Math.max(max, String(Math.max(line.old ?? 0, line.next ?? 0)).length), 3);
  const gutter = digits * 8 + 12;
  return <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 6, overflow: "hidden", backgroundColor: colors.surface0 }}>
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", paddingHorizontal: 10, gap: 8,
      backgroundColor: colors.surface1, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{diff ? "DIFF" : "正文 · 相对行号"}</Text>
      {diff ? <View accessibilityLabel={"新增 " + added + " 行，删除 " + removed + " 行"} style={{ flexDirection: "row", gap: 8 }}>
        <Text style={{ ...font, fontSize: 11, color: colors.statusSuccess }}>+{added}</Text>
        <Text style={{ ...font, fontSize: 11, color: colors.statusDanger }}>−{removed}</Text>
      </View> : <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{lines.length} 行</Text>}
      <View style={{ flex: 1 }} />
      <Action colors={colors} compact={compact} label={diff ? "复制完整差异" : "复制完整正文"} text={copy === "done" ? "已复制" : "复制"}
        icon={copy === "done" ? "Check" : "Copy"} disabled={copy === "pending"} onPress={() => {
          setCopy("pending"); void copyText(text).then(() => setCopy("done"), () => setCopy("error"));
        }} />
    </View>
    <ScrollView nestedScrollEnabled style={{ maxHeight: compact ? 280 : 380 }} accessibilityLabel={diff ? "差异内容" : "文件正文"}>
      <ScrollView horizontal contentContainerStyle={{ minWidth: "100%" }}>
        <View style={{ minWidth: "100%", paddingVertical: 6 }}>
          {lines.slice(0, count).map((line, index) => {
            const changed = line.kind === "add" || line.kind === "remove";
            const tone = line.kind === "add" ? colors.statusSuccess : line.kind === "remove" ? colors.statusDanger : colors.accent;
            return <View key={index} testID={"code-line-" + index} style={{ flexDirection: "row", minHeight: 20 }}>
              {changed || line.kind === "hunk" ? <View pointerEvents="none" style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0,
                backgroundColor: tone, opacity: line.kind === "hunk" ? 0.05 : 0.09 }} /> : null}
              {diff ? <Text accessible={false} style={{ ...font, width: gutter, paddingRight: 8, textAlign: "right", color: colors.foregroundMuted }}>{line.old ?? ""}</Text> : null}
              <Text accessible={false} style={{ ...font, width: gutter, paddingRight: 8, textAlign: "right",
                color: colors.foregroundMuted, borderRightWidth: 1, borderRightColor: colors.border }}>{line.next ?? ""}</Text>
              {diff ? <Text accessible={false} style={{ ...font, width: 22, textAlign: "center", color: changed ? tone : colors.foregroundMuted }}>
                {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : ""}
              </Text> : null}
              <Text selectable style={{ ...font, flexShrink: 0, paddingLeft: diff ? 0 : 10, paddingRight: 16,
                color: line.kind === "hunk" ? colors.accent : line.kind === "meta" ? colors.foregroundMuted : colors.foreground }}>
                {diff && ["add", "remove", "context"].includes(line.kind) ? line.text.slice(1) : line.text || " "}
              </Text>
            </View>;
          })}
          {!lines.length ? <Text style={{ ...font, paddingHorizontal: 12, color: colors.foregroundMuted }}>（空正文）</Text> : null}
        </View>
      </ScrollView>
    </ScrollView>
    {visible < lines.length ? <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center",
      borderTopWidth: 1, borderTopColor: colors.border, paddingHorizontal: 10 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{visible} / {lines.length} 行</Text>
      <Action colors={colors} compact={compact} label="继续显示" text={"再显示 " + Math.min(previewLines, lines.length - visible) + " 行"}
        icon="ChevronDown" onPress={() => setCount((value) => value + previewLines)} />
    </View> : null}
    {copy === "error" ? <Text accessibilityLiveRegion="polite" style={{ color: colors.statusDanger, fontSize: 12, padding: 8 }}>复制失败，请重试或选择正文复制。</Text> : null}
  </View>;
}
