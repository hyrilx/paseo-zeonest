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
test("full text is selectable and untruncated, copy uses full content, live updates and removal stay truthful", async (t) => {
  let copied = ""; globals.__statusHost = { rpc: {}, settings: {}, copy: async (value) => { copied = value; } };
  const source = createStatusStore(); const long = "long detail\n".repeat(100); source.apply(snapshot(long));
  const root = await mount(t, <StatusDetails {...props} context="agent" workspaceId="w" agentId="a" close={() => {}} source={source} entryId={statusId("a", "lens")} expand={async () => ({ message: "sent" })} />);
  const text = root.root.findAll((node) => node.type === "Text" as any && node.props.children === long)[0]!;
  assert.equal(text.props.selectable, true); assert.equal(text.props.numberOfLines, undefined);
  await act(async () => host(root, "Pressable", "复制完整内容").props.onPress()); assert.equal(copied, long);
  await act(async () => source.apply(snapshot("live detail"))); assert.match(JSON.stringify(root.toJSON()), /live detail/);
  await act(async () => source.clear()); assert.match(JSON.stringify(root.toJSON()), /已移除或通道已断开/);
  assert.equal(host(root, "Pressable", "执行 Pi 展开命令"), undefined);
  assert.match(JSON.stringify(root.toJSON()), /#001100/); assert.match(JSON.stringify(root.toJSON()), /#005500/);
});
test("expansion is explicit, sends the mapped entry, and errors remain visible", async (t) => {
  const source = createStatusStore(); source.apply(snapshot()); let calls = 0;
  const root = await mount(t, <StatusDetails {...props} context="agent" workspaceId="w" agentId="a" close={() => {}} source={source} entryId={statusId("a", "lens")} expand={async (entry: any) => { calls++; assert.equal(entry.command, "/lens detail"); throw new Error("agent busy"); }} />);
  assert.equal(calls, 0);
  await act(async () => host(root, "Pressable", "执行 Pi 展开命令").props.onPress());
  assert.equal(calls, 1); assert.match(JSON.stringify(root.toJSON()), /agent busy/);
});
test("client reconciles in place, removes deleted pills and cleans up late RPC results", async () => {
  let state = snapshot("long detail ".repeat(20)); let count = 0; let updates = 0; let removed = 0; let captured: any;
  const client = { rpc: async () => state, addComposerPill: (pill: unknown) => { captured = pill; count++; return { update: () => { updates++; }, remove: () => { removed++; } }; } } as unknown as PluginClientContext;
  const stop = startStatusClient(client, 5);
  await delay(20); assert.equal(count, 1); assert.equal(captured.workspaceId, "w"); assert.equal(captured.agentId, "a"); assert.equal(captured.button.label, state.statuses[0]!.text.trim());
  const Content = captured.button.behavior.Content;
  state = snapshot("changed"); await delay(20); assert.equal(count, 1); assert.equal(updates, 1); assert.equal(captured.button.behavior.Content, Content);
  state = { statuses: [], warnings: [] }; await delay(20); assert.equal(removed, 1);
  stop(); stop(); assert.equal(removed, 1);
  let resolve!: (value: BridgeSnapshot) => void;
  const late = { ...client, rpc: () => new Promise<BridgeSnapshot>((yes) => { resolve = yes; }) } as unknown as PluginClientContext;
  const stopLate = startStatusClient(late, 5); stopLate(); resolve(snapshot()); await delay(5); assert.equal(count, 1);
});
test("a recovered bridge warning removes only its pill and preserves healthy statuses", async (t) => {
  let state = snapshot();
  const registrations: { label: string; removed: number; updates: number }[] = [];
  const client = { rpc: async () => state, addComposerPill: (pill: any) => {
    const registration = { label: pill.button.label, removed: 0, updates: 0 }; registrations.push(registration);
    return { update() { registration.updates++; }, remove() { registration.removed++; } };
  } } as unknown as PluginClientContext;
  const stop = startStatusClient(client, 5); t.after(stop);
  await delay(20);
  state = { ...snapshot(), warnings: [{ agentId: "a", workspaceId: "w", message: "Status exceeds 65536 characters" }] };
  await delay(20); assert.equal(registrations.length, 2); assert.equal(registrations[1]!.label, "Pi 状态桥接异常");
  state = snapshot(); await delay(20);
  assert.equal(registrations[1]!.removed, 1); assert.equal(registrations[0]!.removed, 0);
  assert.equal(registrations[0]!.updates, 0); assert.equal(registrations.length, 2);
});
test("RPC failure replaces stale status with an explicit warning and can recover", async () => {
  let fail = false; const labels: string[] = []; let removed = 0;
  const client = { rpc: async () => { if (fail) throw new Error("offline"); return snapshot(); }, addComposerPill: (pill: any) => { labels.push(pill.button.label); return { update() {}, remove() { removed++; } }; } } as unknown as PluginClientContext;
  const stop = startStatusClient(client, 5);
  try { await delay(20); fail = true; await delay(20); assert.equal(labels[1], "Pi 状态桥接异常"); assert.ok(removed >= 1); fail = false; await delay(20); assert.equal(labels.length, 3); }
  finally { stop(); }
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
  state.revision = "v2"; state.values = preferencesSchema.parse({ hiddenKeys: ["remote"] });
  await act(async () => root.update(<StatusBridgeSettings {...props} />));
  await act(async () => host(root, "SettingsAction", "保存状态桥接配置").props.onPress());
  const save = calls.find((call) => call.name === "save")!;
  assert.equal(save.input.revision, "v1"); assert.equal("labelLength" in save.input.values, false);
  assert.deepEqual(save.input.values.hiddenKeys, []);
  assert.deepEqual(save.input.values.actions, [{ key: "lens", command: "/lens detail" }]);
  // Simulate the host hook publishing its new saveError state to the parent.
  await act(async () => root.update(<StatusBridgeSettings {...props} />));
  assert.match(JSON.stringify(root.toJSON()), /revision conflict/);
  assert.equal(host(root, "SettingsInput", "展开命令 1").props.initialValue, "/lens detail");
});
