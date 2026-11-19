import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { PluginAgentPanelContribution, PluginClientContext, SettingsState } from "@getpaseo/plugin/client";
import { preferencesSchema } from "../shared/settings";
import { createTimelineStore, type TimelineStore } from "../client/timeline";
import { ActivityView, FileActivityPanel, panelProps, registerFileActivity, setPaseo, setSettingsState } from "./fixtures/host";
import { button, pick, picker } from "./fixtures/interactions";
import { deferred, fakeAgent, flush, page, record, tool, user } from "./fixtures/timeline";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const defaults = preferencesSchema.parse({});
const control = (root: ReactTestRenderer, type: string, label: string) => root.root.findAll((node) => String(node.type) === type && node.props.label === label)[0]!;

const data = (root: ReactTestRenderer) => root.root.findAll((node) => String(node.type) === "FlatList")[0]!.props.data as { path: string }[];
const initial = () => [user(1, "first", "第一项任务"), record(tool("r", { type: "read", filePath: "a", offset: 2, limit: 3, content: "read" }), 2, "first"),
  user(3, "second", "第二项任务"), record(tool("e", { type: "edit", filePath: "z", oldString: "old", newString: "new" }), 4, "second")];
const ready = (): Extract<SettingsState<typeof preferencesSchema>, { status: "ready" }> => ({ status: "ready", values: defaults, revision: "r1", saving: false, saveError: null,
  save: async () => true, reset: async () => true, reload: async () => {} });
async function render(source: TimelineStore, props = panelProps()) {
  let root!: ReactTestRenderer;
  await act(async () => { root = create(<ActivityView {...props} source={source} defaults={defaults} retry={() => {}} />); });
  return root;
}
const sourceWithRecords = () => { const source = createTimelineStore(); source.set({ records: initial(), status: "ready", partial: false, warning: "" }); return source; };

test("latest tracks new turns, manual holds the selection and all covers loaded conversation", async (t) => {
  const source = sourceWithRecords(); const props = panelProps(); let saved: unknown;
  props.tab.setState = (value) => { saved = value; };
  const root = await render(source, props); t.after(async () => { await act(async () => root.unmount()); });
  assert.deepEqual(data(root).map((item) => item.path), ["z"]);
  await act(async () => source.set({ ...source.get(), records: [...initial(), user(5, "third"), record(tool("n", { type: "read", filePath: "new" }), 6, "third")] }));
  assert.deepEqual(data(root).map((item) => item.path), ["new"]);
  await act(async () => button(root, "手动选轮").props.onPress());
  await pick(root, "轮次", "first");
  await act(async () => source.set({ ...source.get(), records: [...source.get().records, user(7, "fourth")] }));
  assert.deepEqual(data(root).map((item) => item.path), ["a"]);
  await act(async () => button(root, "下一轮").props.onPress());
  assert.deepEqual(data(root).map((item) => item.path), ["z"]);
  await act(async () => button(root, "上一轮").props.onPress());
  await act(async () => button(root, "全会话").props.onPress());
  assert.equal(data(root).length, 3);
  assert.ok(!JSON.stringify(saved).includes("第一项任务"));
  assert.ok(!JSON.stringify(saved).includes("old"));
});
test("manual defaults lock the initial turn; evicted selections never silently switch to latest", async (t) => {
  const source = sourceWithRecords(); const props = panelProps(); let root!: ReactTestRenderer;
  await act(async () => { root = create(<ActivityView {...props} source={source} defaults={{ ...defaults, defaultMode: "manual" }} retry={() => {}} />); });
  t.after(async () => { await act(async () => root.unmount()); });
  await act(async () => source.set({ ...source.get(), records: [...initial(), user(5, "new")] }));
  assert.deepEqual(data(root).map((item) => item.path), ["z"]);
  await act(async () => source.set({ ...source.get(), records: [user(5, "new")], partial: true }));
  assert.deepEqual(data(root), []);
  assert.equal(picker(root, "轮次").props.value, "second");
  assert.match(JSON.stringify(root.toJSON()), /所选轮次不在已加载历史/);
});
test("category/order controls, details, range and in-panel turn jump work without timeline navigation", async (t) => {
  const source = sourceWithRecords(); const root = await render(source); t.after(async () => { await act(async () => root.unmount()); });
  await act(async () => button(root, "修改 z").props.onPress());
  assert.match(JSON.stringify(root.toJSON()), /"old"/);
  await act(async () => button(root, "全会话").props.onPress());
  await pick(root, "排序", "path");
  assert.deepEqual(data(root).map((item) => item.path), ["a", "z"]);
  await act(async () => button(root, "降序").props.onPress());
  assert.deepEqual(data(root).map((item) => item.path), ["z", "a"]);
  await act(async () => button(root, "修改").props.onPress());
  assert.deepEqual(data(root).map((item) => item.path), ["a"]);
  await act(async () => button(root, "查询 a").props.onPress());
  assert.match(JSON.stringify(root.toJSON()), /起始行 2/);
  await act(async () => button(root, "查看第 1 轮的活动").props.onPress());
  assert.equal(button(root, "手动选轮").props.accessibilityState.checked, true);
  assert.equal(picker(root, "轮次").props.value, "first");
});
test("invalid persisted tab state falls back; empty/error/partial states remain visible in compact and light themes", async (t) => {
  const source = createTimelineStore(); const props = panelProps();
  props.tab = { ...props.tab, state: { mode: "unsupported" } };
  props.layout = { compact: true, platform: "ios" };
  props.theme = { colors: { ...props.theme.colors, surface0: "#ffffff", foreground: "#101010" } };
  let retries = 0; let root!: ReactTestRenderer;
  await act(async () => { root = create(<ActivityView {...props} source={source} defaults={defaults} retry={() => { retries++; }} />); });
  t.after(async () => { await act(async () => root.unmount()); });
  assert.match(JSON.stringify(root.toJSON()), /正在读取文件活动/);
  await act(async () => source.set({ records: [], status: "error", partial: true, warning: "历史缺页" }));
  assert.match(JSON.stringify(root.toJSON()), /历史缺页/);
  await act(async () => button(root, "重新读取会话历史").props.onPress());
  assert.equal(retries, 1);
  await act(async () => source.set({ records: [], status: "ready", partial: false, warning: "" }));
  assert.match(JSON.stringify(root.toJSON()), /当前范围没有可识别/);
  for (const label of ["新增", "删除", "修改", "查询"]) await act(async () => button(root, label).props.onPress());
  assert.match(JSON.stringify(root.toJSON()), /请选择要显示的活动类别/);
});
test("toolbar exposes selected states, per-kind counts and a compact unsuccessful filter", async (t) => {
  const source = sourceWithRecords(); source.set({ ...source.get(), records: [...initial(), record(tool("failed", { type: "edit", filePath: "failed.ts" }, "failed"), 5, "second")] });
  const root = await render(source); t.after(async () => { await act(async () => root.unmount()); });
  assert.equal(button(root, "最新轮").props["aria-checked"], true);
  assert.equal(button(root, "修改").props["aria-checked"], true);
  assert.equal(data(root).length, 2);
  await act(async () => button(root, "显示未完成请求").props.onPress());
  assert.equal(data(root).length, 1);
  assert.equal(button(root, "显示未完成请求").props["aria-checked"], false);
  assert.equal(button(root, "修改").findAll((node) => String(node.type) === "Text").at(-1)!.children.join(""), "1");
  await act(async () => button(root, "手动选轮").props.onPress());
  assert.equal(button(root, "下一轮").props.disabled, true);
});
test("agent panel unmount and plugin cleanup release observers, including pending release", async () => {
  const host = fakeAgent(); host.setRead(async () => page(initial()));
  const release = deferred<void>();
  host.setRelease(() => release.promise);
  setPaseo({ agents: { ref: () => host.agent } } as unknown as PluginClientContext["paseo"]); setSettingsState(ready());
  let contribution!: PluginAgentPanelContribution; let removed = 0;
  const stop = registerFileActivity({
    addWorkspacePanel() { return () => { removed++; }; }, addCommandCenterItem() { return () => { removed++; }; },
    addAgentPanel(value: PluginAgentPanelContribution) { contribution = value; return () => { removed++; }; },
  } as unknown as PluginClientContext);
  assert.deepEqual(contribution.locations, ["explorer"]); assert.equal(contribution.id, "file-activity-agent");
  const Component = contribution.Component; let root!: ReactTestRenderer;
  await act(async () => { root = create(<Component {...panelProps()} />); await flush(); });
  assert.equal(host.calls.length, 1);
  await act(async () => root.unmount());
  let done = false; const pending = stop().then(() => { done = true; }); await flush();
  assert.equal(done, false); assert.equal(removed, 3);
  release.resolve(); await pending;
  await act(async () => { root = create(<Component {...panelProps()} />); await flush(); });
  assert.equal(host.calls.length, 1);
  await act(async () => root.unmount());
});
test("configuration loading delays observation and configuration failure offers defaults plus retry", async (t) => {
  let observations = 0; let reloads = 0;
  const limits: number[] = [];
  const host = fakeAgent(); setPaseo({ agents: { ref: () => host.agent } } as unknown as PluginClientContext["paseo"]);
  setSettingsState({ ...ready(), status: "loading" });
  const props = { ...panelProps(), observe: (_: unknown, limit: number) => { observations++; limits.push(limit); return null; } }; let root!: ReactTestRenderer;
  await act(async () => { root = create(<FileActivityPanel {...props} />); });
  t.after(async () => { await act(async () => root.unmount()); });
  assert.equal(observations, 0);
  await act(async () => { setSettingsState({ ...ready(), status: "error", error: "offline", reload: async () => { reloads++; } }); root.update(<FileActivityPanel {...props} />); });
  assert.equal(observations, 1);
  await act(async () => control(root, "SettingsAction", "配置读取失败，暂用默认值").props.onPress());
  assert.equal(reloads, 1);
  await act(async () => { setSettingsState({ ...ready(), values: { ...defaults, maxEntries: 1000 } }); root.update(<FileActivityPanel {...props} />); });
  assert.deepEqual(limits, [5000]); // Captured at panel mount; reopening applies changed limits.
});
