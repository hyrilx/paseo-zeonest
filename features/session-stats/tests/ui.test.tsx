import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { createStatsStore } from "../client/store";
import { createPreferencesStore } from "../client/preferences";
import { props, SessionStatsDetails } from "./fixtures/host";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const strings = (root: ReactTestRenderer) => JSON.stringify(root.toJSON());
const press = (root: ReactTestRenderer, label: string) => root.root.findAll((node) => String(node.type) === "Pressable" && node.props.accessibilityLabel === label)[0]!;
const ready = { rounds: 4, steps: 9, tools: 12, modelMs: 1500, toolMs: 2300, ttftMs: 600, averageTps: 208, instantTps: 190, partial: false, warning: "", status: "ready" } as const;

for (const compact of [false, true]) for (const light of [false, true]) {
  test(`compact metric-only details follow the theme (compact=${compact}, light=${light})`, async (t) => {
    const source = createStatsStore(); source.set(ready);
    const configuration = createPreferencesStore();
    const theme = light ? { colors: { ...props.theme.colors, foreground: "#111111", foregroundMuted: "#666666" } } : props.theme;
    let root!: ReactTestRenderer;
    await act(async () => { root = create(<SessionStatsDetails {...props} layout={{ ...props.layout, compact }} theme={theme} source={source} configuration={configuration} reloadPreferences={() => {}} retry={() => {}} />); });
    t.after(async () => { await act(async () => root.unmount()); });
    const content = strings(root);
    for (const expected of ["4 轮 9 步", "模型用时", "≈ 1.5 秒", "工具调用用时", "≈ 2.3 秒", "首 token 平均（TTFT）", "≈ 0.6 秒", "输出平均速度（TPS）", "≈ 208 tok/s", "工具调用次数", "12 次", theme.colors.foreground, theme.colors.foregroundMuted]) assert.ok(content.includes(expected), expected);
    const style = root.root.findAll((node) => String(node.type) === "View")[0]!.props.style;
    assert.equal(style.width, compact ? undefined : 300);
    for (const key of ["padding", "paddingHorizontal", "paddingVertical", "backgroundColor", "borderRadius", "borderWidth"]) assert.equal(style[key], undefined, key);
    for (const unwanted of ["统计口径", "本次连接", "—", "ScrollView", "Pressable", "首块", "token 仅估算"]) assert.ok(!content.includes(unwanted), unwanted);
    await act(async () => source.set({ ...source.get(), tools: 13 }));
    assert.match(strings(root), /13 次/);
  });
}

test("unknown metrics are hidden by default; known zero is preserved and missing labels have no fake units", async (t) => {
  const source = createStatsStore();
  const configuration = createPreferencesStore();
  let root!: ReactTestRenderer;
  await act(async () => { root = create(<SessionStatsDetails {...props} source={source} configuration={configuration} reloadPreferences={() => {}} retry={() => {}} />); });
  t.after(async () => { await act(async () => root.unmount()); });
  assert.match(strings(root), /正在读取统计/);
  assert.ok(!strings(root).includes("模型用时"));
  assert.ok(!strings(root).includes("—"));
  await act(async () => source.set({ ...source.get(), status: "ready", toolMs: 0 }));
  assert.match(strings(root), /≈ 0.0 秒/);
  assert.match(strings(root), /0 次/);
  assert.ok(!strings(root).includes("首 token"));
  await act(async () => configuration.set({ ...configuration.get().values, missingValues: "label" }));
  const content = strings(root);
  assert.match(content, /首 token/);
  assert.match(content, /未采集/);
  assert.ok(!content.includes("未采集 tok/s"));
  assert.ok(!content.includes("未采集 秒"));
});

test("display preferences update an already open popup without changing the metric store", async (t) => {
  const source = createStatsStore(); source.set(ready);
  const initial = source.get();
  const configuration = createPreferencesStore();
  let root!: ReactTestRenderer;
  await act(async () => { root = create(<SessionStatsDetails {...props} source={source} configuration={configuration} reloadPreferences={() => {}} retry={() => {}} />); });
  t.after(async () => { await act(async () => root.unmount()); });
  await act(async () => configuration.set({ ...configuration.get().values, showCounts: false, visibleMetrics: ["averageTps"] }));
  assert.match(strings(root), /≈ 208 tok\/s/);
  for (const hidden of ["4 轮", "模型用时", "工具调用次数", "首 token"]) assert.ok(!strings(root).includes(hidden), hidden);
  assert.equal(source.get(), initial);
  await act(async () => configuration.set({ ...configuration.get().values, visibleMetrics: [] }));
  assert.match(strings(root), /未选择统计指标/);
});

test("errors show short retry actions, not measurement explanations or verbose transport errors", async (t) => {
  const source = createStatsStore(); source.set({ ...ready, status: "error", partial: true, warning: "internal transport details" });
  const configuration = createPreferencesStore(); configuration.set(configuration.get().values, "配置读取失败");
  let retries = 0; let reloads = 0;
  let root!: ReactTestRenderer;
  await act(async () => { root = create(<SessionStatsDetails {...props} source={source} configuration={configuration} retry={() => { retries++; }} reloadPreferences={() => { reloads++; }} />); });
  t.after(async () => { await act(async () => root.unmount()); });
  assert.match(strings(root), /4 轮 9 步（部分）/);
  for (const unwanted of ["≥", "internal transport", "统计口径", "本次连接"]) assert.ok(!strings(root).includes(unwanted));
  await act(async () => { press(root, "重新读取会话统计").props.onPress(); press(root, "重新读取统计配置").props.onPress(); });
  assert.equal(retries, 1); assert.equal(reloads, 1);
  assert.equal(press(root, "重新读取会话统计").props.style.minHeight, 44);
});
