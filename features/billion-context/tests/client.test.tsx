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
      ? `export const useRpc = contract => input => globalThis.__billionHost.rpc[contract.name](input); export const useSettings = () => globalThis.__billionHost.settings; export const openExternalUrl = url => globalThis.__billionHost.external(url);`
      : `import React from 'react'; const component = name => props => React.createElement(name, props, props.children);
        export const Text = component('Text'), View = component('View'), ScrollView = component('ScrollView'), ExternalLink = component('ExternalLink'), SidebarRow = component('SidebarRow');
        export const SettingsAction = component('SettingsAction'), SettingsCard = component('SettingsCard'), SettingsInput = component('SettingsInput'), SettingsRow = component('SettingsRow'), SettingsSection = component('SettingsSection'), SettingsSelect = component('SettingsSelect');` }));
  } }],
});
const module = { exports: {} as { DashboardScreen: React.ComponentType<PluginScreenProps>; DashboardSidebar: React.ComponentType<any>; DashboardSettings: React.ComponentType<any>; startPills(client: PluginClientContext, intervalMs?: number): () => void; contribute(client: PluginClientContext): () => void } };
new Function("require", "module", "exports", compiled.outputFiles[0]!.text)(require, module, module.exports);
const { DashboardScreen, DashboardSidebar, DashboardSettings, startPills, contribute } = module.exports;
const globals = globalThis as typeof globalThis & { __billionHost: { rpc: Record<string, (input: any) => Promise<any>>; settings: any; external(url: string): Promise<void> }; IS_REACT_ACT_ENVIRONMENT: boolean };
globals.IS_REACT_ACT_ENVIRONMENT = true;
const props: PluginScreenProps = { params: {}, host: { id: "remote-host", label: "Host" }, layout: { compact: true, platform: "web" }, theme: { colors: {
  surface0: "surface0", surface1: "surface1", surface2: "surface2", border: "border", foreground: "foreground", foregroundMuted: "muted", accent: "accent", accentForeground: "accentText", statusSuccess: "success", statusWarning: "warning", statusDanger: "danger",
} } };
const target = { url: "https://client.test/__bili/#/session/exact", workspaceId: "w" };
const overview = { url: "https://client.test/__bili/", workspaceId: "w" };
function setup() {
  const calls: any[] = [];
  globals.__billionHost = { settings: {}, external: async () => {}, rpc: {
    [listDashboardWorkspaces.name]: async () => [{ id: "w", name: "Workspace" }, { id: "other", name: "Other" }],
    [resolveDashboard.name]: async (input) => { calls.push(input); return { ...(input.agentId ? target : overview), workspaceId: input.workspaceId }; },
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
  find(root, "SidebarRow")!.props.onPress(); assert.equal(location.screenId, screenId);
  assert.match(location.params.openedAt, /^[0-9]+$/);
});
test("sidebar overview auto-opens once on its host without choosing between multiple workspaces", async (t) => {
  const calls = setup(); const opened: any[] = [];
  const root = await mount(t, <StrictMode><DashboardScreen {...props} navigation={{ openBrowser: (input) => { opened.push(input); }, openAgent() {}, openWorkspace() {} }} /></StrictMode>);
  assert.deepEqual(calls, [{ workspaceId: "w" }]);
  assert.deepEqual(opened, [{ ...overview, serverId: "remote-host" }]);
  assert.equal(find(root, "SettingsSelect", "工作区"), undefined);
  assert.equal(find(root, "SettingsAction", "查看 dashboard 总览"), undefined);
});
test("one pill click route resolves exact detail and auto-opens desktop; strict effects do not strand loading", async (t) => {
  const calls = setup(); const opened: any[] = [];
  const root = await mount(t, <StrictMode><DashboardScreen {...props} params={{ agentId: "a", workspaceId: "w" }} navigation={{ openBrowser: (input) => { opened.push(input); }, openAgent() {}, openWorkspace() {} }} /></StrictMode>);
  assert.ok(calls.every((input) => input.agentId === "a" && input.workspaceId === "w"));
  assert.deepEqual(opened, [{ ...target, serverId: "remote-host" }]);
  assert.equal(find(root, "SettingsAction", "重新定位当前会话")!.props.disabled, false);
});
test("web/mobile detail auto-opens externally and retains a direct recovery link and theme tokens", async (t) => {
  setup(); const opened: string[] = [];
  globals.__billionHost.external = async (url) => { opened.push(url); };
  const root = await mount(t, <DashboardScreen {...props} layout={{ compact: true, platform: "ios" }} params={{ agentId: "a", workspaceId: "w" }} />);
  assert.deepEqual(opened, [target.url]);
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
  assert.equal(find(root, "ExternalLink"), undefined);
  assert.equal(find(root, "SettingsSelect", "工作区"), undefined);
  assert.equal(find(root, "SettingsAction", "重新读取工作区")!.props.disabled, false);
});
test("multiple instances never auto-open and selection re-resolves the chosen instance", async (t) => {
  setup(); const opened: any[] = [], calls: any[] = [];
  const instances = ["http://127.0.0.1:9001", "http://127.0.0.1:9002"];
  globals.__billionHost.rpc[resolveDashboard.name] = async (input) => {
    calls.push(input); return input.instanceOrigin ? target : { instances, workspaceId: "w" };
  };
  const root = await mount(t, <StrictMode><DashboardScreen {...props} params={{ agentId: "a", workspaceId: "w" }}
    navigation={{ openBrowser: (input) => { opened.push(input); }, openAgent() {}, openWorkspace() {} }} /></StrictMode>);
  assert.deepEqual(opened, []); assert.equal(find(root, "ExternalLink"), undefined);
  assert.equal(find(root, "SettingsAction", "打开选定实例")!.props.disabled, true);
  const selector = find(root, "SettingsSelect", "实例")!;
  assert.equal(selector.props.value, ""); assert.equal(selector.props.options.length, 3);
  await act(async () => selector.props.onValueChange(instances[1]));
  assert.equal(find(root, "SettingsAction", "打开选定实例")!.props.disabled, false);
  await act(async () => find(root, "SettingsAction", "打开选定实例")!.props.onPress());
  assert.deepEqual(calls.at(-1), { workspaceId: "w", agentId: "a", instanceOrigin: instances[1] });
  assert.deepEqual(opened, [{ ...target, serverId: "remote-host" }]);
  assert.equal(find(root, "SettingsSelect", "实例"), undefined);
});
test("overview only asks for an instance; failed choices can rediscover or recover in another browser workspace", async (t) => {
  setup();
  globals.__billionHost.rpc[resolveDashboard.name] = async (input) => {
    if (input.instanceOrigin) throw new Error("实例记录已改变");
    return { instances: ["http://127.0.0.1:9001", "http://127.0.0.1:9002"], workspaceId: input.workspaceId };
  };
  const root = await mount(t, <DashboardScreen {...props} />);
  assert.ok(find(root, "SettingsSelect", "实例"));
  assert.equal(find(root, "SettingsSelect", "工作区"), undefined);
  await act(async () => find(root, "SettingsSelect", "实例")!.props.onValueChange("http://127.0.0.1:9002"));
  await act(async () => find(root, "SettingsAction", "打开选定实例")!.props.onPress());
  assert.match(JSON.stringify(root.toJSON()), /实例记录已改变/); assert.equal(find(root, "ExternalLink"), undefined);
  await act(async () => find(root, "SettingsAction", "重新读取工作区")!.props.onPress());
  assert.ok(find(root, "SettingsSelect", "实例"));
  assert.equal(find(root, "SettingsSelect", "实例")!.props.value, "");
  await act(async () => find(root, "SettingsSelect", "实例")!.props.onValueChange("http://127.0.0.1:9001"));
  await act(async () => find(root, "SettingsAction", "打开选定实例")!.props.onPress());
  await act(async () => find(root, "SettingsSelect", "工作区")!.props.onValueChange("other"));
  assert.equal(find(root, "SettingsSelect", "实例")!.props.value, "");
  assert.equal(find(root, "SettingsSelect", "工作区"), undefined);
});
test("web overview automatically opens its global URL, not a second workspace-selection screen", async (t) => {
  const calls = setup(); const opened: string[] = [];
  globals.__billionHost.external = async (url) => { opened.push(url); };
  const root = await mount(t, <StrictMode><DashboardScreen {...props} /></StrictMode>);
  assert.deepEqual(calls, [{ workspaceId: "w" }]);
  assert.deepEqual(opened, [overview.url]);
  assert.equal(find(root, "SettingsSelect"), undefined);
});
test("blocked external opening preserves an explicit user-gesture link and retry", async (t) => {
  setup(); let attempts = 0;
  globals.__billionHost.external = async () => { attempts++; throw new Error("popup blocked"); };
  const root = await mount(t, <DashboardScreen {...props} params={{ agentId: "a", workspaceId: "w" }} />);
  assert.equal(attempts, 1); assert.match(JSON.stringify(root.toJSON()), /popup blocked/);
  assert.equal(find(root, "ExternalLink")!.props.href, target.url);
  assert.equal(find(root, "SettingsAction", "重新定位当前会话")!.props.disabled, false);
  globals.__billionHost.external = async () => { attempts++; };
  await act(async () => find(root, "SettingsAction", "重新定位当前会话")!.props.onPress());
  assert.equal(attempts, 2); assert.doesNotMatch(JSON.stringify(root.toJSON()), /popup blocked/);
});
test("overview browser failure exposes an optional workspace recovery, with immediate reopening", async (t) => {
  const calls = setup(); const opened: any[] = [], external: string[] = [];
  globals.__billionHost.external = async (url) => { external.push(url); };
  const root = await mount(t, <DashboardScreen {...props} navigation={{ openBrowser: (input) => {
    if (input.workspaceId === "w") throw new Error("workspace tab unavailable");
    opened.push(input);
  }, openAgent() {}, openWorkspace() {} }} />);
  assert.match(JSON.stringify(root.toJSON()), /workspace tab unavailable/);
  assert.equal(find(root, "SettingsSelect", "工作区")!.props.value, "w");
  assert.deepEqual(external, []);
  await act(async () => find(root, "SettingsSelect", "工作区")!.props.onValueChange("other"));
  assert.deepEqual(calls, [{ workspaceId: "w" }, { workspaceId: "other" }]);
  assert.deepEqual(opened, [{ ...overview, workspaceId: "other", serverId: "remote-host" }]);
  assert.equal(find(root, "SettingsSelect", "工作区"), undefined);
});
test("a missing capsule workspace is an error, not an invitation to select a different workspace", async (t) => {
  const calls = setup(); const opened: string[] = [];
  globals.__billionHost.external = async (url) => { opened.push(url); };
  globals.__billionHost.rpc[listDashboardWorkspaces.name] = async () => { assert.fail("must not guess a workspace"); };
  const root = await mount(t, <DashboardScreen {...props} params={{ agentId: "a" }} />);
  assert.match(JSON.stringify(root.toJSON()), /缺少会话工作区/);
  assert.deepEqual(calls, []); assert.deepEqual(opened, []);
  assert.equal(find(root, "SettingsSelect"), undefined);
});
test("a late overview workspace list cannot navigate back to a previous host", async (t) => {
  const calls = setup(); const opened: any[] = []; let finish!: (values: { id: string; name: string }[]) => void; let reads = 0;
  globals.__billionHost.rpc[listDashboardWorkspaces.name] = async () => ++reads === 1
    ? new Promise((yes) => { finish = yes; }) : [{ id: "new-workspace", name: "New" }];
  const navigation = { openBrowser: (value: any) => { opened.push(value); }, openAgent() {}, openWorkspace() {} };
  const root = await mount(t, <DashboardScreen {...props} navigation={navigation} />);
  await act(async () => root.update(<DashboardScreen {...props} host={{ id: "new-host", label: "New" }} navigation={navigation} />));
  await act(async () => finish([{ id: "old-workspace", name: "Old" }]));
  assert.deepEqual(calls, [{ workspaceId: "new-workspace" }]);
  assert.deepEqual(opened, [{ ...overview, workspaceId: "new-workspace", serverId: "new-host" }]);
});
const reentryRoutes: PluginScreenProps["params"][] = [{}, { agentId: "a", workspaceId: "w" }];
for (const route of reentryRoutes) {
  test(`a new entry marker reopens the same ${"agentId" in route ? "detail" : "overview"} route directly`, async (t) => {
    setup(); const opened: string[] = [];
    globals.__billionHost.external = async (url) => { opened.push(url); };
    const root = await mount(t, <DashboardScreen {...props} params={{ ...route, openedAt: "1" }} />);
    await act(async () => root.update(<DashboardScreen {...props} params={{ ...route, openedAt: "2" }} />));
    assert.deepEqual(opened, ["agentId" in route ? target.url : overview.url, "agentId" in route ? target.url : overview.url]);
  });
}
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
    registrations[0].button.behavior.onPress(); assert.equal(screens[0].screenId, screenId);
    assert.deepEqual({ ...screens[0].params, openedAt: undefined }, { agentId: "a", workspaceId: "w", openedAt: undefined });
    assert.match(screens[0].params.openedAt, /^[0-9]+$/);
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
  globals.__billionHost = { settings: state, rpc: {}, external: async () => {} }; return { state, saves };
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
test("settings support empty automatic discovery and preserve the client port template until navigation", async (t) => {
  const { saves } = settingsHost(); const root = await mount(t, <DashboardSettings {...props} />);
  assert.equal(find(root, "SettingsInput", "宿主侧实例地址")!.props.initialValue, "");
  await act(async () => find(root, "SettingsInput", "客户端访问地址（可选）")!.props.onChangeText(" https://my-host:{port}/// "));
  await act(async () => find(root, "SettingsAction", "保存 dashboard 配置")!.props.onPress());
  assert.deepEqual(saves, [{ values: { serverOrigin: "", browserOrigin: "https://my-host:{port}" }, revision: "v1" }]);
  await act(async () => find(root, "SettingsInput", "客户端访问地址（可选）")!.props.onChangeText("http://{port}.test"));
  await act(async () => find(root, "SettingsAction", "保存 dashboard 配置")!.props.onPress());
  assert.equal(saves.length, 1); assert.match(JSON.stringify(root.toJSON()), /端口可用/);
});
test("invalid settings have explicit reset and reload even with business disabled", async (t) => {
  const { state } = settingsHost(); state.status = "invalid"; state.error = "invalid origin";
  const root = await mount(t, <DashboardSettings {...props} />);
  assert.ok(find(root, "SettingsAction", "恢复自动发现默认配置"));
  assert.ok(find(root, "SettingsAction", "丢弃草稿并重新读取"));
});
