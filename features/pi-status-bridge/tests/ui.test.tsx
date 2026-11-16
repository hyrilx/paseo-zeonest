import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { preferencesSchema } from "../shared/settings";
import type { BridgeSnapshot } from "../shared/contracts";
import { createStatusStore, statusId } from "../client/store";

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: { contents: `export { StatusDetails } from './details'; export { StatusBridgeSettings } from './settings-page'; export { startStatusClient } from './runtime';`, resolveDir: new URL("../client", import.meta.url).pathname, loader: "tsx" },
  bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react/jsx-runtime"],
  plugins: [{ name: "native-host", setup(builder) {
    builder.onResolve({ filter: /^(@getpaseo\/plugin\/client(?:\/ui)?|react-native)$/ }, (args) => ({ path: args.path, namespace: "test-host" }));
    builder.onLoad({ filter: /.*/, namespace: "test-host" }, (args) => ({ loader: "js", contents: args.path.endsWith("/client")
      ? `export const useRpc = contract => globalThis.__statusHost.rpc[contract.name]; export const useSettings = () => globalThis.__statusHost.settings;`
      : `import React from 'react'; const component = name => props => React.createElement(name, props, props.children);
        export const Text = component('Text'), View = component('View'), Pressable = component('Pressable'), ScrollView = component('ScrollView');
        export const SettingsAction = component('SettingsAction'), SettingsCard = component('SettingsCard'), SettingsInput = component('SettingsInput'), SettingsRow = component('SettingsRow'), SettingsSection = component('SettingsSection');
        export const copyText = text => globalThis.__statusHost.copy(text);` }));
  } }],
});
const module = { exports: {} as { StatusDetails: React.ComponentType<any>; StatusBridgeSettings: React.ComponentType<any>; startStatusClient(client: PluginClientContext, intervalMs?: number): () => void } };
new Function("require", "module", "exports", compiled.outputFiles[0]!.text)(require, module, module.exports);
const { StatusDetails, StatusBridgeSettings, startStatusClient } = module.exports;
const globals = globalThis as typeof globalThis & { __statusHost: { rpc: Record<string, (input: any) => Promise<any>>; settings: any; copy(text: string): Promise<void> }; IS_REACT_ACT_ENVIRONMENT: boolean };
globals.IS_REACT_ACT_ENVIRONMENT = true;
const props: PluginSurfaceProps = { host: { id: "h", label: "host" }, layout: { compact: true, platform: "web" }, theme: { colors: {
  surface0: "#001100", surface1: "#002200", surface2: "#003300", border: "#004400", foreground: "#005500", foregroundMuted: "#006600", accent: "#007700", accentForeground: "#008800", statusSuccess: "#009900", statusWarning: "#00aa00", statusDanger: "#00bb00",
} } };
const snapshot = (text = "full content", command: string | null = "/lens detail"): BridgeSnapshot => ({ statuses: [{ agentId: "a", workspaceId: "w", key: "lens", text, command }], warnings: [] });
const host = (root: ReactTestRenderer, type: string, label: string) => root.root.findAll((node) => typeof node.type === "string" && node.type === type && (node.props.label === label || node.props.accessibilityLabel === label))[0]!;
async function mount(t: { after(fn: () => Promise<void>): void }, component: React.ReactElement) {
  let root!: ReactTestRenderer; await act(async () => { root = create(component); });
  t.after(async () => { await act(async () => root.unmount()); }); return root;
}
const scope = { agentId: "a", workspaceId: "w" };
const rowTitles = (root: ReactTestRenderer) => root.root.findAll((node) => node.type === "Text" as any && node.props.style?.fontWeight === "600" && node.props.selectable).map((node) => node.props.children);
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(5); }
  assert.ok(predicate(), "client did not settle");
}
function nativeHost(read: () => Promise<BridgeSnapshot>) {
  const registrations: { pill: any; removed: number; updates: number }[] = [];
  const client = { rpc: read, addComposerPill: (pill: any) => {
    const registration = { pill, removed: 0, updates: 0 }; registrations.push(registration);
    return { update(patch: any) { Object.assign(pill.button, patch); registration.updates++; }, remove() { registration.removed++; } };
  } } as unknown as PluginClientContext;
  return { client, registrations };
}
test("full text is selectable and untruncated, copy uses full content, live updates and removal stay truthful", async (t) => {
  let copied = ""; globals.__statusHost = { rpc: {}, settings: {}, copy: async (value) => { copied = value; } };
  const source = createStatusStore(); const long = "long detail\n".repeat(100); source.apply(snapshot(long));
  const root = await mount(t, <StatusDetails {...props} source={source} scope={scope} expand={async () => ({ message: "sent" })} />);
  const text = root.root.findAll((node) => node.type === "Text" as any && node.props.children === long)[0]!;
  assert.equal(text.props.selectable, true); assert.equal(text.props.numberOfLines, undefined);
  await act(async () => host(root, "Pressable", "复制 lens 完整内容").props.onPress()); assert.equal(copied, long);
  await act(async () => source.apply(snapshot("live detail"))); assert.match(JSON.stringify(root.toJSON()), /live detail/);
  await act(async () => source.clear()); assert.match(JSON.stringify(root.toJSON()), /已移除或通道已断开/);
  assert.equal(host(root, "Pressable", "执行 lens 的 Pi 展开命令"), undefined);
  assert.match(JSON.stringify(root.toJSON()), /#005500/);
});
test("expansion is explicit, sends the mapped entry, and errors remain visible", async (t) => {
  const source = createStatusStore(); source.apply(snapshot()); let calls = 0;
  const root = await mount(t, <StatusDetails {...props} source={source} scope={scope} expand={async (entry: any) => { calls++; assert.equal(entry.command, "/lens detail"); throw new Error("agent busy"); }} />);
  assert.equal(calls, 0);
  await act(async () => host(root, "Pressable", "执行 lens 的 Pi 展开命令").props.onPress());
  assert.equal(calls, 1); assert.match(JSON.stringify(root.toJSON()), /agent busy/);
  assert.match(JSON.stringify(root.toJSON()), /#00bb00/);
});
test("client keeps one registration and open content across body and count updates, cleans up late results", async (t) => {
  let state = snapshot("long detail ".repeat(20));
  const { client, registrations } = nativeHost(async () => state);
  const stop = startStatusClient(client, 5); t.after(async () => { await act(async () => stop()); });
  await until(() => registrations.length > 0);
  const registration = registrations[0]!; const pill = registration.pill;
  assert.equal(pill.workspaceId, "w"); assert.equal(pill.agentId, "a"); assert.equal(pill.button.label, "Pi 状态 · 1");
  const Content = pill.button.behavior.Content;
  const root = await mount(t, <Content {...props} context="agent" workspaceId="w" agentId="a" close={() => {}} />);
  await act(async () => { state = snapshot("changed"); await delay(20); });
  assert.equal(registrations.length, 1); assert.equal(registration.updates, 0);
  assert.match(JSON.stringify(root.toJSON()), /changed/);
  await act(async () => { state = { statuses: [...state.statuses, { ...state.statuses[0]!, key: "second", text: "second content" }], warnings: [] }; await until(() => pill.button.label === "Pi 状态 · 2"); });
  assert.equal(registrations.length, 1); assert.equal(registration.updates, 1); assert.equal(pill.button.behavior.Content, Content);
  assert.deepEqual(rowTitles(root), ["lens", "second"]);
  await act(async () => { state = { statuses: [], warnings: [] }; await until(() => registration.removed > 0); });
  await act(async () => { stop(); stop(); }); assert.equal(registration.removed, 1);
  let resolve!: (value: BridgeSnapshot) => void;
  const late = { ...client, rpc: () => new Promise<BridgeSnapshot>((yes) => { resolve = yes; }) } as unknown as PluginClientContext;
  const stopLate = startStatusClient(late, 5); stopLate(); resolve(snapshot()); await delay(5); assert.equal(registrations.length, 1);
});
test("warnings and recovery update the session entry and icon in place, without an extra pill", async (t) => {
  let state = snapshot(); const { client, registrations } = nativeHost(async () => state);
  const stop = startStatusClient(client, 5); t.after(stop); await until(() => registrations.length > 0);
  const registration = registrations[0]!; const Content = registration.pill.button.behavior.Content;
  state = { ...snapshot(), warnings: [{ agentId: "a", workspaceId: "w", message: "Status exceeds 65536 characters" }] };
  await until(() => registration.updates === 1);
  assert.equal(registrations.length, 1); assert.equal(registration.pill.button.label, "Pi 状态 · 1 · 1 异常");
  assert.equal(registration.pill.button.icon, "TriangleAlert");
  state = snapshot(); await until(() => registration.updates === 2);
  assert.equal(registration.removed, 0); assert.equal(registration.pill.button.label, "Pi 状态 · 1");
  assert.equal(registration.pill.button.icon, "Activity"); assert.equal(registration.pill.button.behavior.Content, Content);
});
test("RPC failure replaces stale content with a warning on the same entry and recovers", async (t) => {
  let fail = false;
  const { client, registrations } = nativeHost(async () => { if (fail) throw new Error("offline"); return snapshot(); });
  const stop = startStatusClient(client, 5); t.after(async () => { await act(async () => stop()); }); await until(() => registrations.length > 0);
  const registration = registrations[0]!;
  fail = true; await until(() => registration.updates === 1);
  assert.equal(registration.pill.button.label, "Pi 状态 · 1 异常");
  const Content = registration.pill.button.behavior.Content;
  const root = await mount(t, <Content {...props} context="agent" workspaceId="w" agentId="a" close={() => {}} />);
  assert.match(JSON.stringify(root.toJSON()), /offline/); assert.doesNotMatch(JSON.stringify(root.toJSON()), /full content/);
  await act(async () => { fail = false; await until(() => registration.updates === 2); });
  assert.equal(registrations.length, 1); assert.equal(registration.removed, 0);
  assert.equal(registration.pill.button.label, "Pi 状态 · 1"); assert.match(JSON.stringify(root.toJSON()), /full content/);
});
test("row updates preserve first-seen order, new rows append and returning rows get a new position", () => {
  const source = createStatusStore(); const first = snapshot().statuses[0]!;
  const second = { ...first, key: "second", text: "second" }; const third = { ...first, key: "third", text: "third" };
  source.apply({ statuses: [first, second], warnings: [] });
  source.apply({ statuses: [third, second, { ...first, text: "updated" }], warnings: [] });
  assert.deepEqual(source.get().map((entry) => [entry.key, entry.text]), [["lens", "updated"], ["second", "second"], ["third", "third"]]);
  source.apply({ statuses: [third, first], warnings: [] });
  source.apply({ statuses: [second, third, first], warnings: [] });
  assert.deepEqual(source.get().map((entry) => entry.key), ["lens", "third", "second"]);
});
test("summary lists only its session's unpinned rows, preserves row identity and targets each action", async (t) => {
  const copied: string[] = []; globals.__statusHost = { rpc: {}, settings: {}, copy: async (text) => { copied.push(text); } };
  const source = createStatusStore(); const first = snapshot().statuses[0]!;
  const second = { ...first, key: "queue", text: "queue full\nnext line", command: null };
  const foreign = { ...first, agentId: "b", text: "other session" };
  const pinned = { ...first, key: "pinned", pinned: true, text: "pinned content" };
  const wrongWorkspace = { ...first, key: "wrong workspace", workspaceId: "elsewhere" };
  source.apply({ statuses: [first, second, foreign, pinned, wrongWorkspace], warnings: [{ ...scope, message: "bridge issue" }] });
  const sent: string[] = [];
  const root = await mount(t, <StatusDetails {...props} source={source} scope={scope} expand={async (entry: any) => { sent.push(entry.key); return { message: "sent lens" }; }} />);
  assert.deepEqual(rowTitles(root), ["lens", "queue", "状态桥接"]);
  assert.doesNotMatch(JSON.stringify(root.toJSON()), /other session|pinned content|wrong workspace/);
  assert.equal(host(root, "Pressable", "执行 queue 的 Pi 展开命令"), undefined);
  await act(async () => host(root, "Pressable", "复制 queue 完整内容").props.onPress()); assert.deepEqual(copied, [second.text]);
  await act(async () => host(root, "Pressable", "执行 lens 的 Pi 展开命令").props.onPress()); assert.deepEqual(sent, ["lens"]);
  const row = host(root, "Pressable", "复制 lens 完整内容");
  await act(async () => source.apply({ statuses: [second, { ...first, text: "live lens" }, foreign, pinned], warnings: [] }));
  assert.deepEqual(rowTitles(root), ["lens", "queue"]); assert.equal(host(root, "Pressable", "复制 lens 完整内容"), row);
  assert.match(JSON.stringify(root.toJSON()), /live lens/);
  const pinRoot = await mount(t, <StatusDetails {...props} source={source} scope={{ ...scope, entryId: statusId("a", "pinned") }} expand={async () => ({ message: "sent" })} />);
  assert.deepEqual(rowTitles(pinRoot), ["pinned"]); assert.match(JSON.stringify(pinRoot.toJSON()), /单独常驻/);
});
test("copy waits for clipboard completion and the shared action lock prevents cross-row double commands", async (t) => {
  let resolve!: () => void; let copied = 0; let expanded = 0;
  globals.__statusHost = { rpc: {}, settings: {}, copy: () => { copied++; return new Promise<void>((yes) => { resolve = yes; }); } };
  const source = createStatusStore(); source.apply({ statuses: [...snapshot().statuses, { ...snapshot().statuses[0]!, key: "queue" }], warnings: [] });
  const root = await mount(t, <StatusDetails {...props} source={source} scope={scope} expand={async () => { expanded++; return { message: "sent" }; }} />);
  await act(async () => {
    host(root, "Pressable", "复制 queue 完整内容").props.onPress();
    host(root, "Pressable", "执行 lens 的 Pi 展开命令").props.onPress();
  });
  assert.equal(copied, 1); assert.equal(expanded, 0); assert.doesNotMatch(JSON.stringify(root.toJSON()), /已复制完整内容/);
  assert.equal(host(root, "Pressable", "执行 lens 的 Pi 展开命令").props.disabled, true);
  await act(async () => resolve()); assert.match(JSON.stringify(root.toJSON()), /已复制完整内容/);
  globals.__statusHost.copy = async () => { throw new Error("clipboard unavailable"); };
  await act(async () => host(root, "Pressable", "复制 lens 完整内容").props.onPress());
  assert.match(JSON.stringify(root.toJSON()), /clipboard unavailable/);
  assert.equal(host(root, "Pressable", "执行 lens 的 Pi 展开命令").props.disabled, false);
});
test("pinning opts only selected rows out of the summary and never merges sessions", async (t) => {
  const first = snapshot().statuses[0]!; const second = { ...first, key: "other" }; const foreign = { ...first, agentId: "b", workspaceId: "wb" };
  let state: BridgeSnapshot = { statuses: [first, second, foreign], warnings: [] };
  const { client, registrations } = nativeHost(async () => state);
  const stop = startStatusClient(client, 5); t.after(stop); await until(() => registrations.length === 2);
  assert.deepEqual(registrations.map((r) => [r.pill.agentId, r.pill.workspaceId, r.pill.button.label]), [["a", "w", "Pi 状态 · 2"], ["b", "wb", "Pi 状态 · 1"]]);
  state = { statuses: [{ ...first, pinned: true }, second, foreign], warnings: [] }; await until(() => registrations.length === 3);
  assert.equal(registrations[0]!.pill.button.label, "Pi 状态 · 1"); assert.equal(registrations[2]!.pill.button.label, first.text);
  state = { statuses: [first, second, foreign], warnings: [] }; await until(() => registrations[2]!.removed === 1);
  assert.equal(registrations[0]!.pill.button.label, "Pi 状态 · 2"); assert.equal(registrations[1]!.updates, 0);
  state = { statuses: [{ ...first, pinned: true }, { ...second, pinned: true }, foreign], warnings: [] }; await until(() => registrations[0]!.removed === 1);
  assert.equal(registrations.filter((r) => !r.removed).length, 3);
});
test("popover inherits its surface and scroll from Paseo in compact/wide and alternate palettes", async (t) => {
  const source = createStatusStore(); source.apply(snapshot("first\n".repeat(100)));
  for (const compact of [false, true]) for (const foreground of ["#111111", "#eeeeee"]) {
    const themed = { ...props, layout: { ...props.layout, compact }, theme: { colors: { ...props.theme.colors, foreground } } };
    const root = await mount(t, <StatusDetails {...themed} source={source} scope={scope} expand={async () => ({ message: "sent" })} />);
    const body = root.root.findAll((node) => node.type === "View" as any)[0]!;
    assert.equal(body.props.style.width, compact ? undefined : 420); assert.equal(body.props.style.padding, undefined);
    const nodes = root.root.findAll((node) => typeof node.type === "string");
    assert.ok(nodes.every((node) => node.props.style?.backgroundColor === undefined));
    assert.ok(nodes.every((node) => node.type !== "ScrollView" as any));
    assert.match(JSON.stringify(root.toJSON()), new RegExp(foreground));
    assert.equal(host(root, "Pressable", "复制 lens 完整内容").props.style.minHeight, 44);
  }
});

function settingsHost() {
  const calls: { name: string; input: any }[] = [];
  const state: any = { status: "ready", revision: "v1", values: preferencesSchema.parse({}), saving: false, saveError: null,
    save: async (values: unknown, revision: string) => { calls.push({ name: "save", input: { values, revision } }); state.saveError = "revision conflict"; return false; }, reload: async () => {}, reset: async () => true };
  globals.__statusHost = { settings: state, copy: async (text) => { calls.push({ name: "copy", input: text }); }, rpc: {} };
  return { calls, state };
}
test("configuration explains automatic injection without setup RPCs or a length control", async (t) => {
  const { calls } = settingsHost(); const root = await mount(t, <StatusBridgeSettings {...props} />);
  assert.deepEqual(calls, []);
  assert.equal(host(root, "SettingsInput", "胶囊文字长度"), undefined);
  assert.ok(host(root, "SettingsInput", "单独常驻的状态 key"));
  assert.equal(host(root, "SettingsAction", "生成当前版本包装器文件"), undefined);
  assert.match(JSON.stringify(root.toJSON()), /会话 hook 注入预加载观察器/);
});
test("configuration validates mappings and preserves draft/revision on concurrent updates and save failure", async (t) => {
  const { calls, state } = settingsHost(); const root = await mount(t, <StatusBridgeSettings {...props} />);
  await act(async () => host(root, "SettingsAction", "新增展开映射").props.onPress());
  await act(async () => host(root, "SettingsInput", "状态 key 1").props.onChangeText("lens"));
  await act(async () => host(root, "SettingsInput", "展开命令 1").props.onChangeText("bad"));
  await act(async () => host(root, "SettingsAction", "保存状态桥接配置").props.onPress());
  assert.equal(calls.filter((call) => call.name === "save").length, 0);
  assert.match(JSON.stringify(root.toJSON()), /填写单行/);
  await act(async () => host(root, "SettingsInput", "展开命令 1").props.onChangeText("/lens detail"));
  await act(async () => host(root, "SettingsInput", "单独常驻的状态 key").props.onChangeText("lens， queue\nmonitor"));
  state.revision = "v2"; state.values = preferencesSchema.parse({ hiddenKeys: ["remote"] });
  await act(async () => root.update(<StatusBridgeSettings {...props} />));
  await act(async () => host(root, "SettingsAction", "保存状态桥接配置").props.onPress());
  const save = calls.find((call) => call.name === "save")!;
  assert.equal(save.input.revision, "v1"); assert.equal("labelLength" in save.input.values, false);
  assert.deepEqual(save.input.values.hiddenKeys, []);
  assert.deepEqual(save.input.values.pinnedKeys, ["lens", "queue", "monitor"]);
  assert.deepEqual(save.input.values.actions, [{ key: "lens", command: "/lens detail" }]);
  // Simulate the host hook publishing its new saveError state to the parent.
  await act(async () => root.update(<StatusBridgeSettings {...props} />));
  assert.match(JSON.stringify(root.toJSON()), /revision conflict/);
  assert.equal(host(root, "SettingsInput", "展开命令 1").props.initialValue, "/lens detail");
});
