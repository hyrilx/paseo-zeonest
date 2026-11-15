import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import React, { StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import { preferencesSchema } from "../shared/settings";
import { listDashboardAgents, listDashboardWorkspaces, resolveDashboard, screenId } from "../shared/contracts";

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: { contents: `export { DashboardScreen, DashboardSidebar } from './screen'; export { DashboardSettings } from './settings'; export { startPills } from './runtime'; export { default as contribute } from './index';`, resolveDir: new URL("../client", import.meta.url).pathname, loader: "tsx" },
  bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react/jsx-runtime"],
  plugins: [{ name: "native-host", setup(builder) {
    builder.onResolve({ filter: /^(@getpaseo\/plugin\/client(?:\/ui)?|react-native)$/ }, (args) => ({ path: args.path, namespace: "test-host" }));
    builder.onLoad({ filter: /.*/, namespace: "test-host" }, (args) => ({ loader: "js", contents: args.path.endsWith("/client")
      ? `export const useRpc = contract => input => globalThis.__billionHost.rpc[contract.name](input); export const useSettings = () => globalThis.__billionHost.settings;`
      : `import React from 'react'; const component = name => props => React.createElement(name, props, props.children);
        export const Text = component('Text'), View = component('View'), ScrollView = component('ScrollView'), ExternalLink = component('ExternalLink'), SidebarRow = component('SidebarRow');
        export const SettingsAction = component('SettingsAction'), SettingsCard = component('SettingsCard'), SettingsInput = component('SettingsInput'), SettingsRow = component('SettingsRow'), SettingsSection = component('SettingsSection'), SettingsSelect = component('SettingsSelect');` }));
  } }],
});
const module = { exports: {} as { DashboardScreen: React.ComponentType<PluginScreenProps>; DashboardSidebar: React.ComponentType<any>; DashboardSettings: React.ComponentType<any>; startPills(client: PluginClientContext, intervalMs?: number): () => void; contribute(client: PluginClientContext): () => void } };
new Function("require", "module", "exports", compiled.outputFiles[0]!.text)(require, module, module.exports);
const { DashboardScreen, DashboardSidebar, DashboardSettings, startPills, contribute } = module.exports;
const globals = globalThis as typeof globalThis & { __billionHost: { rpc: Record<string, (input: any) => Promise<any>>; settings: any }; IS_REACT_ACT_ENVIRONMENT: boolean };
globals.IS_REACT_ACT_ENVIRONMENT = true;
const props: PluginScreenProps = { params: {}, host: { id: "remote-host", label: "Host" }, layout: { compact: true, platform: "web" }, theme: { colors: {
  surface0: "surface0", surface1: "surface1", surface2: "surface2", border: "border", foreground: "foreground", foregroundMuted: "muted", accent: "accent", accentForeground: "accentText", statusSuccess: "success", statusWarning: "warning", statusDanger: "danger",
} } };
const target = { url: "https://client.test/__bili/#/session/exact", workspaceId: "w" };
function setup() {
  const calls: any[] = [];
  globals.__billionHost = { settings: {}, rpc: {
    [listDashboardWorkspaces.name]: async () => [{ id: "w", name: "Workspace" }, { id: "other", name: "Other" }],
    [resolveDashboard.name]: async (input) => { calls.push(input); return { ...target, workspaceId: input.workspaceId }; },
  } };
  return calls;
}
function find(root: ReactTestRenderer, type: string, label?: string) {
  return root.root.findAll((node) => typeof node.type === "string" && node.type === type && (!label || node.props.label === label || node.props.accessibilityLabel === label))[0];
}
async function mount(t: { after(fn: () => Promise<void>): void }, element: React.ReactElement) {
  let root!: ReactTestRenderer; await act(async () => { root = create(element); });
  t.after(async () => { await act(async () => root.unmount()); }); return root;
}
test("sidebar opens overview and exposes active state", async (t) => {
  let location: any;
  const root = await mount(t, <DashboardSidebar {...props} currentScreen={{ screenId, params: {} }} openScreen={(value: any) => { location = value; }} />);
  assert.equal(find(root, "SidebarRow")!.props.active, true);
  find(root, "SidebarRow")!.props.onPress(); assert.deepEqual(location, { screenId });
});
test("overview selects a workspace; desktop opens on the owning host only after user action", async (t) => {
  const calls = setup(); const opened: any[] = [];
  const root = await mount(t, <DashboardScreen {...props} navigation={{ openBrowser: (input) => { opened.push(input); }, openAgent() {}, openWorkspace() {} }} />);
  assert.deepEqual(opened, []); assert.deepEqual(calls, []);
  await act(async () => find(root, "SettingsSelect", "工作区")!.props.onValueChange("other"));
  await act(async () => find(root, "SettingsAction", "查看 dashboard 总览")!.props.onPress());
  assert.deepEqual(calls, [{ workspaceId: "other" }]);
  assert.deepEqual(opened, [{ ...target, workspaceId: "other", serverId: "remote-host" }]);
  await act(async () => find(root, "SettingsSelect", "工作区")!.props.onValueChange("w"));
  assert.equal(find(root, "ExternalLink"), undefined);
});
test("one pill click route resolves exact detail and auto-opens desktop; strict effects do not strand loading", async (t) => {
  const calls = setup(); const opened: any[] = [];
  const root = await mount(t, <StrictMode><DashboardScreen {...props} params={{ agentId: "a", workspaceId: "w" }} navigation={{ openBrowser: (input) => { opened.push(input); }, openAgent() {}, openWorkspace() {} }} /></StrictMode>);
  assert.ok(calls.every((input) => input.agentId === "a" && input.workspaceId === "w"));
  assert.deepEqual(opened, [{ ...target, serverId: "remote-host" }]);
  assert.equal(find(root, "SettingsAction", "重新定位当前会话")!.props.disabled, false);
});
test("web/mobile detail only offers a direct external link and uses native compact/theme tokens", async (t) => {
  setup();
  const root = await mount(t, <DashboardScreen {...props} layout={{ compact: true, platform: "ios" }} params={{ agentId: "a", workspaceId: "w" }} />);
  assert.equal(find(root, "ExternalLink")!.props.href, target.url);
  assert.equal(find(root, "SettingsAction", "在工作区浏览器重新打开"), undefined);
  assert.equal(find(root, "ScrollView")!.props.contentContainerStyle.padding, 16);
  assert.match(JSON.stringify(root.toJSON()), /surface0/); assert.match(JSON.stringify(root.toJSON()), /foreground/);
});
test("dashboard/desktop errors stay visible with explicit retries; no automatic external fallback", async (t) => {
  setup();
  globals.__billionHost.rpc[resolveDashboard.name] = async () => { throw new Error("unknown exact session"); };
  const root = await mount(t, <DashboardScreen {...props} params={{ agentId: "a", workspaceId: "w" }} />);
  assert.match(JSON.stringify(root.toJSON()), /unknown exact session/); assert.equal(find(root, "ExternalLink"), undefined);
  globals.__billionHost.rpc[resolveDashboard.name] = async () => target;
  await act(async () => find(root, "SettingsAction", "重新定位当前会话")!.props.onPress());
  assert.equal(find(root, "ExternalLink")!.props.href, target.url);
  await act(async () => root.update(<DashboardScreen {...props} params={{ agentId: "different", workspaceId: "w" }} navigation={{ openBrowser() { throw new Error("browser unavailable"); }, openAgent() {}, openWorkspace() {} }} />));
  assert.match(JSON.stringify(root.toJSON()), /browser unavailable/); assert.equal(find(root, "ExternalLink")!.props.href, target.url);
});
test("workspace list failures can retry, and empty lists cannot open overview", async (t) => {
  setup(); globals.__billionHost.rpc[listDashboardWorkspaces.name] = async () => { throw new Error("offline"); };
  const root = await mount(t, <DashboardScreen {...props} />);
  assert.match(JSON.stringify(root.toJSON()), /offline/);
  globals.__billionHost.rpc[listDashboardWorkspaces.name] = async () => [];
  await act(async () => find(root, "SettingsAction", "重新读取工作区")!.props.onPress());
  assert.match(JSON.stringify(root.toJSON()), /暂无可用工作区/);
  assert.equal(find(root, "SettingsAction", "查看 dashboard 总览")!.props.disabled, true);
});
test("late route/host results cannot open a previous session", async (t) => {
  setup(); const opened: any[] = []; let finish!: (value: typeof target) => void;
  globals.__billionHost.rpc[resolveDashboard.name] = async ({ agentId }) => agentId === "old" ? new Promise((yes) => { finish = yes; }) : target;
  const navigation = { openBrowser: (value: any) => opened.push(value), openAgent() {}, openWorkspace() {} };
  const root = await mount(t, <DashboardScreen {...props} params={{ agentId: "old", workspaceId: "w" }} navigation={navigation} />);
  await act(async () => root.update(<DashboardScreen {...props} host={{ id: "new-host", label: "New" }} params={{ agentId: "new", workspaceId: "w" }} navigation={navigation} />));
  await act(async () => finish({ ...target, url: "https://old.test" }));
  assert.deepEqual(opened, [{ ...target, serverId: "new-host" }]);
});
test("pills reconcile without duplication, remove on archive/move/failure and clean late RPCs", async () => {
  let agents = [{ agentId: "a", workspaceId: "w" }]; let fail = false; let removed = 0; const registrations: any[] = []; const screens: any[] = [];
  const client = { rpc: async (contract: { name: string }) => { assert.equal(contract.name, listDashboardAgents.name); if (fail) throw new Error("offline"); return agents; },
    openScreen: (input: any) => screens.push(input), addComposerPill: (value: any) => { registrations.push(value); return { update() { assert.fail("no replacement needed"); }, remove() { removed++; } }; } } as unknown as PluginClientContext;
  const stop = startPills(client, 5);
  try {
    await delay(20); assert.equal(registrations.length, 1);
    registrations[0].button.behavior.onPress(); assert.deepEqual(screens, [{ screenId, params: { agentId: "a", workspaceId: "w" } }]);
    agents = [{ agentId: "a", workspaceId: "other" }]; await delay(20); assert.equal(removed, 1); assert.equal(registrations.length, 2);
    agents = []; await delay(20); assert.equal(removed, 2);
    agents = [{ agentId: "b", workspaceId: "w" }]; await delay(20); fail = true; await delay(20); assert.equal(removed, 3);
  } finally { stop(); stop(); }
  const before = screens.length; registrations[0].button.behavior.onPress(); assert.equal(screens.length, before);
  let finish!: (value: unknown) => void;
  const stopLate = startPills({ ...client, rpc: () => new Promise((yes) => { finish = yes; }) } as unknown as PluginClientContext, 5);
  stopLate(); finish([{ agentId: "late", workspaceId: "w" }]); await delay(5); assert.equal(registrations.length, 3);
});
test("client contribution cleans up screen/sidebar and rolls back partial registration", () => {
  const removed: string[] = [];
  const client = { rpc: async () => [], addScreen: () => () => { removed.push("screen"); }, addSidebarHeaderItem: () => () => { removed.push("sidebar"); } } as unknown as PluginClientContext;
  const stop = contribute(client); stop(); stop(); assert.deepEqual(removed, ["sidebar", "screen"]);
  assert.throws(() => contribute({ ...client, addSidebarHeaderItem() { throw new Error("registration failed"); } }));
  assert.deepEqual(removed, ["sidebar", "screen", "screen"]);
});
function settingsHost() {
  const saves: any[] = [];
  const state: any = { status: "ready", revision: "v1", values: preferencesSchema.parse({}), saving: false, saveError: null,
    save: async (values: unknown, revision: string) => { saves.push({ values, revision }); state.saveError = "revision conflict"; return false; }, reload: async () => {}, reset: async () => true };
  globals.__billionHost = { settings: state, rpc: {} }; return { state, saves };
}
test("settings validate origins and preserve draft/revision when another client saves", async (t) => {
  const { state, saves } = settingsHost(); const root = await mount(t, <DashboardSettings {...props} />);
  await act(async () => find(root, "SettingsInput", "宿主侧实例地址")!.props.onChangeText("http://user:secret@host"));
  await act(async () => find(root, "SettingsAction", "保存 dashboard 配置")!.props.onPress());
  assert.equal(saves.length, 0); assert.match(JSON.stringify(root.toJSON()), /不含路径或凭据/);
  await act(async () => find(root, "SettingsInput", "宿主侧实例地址")!.props.onChangeText("http://my-host:4444"));
  state.revision = "v2"; state.values = preferencesSchema.parse({ serverOrigin: "http://remote:8888" });
  await act(async () => root.update(<DashboardSettings {...props} />));
  await act(async () => find(root, "SettingsAction", "保存 dashboard 配置")!.props.onPress());
  assert.deepEqual(saves, [{ values: { serverOrigin: "http://my-host:4444", browserOrigin: "" }, revision: "v1" }]);
  await act(async () => root.update(<DashboardSettings {...props} />));
  assert.match(JSON.stringify(root.toJSON()), /revision conflict/);
  assert.equal(find(root, "SettingsInput", "宿主侧实例地址")!.props.initialValue, "http://my-host:4444");
});
test("invalid settings have explicit reset and reload even with business disabled", async (t) => {
  const { state } = settingsHost(); state.status = "invalid"; state.error = "invalid origin";
  const root = await mount(t, <DashboardSettings {...props} />);
  assert.ok(find(root, "SettingsAction", "恢复默认 dashboard 地址"));
  assert.ok(find(root, "SettingsAction", "丢弃草稿并重新读取"));
});
