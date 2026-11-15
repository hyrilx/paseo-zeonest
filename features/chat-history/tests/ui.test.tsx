import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { PluginClientContext, PluginSurfaceProps, PluginTimelineItemProps, SettingsState } from "@getpaseo/plugin/client";
import { defaultPreferences, preferencesSchema } from "../shared/settings";
import type { HistoryMessage } from "../client/parse";
import { splitHistoryMessage } from "../client/parse";

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: { contents: "export { default } from './index'; export { ChatHistoryRenderer } from './history'; export { ChatHistorySettings } from './settings-page'; export { setSettings } from '@getpaseo/plugin/client';", resolveDir: new URL("../client", import.meta.url).pathname, loader: "ts" },
  bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", external: ["react", "react/jsx-runtime"],
  plugins: [{ name: "native-host", setup(builder) {
    builder.onResolve({ filter: /^(@getpaseo\/plugin\/client(?:\/ui)?|react-native)$/ }, (args) => ({ path: args.path, namespace: "test-host" }));
    builder.onLoad({ filter: /.*/, namespace: "test-host" }, () => ({ loader: "js", contents: `import React from 'react';
      let settings;
      export function setSettings(value) { settings = value; }
      export function useSettings() { return settings; }
      const component = name => props => React.createElement(name, props, props.children);
      export const Text = component('Text'), View = component('View'), Pressable = component('Pressable');
      export const Icon = component('Icon'), Markdown = component('Markdown');
      export const SettingsAction = component('SettingsAction'), SettingsInput = component('SettingsInput'),
        SettingsSwitch = component('SettingsSwitch'), SettingsSection = component('SettingsSection'), SettingsCard = component('SettingsCard');` }));
  } }],
});
const module = { exports: {} as {
  default(client: PluginClientContext): () => void;
  ChatHistoryRenderer: React.ComponentType<PluginTimelineItemProps<HistoryMessage>>;
  ChatHistorySettings: React.ComponentType<PluginSurfaceProps>;
  setSettings(value: SettingsState<typeof preferencesSchema>): void;
} };
new Function("require", "module", "exports", compiled.outputFiles[0]!.text)(require, module, module.exports);
const { default: contribute, ChatHistoryRenderer, ChatHistorySettings, setSettings } = module.exports;
function readySettings(values = defaultPreferences): Extract<SettingsState<typeof preferencesSchema>, { status: "ready" }> {
  return { status: "ready", values, revision: "r1", saving: false, saveError: null, save: async () => true, reset: async () => true, reload: async () => {} };
}
test.beforeEach(() => setSettings(readySettings()));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const fixture = readFileSync(new URL("./fixtures/fork-message.txt", import.meta.url), "utf8");
const data = splitHistoryMessage(fixture)!;
const theme: PluginTimelineItemProps["theme"] = { colors: {
  surface0: "#101010", surface1: "#202020", surface2: "#303030", border: "#404040", foreground: "#eeeeee", foregroundMuted: "#aaaaaa",
  accent: "#abcdef", accentForeground: "#111111", statusSuccess: "#00cc00", statusWarning: "#cccc00", statusDanger: "#cc0000",
} };
function props(input: HistoryMessage = data): PluginTimelineItemProps<HistoryMessage> {
  return { agentId: "agent-1", item: { type: "plugin", kind: "chat-history", version: 1, data: input }, timestamp: new Date(0), theme, host: { id: "host", label: "Host" }, layout: { compact: false, platform: "web" } };
}
const find = (root: ReactTestRenderer, type: string, predicate: (node: ReactTestInstance) => boolean = () => true) => root.root.findAll((node) => typeof node.type === "string" && node.type === type && predicate(node));
const button = (root: ReactTestRenderer, label: string) => find(root, "Pressable", (node) => node.props.accessibilityLabel === label)[0]!;
const press = async (root: ReactTestRenderer, label: string) => { await act(async () => button(root, label).props.onPress()); };
async function mountComponent(t: { after(fn: () => Promise<void>): void }, element: React.ReactElement) {
  let root!: ReactTestRenderer;
  await act(async () => { root = create(element); });
  t.after(async () => { await act(async () => root.unmount()); });
  return root;
}
const mount = (t: { after(fn: () => Promise<void>): void }, input = props()) => mountComponent(t, <ChatHistoryRenderer {...input} />);

test("history defaults to folded while current user text remains visible; expansion renders each role", async (t) => {
  const root = await mount(t);
  assert.equal(button(root, "Chat history").props.accessibilityState.expanded, false);
  assert.equal(find(root, "Markdown").length, 0);
  assert.match(JSON.stringify(root.toJSON()), /继续处理错误提示/);
  assert.doesNotMatch(JSON.stringify(root.toJSON()), /请检查配置读取逻辑/);
  await press(root, "Chat history");
  assert.equal(button(root, "Chat history").props.accessibilityState.expanded, true);
  for (const role of ["meta", "user", "assistant"]) assert.ok(find(root, "View", (node) => node.props.testID === `chat-history-${role}`).length);
  assert.equal(find(root, "Markdown")[1]!.props.children, "**检查完成**，测试通过。");
  assert.equal(button(root, "Action · Read").props.accessibilityState.expanded, false);
  await press(root, "Action · Read");
  assert.equal(button(root, "Action · Read").props.accessibilityState.expanded, true);
  assert.equal(find(root, "Text", (node) => node.props.children === "src/config.ts" && node.props.selectable).length, 1);
  await press(root, "查看摘要原文");
  assert.equal(find(root, "Text", (node) => node.props.testID === "chat-history-raw")[0]!.props.children, data.histories[0]);
  await press(root, "返回对话视图");
  await press(root, "Chat history");
  assert.equal(find(root, "Markdown").length, 0);
  assert.equal(find(root, "View", (node) => node.props.testID === "chat-history-current").length, 1);
});

test("multiple summaries fold independently; no current bubble is fabricated for attachment-only messages", async (t) => {
  const root = await mount(t, props({ histories: ["[User] first", "[Assistant] second"], body: "\n" }));
  assert.equal(find(root, "View", (node) => node.props.testID === "chat-history-current").length, 0);
  await press(root, "Chat history 2");
  assert.equal(button(root, "Chat history").props.accessibilityState.expanded, false);
  assert.equal(button(root, "Chat history 2").props.accessibilityState.expanded, true);
  assert.equal(find(root, "Markdown")[0]!.props.children, "second");
});

test("source omissions, empty history, unknown text, and actions without details remain truthful", async (t) => {
  const root = await mount(t, props({ histories: ["[Earlier chat history omitted]\n[User] head\n[Message truncated]\ntail\n[Read]"], body: "question" }));
  await press(root, "Chat history");
  assert.match(JSON.stringify(root.toJSON()), /Paseo 已省略更早的历史/);
  assert.match(JSON.stringify(root.toJSON()), /部分消息已被 Paseo 截断/);
  await press(root, "Action · Read");
  assert.match(JSON.stringify(root.toJSON()), /摘要未保留操作详情/);
  await act(async () => root.update(<ChatHistoryRenderer {...props({ histories: [""], body: "" })} />));
  assert.match(JSON.stringify(root.toJSON()), /这份历史摘要没有内容/);
  await act(async () => root.update(<ChatHistoryRenderer {...props({ histories: ["unknown original content"], body: "" })} />));
  assert.match(JSON.stringify(root.toJSON()), /unknown original content/);
});

test("large histories mount one page at a time; long messages have an explicit full-text control", async (t) => {
  const text = Array.from({ length: 85 }, (_, index) => `[User] message-${index}`).join("\n");
  const root = await mount(t, props({ histories: [text], body: "current" }));
  await press(root, "Chat history");
  const users = () => find(root, "View", (node) => node.props.testID === "chat-history-user");
  assert.equal(users().length, 40);
  await press(root, "显示更多历史"); assert.equal(users().length, 80);
  await press(root, "显示更多历史"); assert.equal(users().length, 85);
  assert.equal(button(root, "显示更多历史"), undefined);
  const long = "## 标题\n\n**粗体**与[链接](https://example.com)\n\n```ts\nconst x = 1;\n```\n" + "x".repeat(2000) + "full-tail";
  await act(async () => root.update(<ChatHistoryRenderer {...props({ histories: [`[Assistant] ${long}`], body: "current" })} />));
  assert.equal(find(root, "Markdown")[0]!.props.children, long.slice(0, 1800));
  assert.doesNotMatch(JSON.stringify(root.toJSON()), /full-tail/);
  await press(root, "展开全文");
  assert.equal(find(root, "Markdown")[0]!.props.children, long);
  await press(root, "收起全文"); assert.equal(find(root, "Markdown")[0]!.props.children, long.slice(0, 1800));
  await press(root, "查看摘要原文");
  assert.ok(find(root, "Text", (node) => node.props.testID === "chat-history-raw")[0]!.props.children.endsWith("full-tail"));
});

test("wide/compact and light/dark render paths use supplied theme tokens; switching agents resets folding", async (t) => {
  const light = { colors: { ...theme.colors, surface0: "#ffffff", surface1: "#fafafa", surface2: "#eeeeee", foreground: "#111111", foregroundMuted: "#555555" } };
  const root = await mount(t);
  for (const selectedTheme of [theme, light]) for (const compact of [false, true]) {
    const input = { ...props(), theme: selectedTheme, layout: { compact, platform: "web" as const } };
    await act(async () => root.update(<ChatHistoryRenderer {...input} />));
    if (!button(root, "Chat history").props.accessibilityState.expanded) await press(root, "Chat history");
    for (const node of find(root, "Text")) assert.ok(Object.values(selectedTheme.colors).includes(node.props.style.color), "every native Text uses a theme color");
    const current = find(root, "View", (node) => node.props.testID === "chat-history-current")[0]!;
    assert.equal(current.props.style.padding, 16);
    assert.equal(current.props.style.maxWidth, "100%");
    assert.equal(current.props.style.borderTopRightRadius, 4);
  }
  await act(async () => root.update(<ChatHistoryRenderer {...props()} agentId="agent-2" />));
  assert.equal(button(root, "Chat history").props.accessibilityState.expanded, false);
});

test("nested summaries remain selectable text instead of disappearing as Markdown HTML", async (t) => {
  const nested = "<chat-history-summary>\n[User] earlier\n</chat-history-summary>";
  const root = await mount(t, props({ histories: [`[Assistant] ${nested}`], body: "current" }));
  await press(root, "Chat history");
  assert.equal(find(root, "Markdown").length, 0);
  assert.equal(find(root, "Text", (node) => node.props.selectable && node.props.children === nested).length, 1);
});

test("entry registers only native timeline contributions and cleans up in reverse order, including setup failure", () => {
  const events: string[] = [];
  const registrations: { kind: string; value: any }[] = [];
  const client = {
    addTimelineRenderer(value: unknown) { registrations.push({ kind: "renderer", value }); return () => { events.push("renderer"); }; },
    addTimelineTransformer(value: unknown) { registrations.push({ kind: "transformer", value }); return () => { events.push("transformer"); }; },
  } as unknown as PluginClientContext;
  const stop = contribute(client);
  assert.deepEqual(registrations.map((entry) => entry.kind), ["renderer", "transformer"]);
  assert.equal(registrations[0]!.value.kind, "chat-history");
  assert.equal(registrations[0]!.value.Component, ChatHistoryRenderer);
  assert.equal(registrations[1]!.value.query.itemType, "user_message");
  stop(); stop(); assert.deepEqual(events, ["transformer", "renderer"]);
  events.length = 0;
  assert.throws(() => contribute({ ...client, addTimelineTransformer() { throw new Error("registration failed"); } }), /registration failed/);
  assert.deepEqual(events, ["renderer"]);
  events.length = 0;
  const failingStop = contribute({ ...client, addTimelineTransformer() { return () => { events.push("transformer"); throw new Error("cleanup failed"); }; } });
  assert.throws(failingStop, /cleanup failed/);
  assert.deepEqual(events, ["transformer", "renderer"]);
  failingStop();
  assert.deepEqual(events, ["transformer", "renderer"]);
});

test("current bubble has no duplicate role header or summary separator lines, preserving interior whitespace", async (t) => {
  const body = "\r\n \r\n  first line\r\n\r\n    indented\r\n\t\r\n";
  const root = await mount(t, props({ histories: ["[User] before"], body }));
  const current = find(root, "View", (node) => node.props.testID === "chat-history-current")[0]!;
  const texts = current.findAll((node) => typeof node.type === "string" && String(node.type) === "Text");
  assert.equal(texts.length, 1);
  assert.equal(texts[0]!.props.children, "  first line\r\n\r\n    indented");
  assert.equal(texts[0]!.props.selectable, true);
  assert.doesNotMatch(JSON.stringify(root.toJSON()), /User · 当前消息/);
  assert.equal(body, "\r\n \r\n  first line\r\n\r\n    indented\r\n\t\r\n", "source text remains intact");
});

test("live settings control expansion, Markdown preview and page size without discarding manual folding", async (t) => {
  const long = "**Markdown**\n" + "x".repeat(2000);
  const history = `[Assistant] ${long}\n` + Array.from({ length: 24 }, (_, index) => `[User] ${index}`).join("\n");
  const input = props({ histories: [history], body: "current" });
  setSettings(readySettings({ defaultExpanded: true, previewLength: 100, pageSize: 10 }));
  const root = await mount(t, input);
  assert.equal(button(root, "Chat history").props.accessibilityState.expanded, true);
  assert.equal(find(root, "Markdown")[0]!.props.children, long.slice(0, 100));
  assert.equal(find(root, "View", (node) => node.props.testID === "chat-history-user").length, 9);
  await press(root, "显示更多历史");
  assert.equal(find(root, "View", (node) => node.props.testID === "chat-history-user").length, 19);
  setSettings(readySettings({ defaultExpanded: true, previewLength: 0, pageSize: 20 }));
  await act(async () => root.update(<ChatHistoryRenderer {...input} />));
  assert.equal(find(root, "Markdown")[0]!.props.children, long);
  assert.equal(button(root, "展开全文"), undefined);
  assert.equal(find(root, "View", (node) => node.props.testID === "chat-history-user").length, 24);
  await press(root, "Chat history");
  setSettings(readySettings({ defaultExpanded: true, previewLength: 100, pageSize: 10 }));
  await act(async () => root.update(<ChatHistoryRenderer {...input} />));
  assert.equal(button(root, "Chat history").props.accessibilityState.expanded, false);
  await act(async () => root.update(<ChatHistoryRenderer {...input} agentId="another-agent" />));
  assert.equal(button(root, "Chat history").props.accessibilityState.expanded, true);
});

test("loading and broken settings fall back to readable history; late defaults do not override manual folding", async (t) => {
  const actions = { saving: false, saveError: null, save: async () => false, reset: async () => false, reload: async () => {} };
  setSettings({ ...actions, status: "loading" });
  const root = await mount(t);
  assert.equal(button(root, "Chat history").props.accessibilityState.expanded, false);
  setSettings(readySettings({ ...defaultPreferences, defaultExpanded: true }));
  await act(async () => root.update(<ChatHistoryRenderer {...props()} />));
  assert.equal(button(root, "Chat history").props.accessibilityState.expanded, true);
  await press(root, "Chat history");
  for (const state of [{ status: "invalid" as const, revision: "bad", error: "invalid document" }, { status: "error" as const, error: "offline" }]) {
    setSettings({ ...actions, ...state });
    await act(async () => root.update(<ChatHistoryRenderer {...props()} />));
    assert.match(JSON.stringify(root.toJSON()), /暂用默认值/);
    assert.equal(button(root, "Chat history").props.accessibilityState.expanded, false);
  }
  setSettings(readySettings({ ...defaultPreferences, defaultExpanded: true }));
  await act(async () => root.update(<ChatHistoryRenderer {...props()} />));
  assert.equal(button(root, "Chat history").props.accessibilityState.expanded, false);
});

const setting = (root: ReactTestRenderer, type: string, label: string) => find(root, type, (node) => node.props.label === label)[0]!;
const settingAction = async (root: ReactTestRenderer, label: string) => { await act(async () => setting(root, "SettingsAction", label).props.onPress()); };
const editSetting = async (root: ReactTestRenderer, label: string, value: string) => { await act(async () => setting(root, "SettingsInput", label).props.onChangeText(value)); };

test("settings validate numeric drafts and save the original revision, preserving drafts on conflict", async (t) => {
  const saved: unknown[] = [];
  let state = { ...readySettings(), save: async (values: unknown, revision: string) => { saved.push({ values, revision }); return false; } };
  setSettings(state);
  const root = await mountComponent(t, <ChatHistorySettings {...props()} />);
  for (const value of ["", "-1", "1.5", "1e2", "20001", "no"]) {
    await editSetting(root, "单条预览长度", value);
    await settingAction(root, "保存历史显示配置");
    assert.equal(saved.length, 0);
    assert.match(JSON.stringify(root.toJSON()), /需为 0–20000 的整数/);
  }
  await editSetting(root, "单条预览长度", "0");
  await editSetting(root, "每次显示条数", "9");
  await settingAction(root, "保存历史显示配置");
  assert.equal(saved.length, 0);
  await editSetting(root, "每次显示条数", "25");
  await act(async () => setting(root, "SettingsSwitch", "默认展开历史").props.onValueChange(true));
  state = { ...state, revision: "r2", values: { ...defaultPreferences, previewLength: 500 } };
  setSettings(state);
  await act(async () => root.update(<ChatHistorySettings {...props()} />));
  assert.match(JSON.stringify(root.toJSON()), /配置已在其他客户端更新/);
  await settingAction(root, "保存历史显示配置");
  assert.deepEqual(saved, [{ values: { defaultExpanded: true, previewLength: 0, pageSize: 25 }, revision: "r1" }]);
  assert.match(JSON.stringify(root.toJSON()), /草稿已保留/);
  assert.equal(setting(root, "SettingsInput", "单条预览长度").props.initialValue, "0");
  assert.equal(setting(root, "SettingsInput", "每次显示条数").props.initialValue, "25");
});

test("settings save/reload refresh the editor revision and serialize pending operations", async (t) => {
  const writes: string[] = [];
  let release!: (success: boolean) => void;
  const pending = new Promise<boolean>((resolve) => { release = resolve; });
  let reloads = 0;
  const state = { ...readySettings(), save: async (_values: unknown, revision: string) => { writes.push(revision); return pending; }, reload: async () => {
    reloads++; setSettings({ ...state, revision: "r3", values: { ...defaultPreferences, previewLength: 600 } });
  } };
  setSettings(state);
  const root = await mountComponent(t, <ChatHistorySettings {...props()} />);
  await editSetting(root, "单条预览长度", "400");
  await settingAction(root, "保存历史显示配置");
  assert.equal(setting(root, "SettingsInput", "单条预览长度").props.disabled, true);
  await settingAction(root, "保存历史显示配置");
  await settingAction(root, "丢弃草稿并重新读取配置");
  assert.equal(writes.length, 1);
  assert.equal(reloads, 0);
  await act(async () => {
    setSettings({ ...state, revision: "r2", values: { ...defaultPreferences, previewLength: 400 } });
    release(true); await pending;
  });
  assert.equal(setting(root, "SettingsInput", "单条预览长度").props.disabled, false);
  assert.equal(setting(root, "SettingsInput", "单条预览长度").props.initialValue, "400");
  await settingAction(root, "保存历史显示配置");
  assert.deepEqual(writes, ["r1", "r2"]);
  await editSetting(root, "单条预览长度", "250");
  await settingAction(root, "丢弃草稿并重新读取配置");
  assert.equal(reloads, 1);
  assert.equal(setting(root, "SettingsInput", "单条预览长度").props.initialValue, "600");
  await settingAction(root, "保存历史显示配置");
  assert.deepEqual(writes, ["r1", "r2", "r3"]);
});

test("settings loading/error/invalid states expose explicit recovery and reset failures", async (t) => {
  const state = { ...readySettings(), reset: async () => false };
  setSettings({ ...state, status: "loading" });
  const root = await mountComponent(t, <ChatHistorySettings {...props()} />);
  assert.match(JSON.stringify(root.toJSON()), /正在读取/);
  assert.equal(find(root, "SettingsInput").length, 0);
  setSettings({ ...state, status: "error", error: "host offline" });
  await act(async () => root.update(<ChatHistorySettings {...props()} />));
  assert.match(JSON.stringify(root.toJSON()), /host offline/);
  assert.equal(find(root, "SettingsAction", (node) => node.props.actionLabel === "恢复默认").length, 0);
  setSettings({ ...state, status: "invalid", error: "broken JSON", revision: "bad", saveError: "storage unavailable" });
  await act(async () => root.update(<ChatHistorySettings {...props()} />));
  assert.match(JSON.stringify(root.toJSON()), /broken JSON/);
  await settingAction(root, "恢复默认历史显示配置");
  assert.match(JSON.stringify(root.toJSON()), /草稿已保留/);
  assert.match(JSON.stringify(root.toJSON()), /storage unavailable/);
  setSettings({ ...state, status: "invalid", error: "broken JSON", revision: "bad", reset: async () => { setSettings(readySettings()); return true; } });
  await act(async () => root.update(<ChatHistorySettings {...props()} />));
  await settingAction(root, "恢复默认历史显示配置");
  assert.equal(setting(root, "SettingsInput", "单条预览长度").props.initialValue, "1800");
});
