import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ScrollView as NativeScrollView } from "react-native";
import { Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import { formatArguments } from "../shared/arguments";
import { live } from "../shared/contracts";
import type { Log, Run } from "../shared/contracts";
import { Button, Caption, Code, styles } from "./panel-ui.tsx";
import type { Colors } from "./panel-ui.tsx";
import { isScrollingAway, outputGroups, pausedRows } from "./output-state";
import type { OutputView, PausedOutput } from "./output-state";

export function RunOutput({ colors, run, rows, failure, trimmed, height, tight, view }: {
  colors: Colors; run: Run; rows: Log[]; failure: string; trimmed: boolean; height: number; tight: boolean; view: OutputView;
}) {
  const [open, setOpen] = useState(view.open);
  const [paused, setPaused] = useState<PausedOutput | undefined>(view.paused);
  const visible = useMemo(() => paused ? pausedRows(paused.rows, rows) : rows, [paused, rows]);
  const groups = useMemo(() => outputGroups(visible), [visible]);
  const scroll = useRef<NativeScrollView>(null);
  const restore = useRef(!!view.paused);
  const viewport = useRef(0);
  const content = useRef(0);
  const offset = useRef(0);
  useEffect(() => { if (view.paused) view.paused.rows = visible; }, [view, visible]);
  const position = () => {
    if (viewport.current <= 0 || content.current <= 0) return;
    if (!view.paused) scroll.current?.scrollToEnd({ animated: false });
    else if (restore.current) {
      restore.current = false;
      scroll.current?.scrollTo({ y: Math.min(view.paused.offset, Math.max(0, content.current - viewport.current)), animated: false });
    }
  };
  const resume = () => {
    restore.current = false;
    view.paused = undefined;
    setPaused(undefined);
    position();
  };
  return <View style={styles.pane}>
    <View style={[local.strip, { borderColor: colors.border, backgroundColor: colors.surface1 }]}>
      <View style={[local.controls, tight && local.controlsTight]}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => {
          view.open = !open;
          setOpen(view.open);
        }} style={local.disclosure}>
          <Icon name={open ? "ChevronDown" : "ChevronRight"} size={13} color={colors.foregroundMuted} />
          <Text style={[local.label, { color: colors.foreground }]}>命令预览</Text>
        </Pressable>
        <Button colors={colors} small muted={!paused} label={paused ? "回到底部" : "跟随中"} icon="ArrowDownToLine" onPress={resume} />
      </View>
      {open ? <ScrollView accessibilityLabel="本次运行的命令" style={{ maxHeight: Math.min(76, Math.max(20, height - 110)) }}
        contentContainerStyle={[local.command, tight && local.controlsTight]} nestedScrollEnabled>
        {run.command.preparation?.map((step, index) => <View key={index}>
          <Caption colors={colors}>准备依赖</Caption>
          <Code colors={colors} accent>{formatArguments(step.argv)}</Code>
          <Caption colors={colors}>工作目录：{step.cwd}</Caption>
        </View>)}
        <Code colors={colors} accent>{formatArguments(run.command.argv)}</Code>
        <Caption colors={colors}>工作目录：{run.command.cwd}</Caption>
      </ScrollView> : null}
    </View>
    <ScrollView ref={scroll} accessibilityLabel="运行输出" style={styles.region} contentContainerStyle={local.output}
      scrollEventThrottle={16} nestedScrollEnabled onLayout={(event) => { viewport.current = event.nativeEvent.layout.height; position(); }}
      onContentSizeChange={(_, nextHeight) => { content.current = nextHeight; position(); }}
      onScroll={({ nativeEvent }) => {
        if (restore.current || !viewport.current) return;
        const y = Math.max(0, nativeEvent.contentOffset.y);
        const distance = nativeEvent.contentSize.height - nativeEvent.layoutMeasurement.height - y;
        // A layout change or new bytes can increase distance without the reader scrolling up.
        if (view.paused) view.paused.offset = y;
        else if (isScrollingAway(offset.current, y, distance)) {
          view.paused = { offset: y, rows: visible, trimmed };
          setPaused(view.paused);
        }
        offset.current = y;
      }}>
      {(paused?.trimmed ?? trimmed) ? <Caption colors={colors} tone="warning">较早的输出已截断。</Caption> : null}
      {groups.length ? groups.map((group) => <OutputLine key={group.cursor} {...{ colors, tight }} label={group.stream}>
        <Code colors={colors}>{group.text}</Code>
      </OutputLine>) : <Caption colors={colors}>{live(run.status) ? "等待输出" : "没有输出"}</Caption>}
      {run.confirmedTargets?.length ? <Caption colors={colors}>{run.confirmedTargetsLimited ? "已确认（部分）" : "已确认"}：{run.confirmedTargets.join("、")}</Caption> : null}
      {run.result ? <OutputLine {...{ colors, tight }} label={run.status === "failed" ? "失败" : run.status === "success" ? "完成" : "结果"}>
        <Caption colors={colors} tone={run.status === "failed" ? "danger" : run.status === "success" ? "success" : undefined}>{run.result}</Caption>
      </OutputLine> : null}
      {failure ? <Caption colors={colors} tone="warning">详情刷新失败，保留上次结果：{failure}</Caption> : null}
    </ScrollView>
  </View>;
}

function OutputLine({ label, colors, tight, children }: { label: string; colors: Colors; tight: boolean; children: ReactNode }) {
  return <View style={[local.line, tight && local.lineTight]}>
    <View style={tight ? local.sourceTight : local.source}><Code colors={colors} muted>{label}</Code></View>
    <View style={local.message}>{children}</View>
  </View>;
}

const local = StyleSheet.create({
  strip: { borderBottomWidth: 1, flexShrink: 0 },
  controls: { minHeight: 33, paddingHorizontal: 13, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 4 },
  controlsTight: { paddingHorizontal: 8 },
  disclosure: { minHeight: 32, justifyContent: "center", alignItems: "center", flexDirection: "row", gap: 3 },
  label: { fontSize: 12, lineHeight: 16 },
  command: { paddingHorizontal: 13, paddingBottom: 5, gap: 2 },
  output: { paddingHorizontal: 13, paddingVertical: 5, gap: 1 },
  line: { flexDirection: "row", alignItems: "flex-start", gap: 7 },
  lineTight: { gap: 5 },
  source: { width: 53 },
  sourceTight: { width: 45 },
  message: { flex: 1, minWidth: 0 },
});
