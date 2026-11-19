import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { SettingsState } from "@getpaseo/plugin/client";
import { preferences, preferencesSchema, type Preferences } from "../shared/settings";
import contributeSettings from "../server/settings";
import { FileActivitySettings, panelProps, setSettingsState } from "./fixtures/host";
import { deferred } from "./fixtures/timeline";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type State = SettingsState<typeof preferencesSchema>;
const defaults = () => preferencesSchema.parse({});
type Ready = Extract<State, { status: "ready" }>;
const ready = (patch: Partial<Ready> = {}): Ready => ({ status: "ready", values: defaults(), revision: "r1", saving: false, saveError: null,
  save: async () => true, reset: async () => true, reload: async () => {}, ...patch });
const control = (root: ReactTestRenderer, type: string, label: string) => root.root.findAll((node) => String(node.type) === type && node.props.label === label)[0]!;
const strings = (root: ReactTestRenderer) => JSON.stringify(root.toJSON());
async function render(state: State) {
  setSettingsState(state); let root!: ReactTestRenderer;
  await act(async () => { root = create(<FileActivitySettings {...panelProps()} />); }); return root;
}
async function update(root: ReactTestRenderer, state: State) {
  await act(async () => { setSettingsState(state); root.update(<FileActivitySettings {...panelProps()} />); });
}
test("preferences validate exact choices and register while the runtime is disabled", () => {
  assert.deepEqual(defaults(), { defaultMode: "latest", defaultSort: "time", descending: false, includeUnsuccessful: true, maxEntries: 5000, previewLines: 300 });
  for (const value of [{ defaultMode: "scroll" }, { defaultSort: "size" }, { maxEntries: 0 }, { maxEntries: "5000" }, { previewLines: 200 }, { descending: "false" }]) assert.equal(preferencesSchema.safeParse(value).success, false);
  let registered: unknown;
  const cleanup = contributeSettings({ registerSettings(value: unknown) { registered = value; } } as unknown as PluginServerContext);
  assert.equal(registered, preferences); assert.equal(preferences.scope, "host"); cleanup();
});
test("settings controls save one draft against its original revision and reject double submit", async (t) => {
  const pending = deferred<boolean>(); const calls: { values: Preferences; revision: string }[] = [];
  const state = ready({ save: async (values, revision) => { calls.push({ values, revision }); return pending.promise; } });
  const root = await render(state); t.after(async () => { await act(async () => root.unmount()); });
  assert.equal(root.root.findAll((node) => String(node.type) === "SettingsSelect").length, 4);
  await act(async () => control(root, "SettingsSelect", "查看范围").props.onValueChange("all"));
  await act(async () => control(root, "SettingsSelect", "排序").props.onValueChange("path"));
  await act(async () => control(root, "SettingsSelect", "历史记录上限").props.onValueChange("1000"));
  await act(async () => control(root, "SettingsSelect", "每次展开的正文行数").props.onValueChange("100"));
  await act(async () => control(root, "SettingsSwitch", "降序").props.onValueChange(true));
  await act(async () => { const press = control(root, "SettingsAction", "保存文件活动配置").props.onPress; press(); press(); });
  assert.equal(calls.length, 1); assert.equal(calls[0]!.revision, "r1");
  assert.deepEqual(calls[0]!.values, { ...defaults(), defaultMode: "all", defaultSort: "path", maxEntries: 1000, previewLines: 100, descending: true });
  assert.equal(control(root, "SettingsAction", "保存文件活动配置").props.disabled, true);
  await act(async () => { pending.resolve(false); });
  assert.equal(control(root, "SettingsAction", "保存文件活动配置").props.disabled, false);
});
test("remote revision and failed save retain the draft; reload and reset defaults are explicit", async (t) => {
  let revision = ""; let reloads = 0;
  const state = ready({ save: async (_, value) => { revision = value; return false; }, reload: async () => { reloads++; } });
  const root = await render(state); t.after(async () => { await act(async () => root.unmount()); });
  await act(async () => control(root, "SettingsSwitch", "降序").props.onValueChange(true));
  await update(root, ready({ ...state, revision: "r2", saveError: "revision conflict" }));
  assert.equal(control(root, "SettingsSwitch", "降序").props.value, true); assert.match(strings(root), /草稿已保留/);
  await act(async () => control(root, "SettingsAction", "保存文件活动配置").props.onPress());
  assert.equal(revision, "r1"); assert.match(strings(root), /revision conflict/);
  await act(async () => control(root, "SettingsAction", "恢复默认值（保存后生效）").props.onPress());
  assert.equal(control(root, "SettingsSwitch", "降序").props.value, false);
  await act(async () => control(root, "SettingsSwitch", "降序").props.onValueChange(true));
  await act(async () => control(root, "SettingsAction", "丢弃草稿并重新读取").props.onPress());
  assert.equal(reloads, 1); assert.equal(control(root, "SettingsSwitch", "降序").props.value, false);
  await update(root, ready());
  await act(async () => control(root, "SettingsAction", "保存文件活动配置").props.onPress());
  assert.match(strings(root), /已保存/);
});
test("loading, invalid and failed reads offer recovery, with data and scroll limits stated", async (t) => {
  const root = await render({ ...ready(), status: "loading" }); t.after(async () => { await act(async () => root.unmount()); });
  assert.match(strings(root), /正在读取配置/); let resets = 0;
  await update(root, { ...ready(), status: "invalid", revision: "bad", error: "损坏", reset: async () => { resets++; return false; } });
  await act(async () => control(root, "SettingsAction", "恢复默认配置").props.onPress());
  assert.equal(resets, 1); assert.match(strings(root), /损坏/);
  await update(root, { ...ready(), status: "error", error: "offline" });
  assert.match(strings(root), /offline/);
  assert.ok(!strings(root).includes("SDK 0.15.4"));
  await act(async () => control(root, "SettingsAction", "打开方式与记录范围").props.onPress());
  for (const text of ["SDK 0.15.4", "未提供随对话滚动联动", "不读取磁盘", "已有面板保留各会话", "工作区侧边栏", "查看当前会话文件活动"]) assert.ok(strings(root).includes(text), text);
});
