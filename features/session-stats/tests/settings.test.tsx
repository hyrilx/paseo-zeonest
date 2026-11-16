import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { SettingsState } from "@getpaseo/plugin/client";
import { preferences, preferencesSchema, type Preferences } from "../shared/settings";
import contributeSettings from "../server/settings";
import { props, deferred, SessionStatsSettings, setSettingsState } from "./fixtures/host";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type State = SettingsState<typeof preferencesSchema>;
const defaults = () => preferencesSchema.parse({});
const ready = (patch: Partial<State> = {}): State => ({ status: "ready", values: defaults(), revision: "r1", saving: false, saveError: null,
  save: async () => true, reset: async () => true, reload: async () => {}, ...patch } as State);
const control = (root: ReactTestRenderer, type: string, label: string) => root.root.findAll((node) => String(node.type) === type && node.props.label === label)[0]!;
const strings = (root: ReactTestRenderer) => JSON.stringify(root.toJSON());
async function render(state: State) {
  setSettingsState(state);
  let root!: ReactTestRenderer;
  await act(async () => { root = create(<SessionStatsSettings {...props} />); });
  return root;
}
async function update(root: ReactTestRenderer, state: State) {
  await act(async () => { setSettingsState(state); root.update(<SessionStatsSettings {...props} />); });
}

test("native preferences have validated defaults and register independently of the enabled runtime", () => {
  assert.deepEqual(defaults(), { showCounts: true, visibleMetrics: ["modelMs", "toolMs", "ttftMs", "averageTps", "tools"], missingValues: "hide", instantWindowSeconds: 3 });
  for (const value of [{ instantWindowSeconds: 0 }, { instantWindowSeconds: "3" }, { instantWindowSeconds: 7 }, { visibleMetrics: ["bad"] }, { visibleMetrics: ["modelMs", "modelMs"] }, { missingValues: "zero" }]) assert.equal(preferencesSchema.safeParse(value).success, false);
  assert.equal(preferencesSchema.safeParse({ visibleMetrics: [], showCounts: false, instantWindowSeconds: 1 }).success, true);
  let registered: unknown;
  const cleanup = contributeSettings({ registerSettings(value: unknown) { registered = value; } } as unknown as PluginServerContext);
  assert.equal(registered, preferences);
  assert.equal(preferences.scope, "host");
  cleanup();
});

test("settings expose display controls and keep calculation notes outside the popup", async (t) => {
  const root = await render(ready());
  t.after(async () => { await act(async () => root.unmount()); });
  assert.equal(root.root.findAll((node) => String(node.type) === "SettingsSwitch").length, 6);
  assert.equal(root.root.findAll((node) => String(node.type) === "SettingsSelect").length, 2);
  assert.equal(control(root, "SettingsSelect", "没有样本的指标").props.value, "hide");
  assert.equal(control(root, "SettingsSelect", "采样窗口").props.value, "3");
  for (const text of ["统计口径", "总估算 token ÷ 总解码时长", "数据范围", "≈ 表示客户端观测或估算", "约 2 秒内生效", "原生设置持久化"]) assert.ok(strings(root).includes(text), text);
});

test("saves the entire draft against its original revision and blocks double-submit", async (t) => {
  const pending = deferred<boolean>();
  const calls: { values: Preferences; revision: string }[] = [];
  const state = ready({ save: async (values, revision) => { calls.push({ values, revision }); return pending.promise; } });
  const root = await render(state);
  t.after(async () => { await act(async () => root.unmount()); });
  await act(async () => {
    control(root, "SettingsSwitch", "轮数与步数").props.onValueChange(false);
    control(root, "SettingsSwitch", "工具调用次数").props.onValueChange(false);
    control(root, "SettingsSelect", "没有样本的指标").props.onValueChange("label");
    control(root, "SettingsSelect", "采样窗口").props.onValueChange("5");
  });
  await act(async () => {
    const press = control(root, "SettingsAction", "保存会话统计配置").props.onPress;
    press(); press();
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.revision, "r1");
  assert.deepEqual(calls[0]!.values, { showCounts: false, visibleMetrics: ["modelMs", "toolMs", "ttftMs", "averageTps"], missingValues: "label", instantWindowSeconds: 5 });
  assert.equal(control(root, "SettingsAction", "保存会话统计配置").props.disabled, true);
  await act(async () => { pending.resolve(false); });
  assert.equal(control(root, "SettingsAction", "保存会话统计配置").props.disabled, false);
});

test("remote changes and save conflicts preserve the draft and never rebase its revision", async (t) => {
  let revision = "";
  const state = ready({ save: async (_, value) => { revision = value; return false; } });
  const root = await render(state);
  t.after(async () => { await act(async () => root.unmount()); });
  await act(async () => control(root, "SettingsSwitch", "模型用时").props.onValueChange(false));
  const remote = ready({ revision: "r2", values: { ...defaults(), instantWindowSeconds: 1 }, save: state.save, saveError: "revision conflict" });
  await update(root, remote);
  assert.equal(control(root, "SettingsSwitch", "模型用时").props.value, false);
  assert.equal(control(root, "SettingsSelect", "采样窗口").props.value, "3");
  assert.match(strings(root), /当前草稿已保留/);
  await act(async () => control(root, "SettingsAction", "保存会话统计配置").props.onPress());
  assert.equal(revision, "r1");
  assert.match(strings(root), /revision conflict/);
  assert.equal(control(root, "SettingsSwitch", "模型用时").props.value, false);
});

test("reload discards a draft, defaults only alter the draft, and successful save acknowledges changes", async (t) => {
  let saves = 0; let reloads = 0;
  const state = ready({ save: async () => { saves++; return true; }, reload: async () => { reloads++; } });
  const root = await render(state);
  t.after(async () => { await act(async () => root.unmount()); });
  await act(async () => control(root, "SettingsSwitch", "模型用时").props.onValueChange(false));
  await act(async () => control(root, "SettingsAction", "恢复默认显示与采样窗口（保存后生效）").props.onPress());
  assert.equal(control(root, "SettingsSwitch", "模型用时").props.value, true);
  assert.equal(saves, 0);
  await act(async () => control(root, "SettingsSwitch", "模型用时").props.onValueChange(false));
  await act(async () => control(root, "SettingsAction", "丢弃草稿并重新读取").props.onPress());
  assert.equal(reloads, 1);
  assert.equal(control(root, "SettingsSwitch", "模型用时").props.value, true);
  await act(async () => control(root, "SettingsAction", "保存会话统计配置").props.onPress());
  assert.equal(saves, 1);
  assert.match(strings(root), /已保存/);
});

test("loading, invalid documents, failed reads and failed saves have recovery controls", async (t) => {
  const base = ready();
  const root = await render({ ...base, status: "loading" });
  t.after(async () => { await act(async () => root.unmount()); });
  assert.match(strings(root), /正在读取配置/);
  let resets = 0;
  await update(root, { ...base, status: "invalid", revision: "bad", error: "配置损坏", reset: async () => { resets++; return false; }, saveError: "revision conflict" });
  await act(async () => control(root, "SettingsAction", "恢复默认显示与采样窗口").props.onPress());
  assert.equal(resets, 1);
  assert.match(strings(root), /保存失败/);
  assert.ok(!strings(root).includes("已恢复默认配置"));
  await update(root, { ...base, status: "error", error: "离线" });
  assert.match(strings(root), /离线/);
  assert.ok(control(root, "SettingsAction", "丢弃草稿并重新读取"));
});
