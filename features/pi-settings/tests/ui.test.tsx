import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { preferencesSchema, type Preview, type Snapshot } from "../shared/contracts";

// Use real React state/effects while replacing only host-native components and RPC transport.
const require = createRequire(import.meta.url);
const compiled = await build({ entryPoints: [new URL("../client/page.tsx", import.meta.url).pathname], bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", external: ["react", "react/jsx-runtime"], plugins: [{ name: "paseo-test-host", setup(builder) {
  builder.onResolve({ filter: /^(@getpaseo\/plugin\/client(?:\/ui)?|react-native)$/ }, (args) => ({ path: args.path, namespace: "test-host" }));
  builder.onLoad({ filter: /.*/, namespace: "test-host" }, (args) => ({ loader: "js", contents: args.path.endsWith("/client")
    ? `export const useRpc = contract => globalThis.__piTestRpc[contract.name];`
    : `import React from 'react';
      const component = name => props => React.createElement(name, props, props.children);
      export const Text = component('Text'), View = component('View'), Pressable = component('Pressable'), TextInput = component('TextInput'), ScrollView = component('ScrollView');
      export const SettingsAction = component('SettingsAction'), SettingsCard = component('SettingsCard'), SettingsInput = component('SettingsInput'), SettingsRow = component('SettingsRow'), SettingsSection = component('SettingsSection'), SettingsSelect = component('SettingsSelect'), SettingsSwitch = component('SettingsSwitch');
      export const Modal = props => props.open ? React.createElement('Modal', props, props.children) : null;
      Modal.Content = component('ModalContent');` }));
} }] });
const module = { exports: {} as { PiSettingsPage: React.ComponentType<PluginSurfaceProps> } };
new Function("require", "module", "exports", compiled.outputFiles[0]!.text)(require, module, module.exports);
const { PiSettingsPage } = module.exports;
const globals = globalThis as typeof globalThis & { __piTestRpc: Record<string, (input: any) => Promise<any>>; IS_REACT_ACT_ENVIRONMENT: boolean };
globals.IS_REACT_ACT_ENVIRONMENT = true;
const theme: PluginSurfaceProps["theme"] = { colors: { surface0: "#001100", surface1: "#002200", surface2: "#003300", border: "#004400", foreground: "#005500", foregroundMuted: "#006600", accent: "#007700", accentForeground: "#008800", statusSuccess: "#009900", statusWarning: "#00aa00", statusDanger: "#00bb00" } };
function snapshot(confirmDiff = true): Snapshot {
  return { scope: {}, directory: "/test/agent", agentDir: "/test/agent", defaultAgentDir: "/test/agent", preferences: preferencesSchema.parse({ confirmDiff }),
    documents: ["settings", "models", "mcp", "preferences"].map((kind) => ({ kind: kind as Snapshot["documents"][number]["kind"], path: `/test/agent/${kind}.json`, text: kind === "preferences" ? JSON.stringify({ confirmDiff }) : "{}", revision: "v1", exists: true, error: null })),
    globalSettings: "{}", globalMcp: "{}", resources: [], packages: [], warnings: [] };
}
async function mount(t: { after(fn: () => Promise<void>): void }, options: { confirmDiff?: boolean; commitError?: boolean; compact?: boolean } = {}) {
  const calls: { method: string; input: any }[] = [];
  const state = snapshot(options.confirmDiff ?? true);
  const plan: Preview = { token: "preview-1", title: "Save", expiresAt: "2099-01-01T00:00:00Z", confirmationRequired: options.confirmDiff ?? true, changes: [{ path: "/test/agent/settings.json", diff: "--- old\n+++ new\n+new-model\n", additions: 1, deletions: 0 }], artifacts: [], warnings: [] };
  const handlers: Record<string, (input: any) => Promise<any>> = {
    read: async () => state, workspaces: async () => [], prepare: async (input) => ({ ...plan, changes: plan.changes.map((change) => ({ ...change, path: state.documents.find((d) => d.kind === input.edits[0].kind)!.path })) }),
    commit: async () => { if (options.commitError) throw new Error("stale revision"); return { message: "Saved" }; }, discard: async () => ({ discarded: true }),
  };
  globals.__piTestRpc = Object.fromEntries(Object.entries(handlers).map(([key, callback]) => [`zeonest.pi-settings.${key}`, async (input) => { calls.push({ method: key, input }); return callback(input); }]));
  let root!: ReactTestRenderer;
  await act(async () => { root = create(<PiSettingsPage theme={theme} host={{ id: "host-1", label: "Host" }} layout={{ compact: options.compact ?? false, platform: "web" }} />); });
  t.after(async () => { await act(async () => root.unmount()); });
  const host = (type: string, label: string) => root.root.findAll((n) => typeof n.type === "string" && n.type === type && (n.props.label === label || n.props.accessibilityLabel === label))[0]!;
  return { root, calls, host };
}

test("save opens diff first; cancel never calls commit and retains draft", async (t) => {
  const { root, calls, host } = await mount(t);
  await act(async () => host("SettingsInput", "默认模型 ID").props.onChangeText("new-model"));
  await act(async () => host("SettingsAction", "保存模型默认值").props.onPress());
  assert.equal(calls.filter((c) => c.method === "commit").length, 0);
  assert.equal(root.root.findAll((n) => String(n.type) === "Modal" && n.props.title === "确认配置改动").length, 1);
  assert.match(JSON.stringify(root.toJSON()), /new-model/);
  await act(async () => host("Pressable", "取消，不写入").props.onPress());
  assert.equal(calls.filter((c) => c.method === "discard").length, 1);
  assert.equal(calls.filter((c) => c.method === "commit").length, 0);
  assert.equal(host("SettingsSelect", "全局 / 项目工作区").props.disabled, true);
});

test("confirmed save commits the server token; failure remains visible without success", async (t) => {
  const { root, calls, host } = await mount(t, { commitError: true, compact: true });
  await act(async () => host("SettingsInput", "默认模型 ID").props.onChangeText("new-model"));
  await act(async () => host("SettingsAction", "保存模型默认值").props.onPress());
  await act(async () => host("Pressable", "确认应用").props.onPress());
  assert.deepEqual(calls.find((c) => c.method === "commit")!.input, { token: "preview-1", confirmed: true });
  assert.match(JSON.stringify(root.toJSON()), /stale revision/);
  assert.equal(root.root.findAll((n) => String(n.type) === "Modal" && n.props.title === "确认配置改动").length, 1);
});

test("disabled confirmation uses the same prepare endpoint then commits without modal", async (t) => {
  const { root, calls, host } = await mount(t, { confirmDiff: false });
  await act(async () => host("SettingsInput", "默认模型 ID").props.onChangeText("new-model"));
  await act(async () => host("SettingsAction", "保存模型默认值").props.onPress());
  assert.deepEqual(calls.filter((c) => c.method === "prepare" || c.method === "commit").map((c) => c.method), ["prepare", "commit"]);
  assert.deepEqual(calls.find((c) => c.method === "commit")!.input, { token: "preview-1", confirmed: false });
  assert.equal(root.root.findAll((n) => String(n.type) === "Modal" && n.props.title === "确认配置改动").length, 0);
});

test("provider editor manages individual models and prepares the full model diff", async (t) => {
  const { calls, host } = await mount(t);
  await act(async () => host("Pressable", "添加供应商").props.onPress());
  await act(async () => host("SettingsInput", "供应商 ID").props.onChangeText("custom"));
  const baseUrlField = host("TextInput", "Base URL");
  await act(async () => baseUrlField.props.onChangeText("https://custom.example/v1"));
  assert.equal(host("TextInput", "Base URL"), baseUrlField, "typing must not remount the native input");
  await act(async () => host("Pressable", "添加自定义模型").props.onPress());
  await act(async () => host("TextInput", "模型 2 · ID").props.onChangeText("second-model"));
  await act(async () => host("Pressable", "保存并预览改动").props.onPress());
  const request = calls.find((call) => call.method === "prepare")!.input;
  assert.equal(request.edits[0].kind, "models");
  const providers = JSON.parse(request.edits[0].text).providers;
  assert.equal(providers.custom.baseUrl, "https://custom.example/v1");
  assert.deepEqual(providers.custom.models.map((model: { id: string }) => model.id), ["model-id", "second-model"]);
  assert.equal(calls.filter((call) => call.method === "commit").length, 0);
});

test("saving one section never discards another section's unsaved draft", async (t) => {
  const { host } = await mount(t, { confirmDiff: false });
  await act(async () => host("SettingsInput", "默认模型 ID").props.onChangeText("unsaved-model"));
  await act(async () => host("Pressable", "页面设置").props.onPress());
  await act(async () => host("SettingsInput", "Pi 可执行文件").props.onChangeText("custom-pi"));
  await act(async () => host("SettingsAction", "保存页面设置").props.onPress());
  assert.equal(host("SettingsSelect", "全局 / 项目工作区").props.disabled, true);
  await act(async () => host("Pressable", "模型").props.onPress());
  assert.equal(host("SettingsInput", "默认模型 ID").props.initialValue, "unsaved-model");
});

test("compact page and diff use supplied theme tokens", async (t) => {
  const { root } = await mount(t, { compact: true });
  const output = JSON.stringify(root.toJSON()); assert.match(output, /#001100/); assert.match(output, /#005500/);
});
