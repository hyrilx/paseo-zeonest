import { createElement, useEffect, useRef, useState } from "react";
import { PanResponder, Platform, StyleSheet, Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import * as rpc from "../shared/contracts";
import type { Log, Run } from "../shared/contracts";
import { Badge, Button, Caption, Choice, Code, Heading, PaneHead, Region, Tab, Tabs, errorMessage, labels, styles } from "./panel-ui.tsx";
import type { Colors } from "./panel-ui.tsx";
import { limitDock } from "./workbench-state";
import { RunOutput } from "./run-output.tsx";
import type { OutputView } from "./output-state";

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
    style: { minHeight: 13, flexShrink: 0, cursor: "ns-resize", touchAction: "none", boxSizing: "border-box",
      display: "grid", placeItems: "center", background: colors.surface1, borderBlock: `1px solid ${colors.border}` },
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
    style={[local.handle, { backgroundColor: colors.surface1, borderColor: colors.border }]}>
    <View style={[local.grip, { backgroundColor: colors.foregroundMuted }]} />
  </View>;
}

const statusTone = (run: Run) => run.status === "failed" ? "danger" : run.status === "success" ? "success" : undefined;

export function RunDock({ colors, workspaceId, height, navWidth, tight, runs, id, select, tab, setTab, update, connection, busy, retry, stop }: {
  colors: Colors; workspaceId: string; height: number; navWidth: number; tight: boolean; runs: Run[]; id: string; select(id: string): void; tab: DetailTab;
  setTab(tab: DetailTab): void; update: number; connection: string; busy: boolean; retry(): void; stop(): void;
}) {
  const current = runs.find((run) => run.id === id);
  const views = useRef(new Map<string, OutputView>());
  useEffect(() => {
    const kept = new Set(runs.map((run) => run.id));
    for (const key of views.current.keys()) if (!kept.has(key)) views.current.delete(key);
  }, [runs]);
  return <View style={[local.dock, { height }]}>
    <View style={[styles.frame, { width: navWidth, borderColor: colors.border, backgroundColor: colors.surface1 }]}>
      <PaneHead colors={colors} bar><View style={styles.inline}><Heading colors={colors}>运行记录</Heading><Badge colors={colors}>{runs.length}</Badge></View></PaneHead>
      <Region label="运行记录" content={local.history}>
        {connection ? <Caption colors={colors} tone="warning">历史刷新失败，保留上次结果：{connection}</Caption> : null}
        {runs.length === 0 ? <Caption colors={colors}>还没有运行记录。</Caption> : null}
        {runs.map((run) => <Choice key={run.id} colors={colors} active={id === run.id} onPress={() => select(run.id)}>
          {!tight ? <Icon name={run.operation === "probe" ? "FlaskConical" : "Box"} size={14} color={colors.foregroundMuted} /> : null}
          <View style={local.historyLine}>
            <Text style={[styles.wrapText, styles.mono, local.historyName, { color: colors.foreground }]}>{run.configuration.target.name}</Text>
            <View style={local.historyMeta}>
              <Caption colors={colors}>#{run.sequence}{tight ? "" : ` · ${new Date(run.createdAt).toLocaleTimeString()}`}</Caption>
              <Badge colors={colors} tone={statusTone(run)}>{labels[run.status]}</Badge>
            </View>
          </View>
        </Choice>)}
      </Region>
    </View>
    {current ? <RunDetail key={current.id} run={current} {...{ colors, workspaceId, height, tight, update, busy, retry, stop, tab, setTab }} views={views.current} />
      : <View style={styles.pane}><PaneHead colors={colors} bar><DetailTabs {...{ colors, tight, tab, setTab }} /></PaneHead>
        <Region label="运行详情"><Caption colors={colors}>运行后，在左侧选择记录查看详情。</Caption></Region></View>}
  </View>;
}

function DetailTabs({ colors, tight, tab, setTab }: { colors: Colors; tight: boolean; tab: DetailTab; setTab(tab: DetailTab): void }) {
  return <Tabs label="运行详情">
    <Tab colors={colors} label="输出" icon={tight ? undefined : "SquareTerminal"} tight={tight} active={tab === "output"} onPress={() => setTab("output")} />
    <Tab colors={colors} label="产物" tight={tight} active={tab === "artifacts"} onPress={() => setTab("artifacts")} />
  </Tabs>;
}

function RunDetail({ colors, workspaceId, height, tight, run: current, update, busy, retry, stop, tab, setTab, views }: {
  colors: Colors; workspaceId: string; height: number; tight: boolean; run: Run; update: number; busy: boolean; retry(): void; stop(): void; tab: DetailTab; setTab(tab: DetailTab): void;
  views: Map<string, OutputView>;
}) {
  const { id } = current;
  const [view] = useState<OutputView>(() => views.get(id) ?? { open: false });
  useEffect(() => { views.set(id, view); }, [views, id, view]);
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
    <PaneHead colors={colors} bar>
      <DetailTabs {...{ colors, tight, tab, setTab }} />
      <View style={styles.inline}>
        {rpc.live(run.status) ? <Button colors={colors} small icon={tight ? undefined : "Square"} label={run.status === "queued" ? "移出队列" : "停止"} disabled={busy || run.status === "stopping"} onPress={stop} /> : null}
        {rpc.retryable(run.status) ? <Button colors={colors} small icon={tight ? undefined : "RotateCcw"} label="重试" disabled={busy || run.endedAt === undefined} onPress={retry} /> : null}
        <Caption colors={colors}>#{run.sequence}</Caption>
        {!tight ? <Badge colors={colors} tone={statusTone(run)}>{run.operation === "probe" ? "探测" : "构建"} · {labels[run.status]}</Badge> : null}
      </View>
    </PaneHead>
    {tab === "output" ? <RunOutput {...{ colors, run, rows, failure, trimmed, height, tight, view }} /> : <Region label="运行产物">
      {failure ? <Caption colors={colors} tone="warning">详情刷新失败，保留上次结果：{failure}</Caption> : null}
      {run.result ? <Caption colors={colors} tone={run.status === "failed" ? "danger" : undefined}>{run.result}</Caption> : null}
      <Caption colors={colors}>观察路径比较运行前后的状态。文件存在不代表由本次运行产生。</Caption>
      {snapshot?.artifactsLimited ? <Caption colors={colors} tone="warning">已达到扫描上限，仅显示部分结果。</Caption> : null}
      {snapshot?.artifacts.length ? snapshot.artifacts.map((a) => <Code key={a.path} colors={colors}>{a.origin === "hint" ? "线索" : a.origin === "native" ? "工具报告" : assetLabels[a.state]} · {a.path}</Code>)
        : <Caption colors={colors}>{rpc.live(run.status) ? "运行结束后查看产物" : snapshot ? "没有可展示的产物记录" : "正在读取产物"}</Caption>}
    </Region>}
  </View>;
}

const local = StyleSheet.create({
  handle: { minHeight: 13, flexShrink: 0, borderTopWidth: 1, borderBottomWidth: 1, alignItems: "center", justifyContent: "center" },
  grip: { width: 28, height: 3, borderRadius: 2 },
  dock: { flexDirection: "row", minWidth: 0, flexShrink: 0 },
  history: { padding: 5, gap: 2 },
  historyLine: { flex: 1, minWidth: 0, flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 3 },
  historyName: { fontWeight: "700", lineHeight: 17 },
  historyMeta: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 4 },
});
