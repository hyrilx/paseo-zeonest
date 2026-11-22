import { createElement, useEffect, useRef, useState } from "react";
import { PanResponder, Platform, StyleSheet, Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import * as rpc from "../shared/contracts";
import type { Log, Run } from "../shared/contracts";
import { Button, Caption, Choice, Code, CommandPreview, Heading, PaneHead, Region, errorMessage, labels, styles } from "./panel-ui.tsx";
import type { Colors } from "./panel-ui.tsx";
import { limitDock } from "./workbench-state";

export type DetailTab = "output" | "artifacts";
const assetLabels = { new: "新增", changed: "变化", existing: "已有", missing: "缺失", removed: "已移除", unavailable: "无法观察" };

export function ResizeHandle({ colors, height, min, max, set }: { colors: Colors; height: number; min: number; max: number; set(value: number): void }) {
  const origin = useRef(height);
  const resize = (value: number) => set(limitDock(value, min, max));
  const drag = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { origin.current = height; },
    onPanResponderMove: (_, gesture) => resize(origin.current - gesture.dy),
  });
  const pointer = useRef<{ y: number; height: number }>(undefined);
  if (Platform.OS === "web") return createElement("div", {
    "aria-label": "调整运行区高度", "aria-valuemin": min, "aria-valuemax": max, "aria-valuenow": height,
    style: { minHeight: 16, flexShrink: 0, cursor: "ns-resize", touchAction: "none", boxSizing: "border-box",
      display: "grid", placeItems: "center", background: colors.surface2, borderBlock: `1px solid ${colors.border}` },
    role: "separator" as const, tabIndex: 0 as const, "aria-orientation": "horizontal" as const,
    onKeyDown: (event: { key: string; shiftKey: boolean; preventDefault(): void; stopPropagation(): void }) => {
      const step = event.shiftKey ? 64 : 16;
      const next = { ArrowUp: height + step, ArrowDown: height - step, Home: min, End: max }[event.key];
      if (next !== undefined) { event.preventDefault(); event.stopPropagation(); resize(next); }
    },
    // Pointer capture keeps resizing when the pointer leaves the handle.
    onPointerDown: (event: { button: number; pointerId: number; clientY: number; currentTarget: { focus(): void; setPointerCapture(id: number): void }; preventDefault(): void }) => {
      if (event.button !== 0) return;
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      pointer.current = { y: event.clientY, height };
      event.preventDefault();
    },
    onPointerMove: (event: { pointerId: number; clientY: number; currentTarget: { hasPointerCapture(id: number): boolean } }) => {
      if (pointer.current && event.currentTarget.hasPointerCapture(event.pointerId)) resize(pointer.current.height + pointer.current.y - event.clientY);
    },
    onLostPointerCapture: () => { pointer.current = undefined; },
  }, <View style={[local.grip, { backgroundColor: colors.foregroundMuted }]} />);
  return <View {...drag.panHandlers} accessible accessibilityLabel="调整运行区高度"
    accessibilityRole="adjustable" accessibilityValue={{ min, max, now: height }}
    accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
    onAccessibilityAction={(event) => resize(height + (event.nativeEvent.actionName === "increment" ? 16 : -16))}
    style={[local.handle, { backgroundColor: colors.surface2, borderColor: colors.border }]}>
    <View style={[local.grip, { backgroundColor: colors.foregroundMuted }]} />
  </View>;
}

export function RunDock({ colors, workspaceId, height, compact, runs, id, select, tab, setTab, update, connection, busy, retry, stop }: {
  colors: Colors; workspaceId: string; height: number; compact: boolean; runs: Run[]; id: string; select(id: string): void; tab: DetailTab;
  setTab(tab: DetailTab): void; update: number; connection: string; busy: boolean; retry(): void; stop(): void;
}) {
  const current = runs.find((run) => run.id === id);
  return <View style={[local.dock, { height }]}>
    <View style={[styles.frame, local.history, { width: compact ? "36%" : "24%", borderColor: colors.border }]}>
      <PaneHead colors={colors}><Heading colors={colors}>运行历史</Heading></PaneHead>
      <Region label="运行历史">
        {connection ? <Caption colors={colors} tone="warning">历史刷新失败，保留上次结果：{connection}</Caption> : null}
        {runs.length === 0 ? <Caption colors={colors}>还没有运行记录。</Caption> : null}
        {runs.map((run) => <Choice key={run.id} colors={colors} active={id === run.id} onPress={() => select(run.id)}>
          <Text style={[styles.wrapText, { color: colors.foreground }]}>#{run.sequence} {run.configuration.target.name}</Text>
          <Caption colors={colors} tone={run.status === "failed" ? "danger" : run.status === "success" ? "success" : undefined}>
            {labels[run.status]} · {new Date(run.createdAt).toLocaleTimeString()}{"\n"}{run.configuration.target.project}
          </Caption>
        </Choice>)}
      </Region>
    </View>
    {current ? <RunDetail key={current.id} run={current} {...{ colors, workspaceId, update, busy, retry, stop, tab, setTab }} />
      : <View style={styles.pane}><PaneHead colors={colors}><Heading colors={colors}>运行详情</Heading></PaneHead>
        <Region label="运行详情"><Caption colors={colors}>选择一条记录查看输出和产物。</Caption></Region></View>}
  </View>;
}

function RunDetail({ colors, workspaceId, run: current, update, busy, retry, stop, tab, setTab }: {
  colors: Colors; workspaceId: string; run: Run; update: number; busy: boolean; retry(): void; stop(): void; tab: DetailTab; setTab(tab: DetailTab): void;
}) {
  const { id } = current;
  const read = useRpc(rpc.detail);
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof read>>>();
  const [rows, setRows] = useState<Log[]>([]);
  const [trimmed, setTrimmed] = useState(false);
  const [failure, setFailure] = useState("");
  const cursor = useRef(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let delay = 1300;
      try {
        const state = await read({ workspaceId, id, cursor: cursor.current });
        if (cancelled) return;
        cursor.current = state.cursor; setSnapshot(state); setFailure("");
        if (state.truncated || state.cursor > 512) setTrimmed(true);
        if (state.truncated || state.rows.length) setRows((old) => [...(state.truncated ? [] : old), ...state.rows].slice(-512));
        if (state.rows.length === 24) delay = 50;
        else if (state.run.endedAt !== undefined || (!rpc.live(state.run.status) && state.run.status !== "interrupted")) return;
      } catch (error) { if (!cancelled) setFailure(errorMessage(error)); }
      if (!cancelled) timer = setTimeout(poll, delay);
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [read, workspaceId, id, update]);
  const run = snapshot?.run ?? current;
  return <View style={styles.pane}>
    <PaneHead colors={colors}>
      <Heading colors={colors}>#{run.sequence} · {labels[run.status]}</Heading>
      <Button colors={colors} label="输出" active={tab === "output"} onPress={() => setTab("output")} />
      <Button colors={colors} label="产物" active={tab === "artifacts"} onPress={() => setTab("artifacts")} />
      {rpc.live(run.status) ? <Button colors={colors} label={run.status === "queued" ? "移出队列" : "停止"} disabled={busy || run.status === "stopping"} onPress={stop} /> : null}
      {rpc.retryable(run.status) ? <Button colors={colors} label="重试" disabled={busy || run.endedAt === undefined} onPress={retry} /> : null}
    </PaneHead>
    <Region key={tab} label={tab === "output" ? "运行输出" : "运行产物"}>
      {failure ? <Caption colors={colors} tone="warning">详情刷新失败，保留上次结果：{failure}</Caption> : null}
      {run.result ? <Caption colors={colors} tone={run.status === "failed" ? "danger" : undefined}>{run.result}</Caption> : null}
      {tab === "output" ? <>
        {trimmed ? <Caption colors={colors} tone="warning">较早的输出已截断。</Caption> : null}
        <Code colors={colors}>{rows.length ? rows.map((row) => <Text key={row.cursor} style={{ color: row.stream === "stderr" ? colors.foregroundMuted : colors.foreground }}>{row.text}</Text>)
          : rpc.live(run.status) ? "等待输出" : "没有输出"}</Code>
        {run.confirmedTargets?.length ? <Caption colors={colors}>{run.confirmedTargetsLimited ? "已确认（部分）" : "已确认"}：{run.confirmedTargets.join("、")}</Caption> : null}
        <CommandPreview plan={run.command} colors={colors} />
      </> : <>
        <Caption colors={colors}>观察路径比较运行前后的状态。文件存在不代表由本次运行产生。</Caption>
        {snapshot?.artifactsLimited ? <Caption colors={colors} tone="warning">已达到扫描上限，仅显示部分结果。</Caption> : null}
        {snapshot?.artifacts.length ? snapshot.artifacts.map((a) => <Code key={a.path} colors={colors}>{a.origin === "hint" ? "线索" : a.origin === "native" ? "工具报告" : assetLabels[a.state]} · {a.path}</Code>)
          : <Caption colors={colors}>{rpc.live(run.status) ? "运行结束后查看产物" : snapshot ? "没有可展示的产物记录" : "正在读取产物"}</Caption>}
      </>}
    </Region>
  </View>;
}

const local = StyleSheet.create({
  handle: { minHeight: 16, flexShrink: 0, borderTopWidth: 1, borderBottomWidth: 1, alignItems: "center", justifyContent: "center" },
  grip: { width: 32, height: 2, borderRadius: 1 },
  dock: { flexDirection: "row", minWidth: 0, flexShrink: 0 },
  history: { minWidth: 0 },
});
