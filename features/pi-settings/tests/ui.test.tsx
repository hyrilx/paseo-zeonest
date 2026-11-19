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
const compiled = await build({ stdin: { contents: `export { PiSettingsPage } from "../client/page"; export { PiPluginPreferences } from "../client/settings";`, resolveDir: new URL(".", import.meta.url).pathname }, bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", external: ["react", "react/jsx-runtime"], plugins: [{ name: "paseo-test-host", setup(builder) {
  builder.onResolve({ filter: /^(@getpaseo\/plugin\/client(?:\/ui)?|react-native)$/ }, (args) => ({ path: args.path, namespace: "test-host" }));
  builder.onLoad({ filter: /.*/, namespace: "test-host" }, (args) => ({ loader: "js", contents: args.path.endsWith("/client")
    ? `export const useRpc = contract => globalThis.__piTestRpc[contract.name];`
    : `import React from 'react';
      const component = name => props => React.createElement(name, props, props.children);
      export const Linking = { openURL: async () => {} };
      export const Text = component('Text'), View = component('View'), Pressable = component('Pressable'), TextInput = component('TextInput'), ScrollView = component('ScrollView');
      export const SettingsAction = component('SettingsAction'), SettingsCard = component('SettingsCard'), SettingsInput = component('SettingsInput'), SettingsRow = component('SettingsRow'), SettingsSection = component('SettingsSection'), SettingsSelect = component('SettingsSelect'), SettingsSwitch = component('SettingsSwitch');
      export const Modal = props => props.open ? React.createElement('Modal', props, props.children) : null;
      Modal.Content = component('ModalContent');` }));
} }] });
const module = { exports: {} as { PiSettingsPage: React.ComponentType<PluginSurfaceProps>; PiPluginPreferences: React.ComponentType<PluginSurfaceProps> } };
new Function("require", "module", "exports", compiled.outputFiles[0]!.text)(require, module, module.exports);
const { PiSettingsPage, PiPluginPreferences } = module.exports;
const globals = globalThis as typeof globalThis & { __piTestRpc: Record<string, (input: any) => Promise<any>>; IS_REACT_ACT_ENVIRONMENT: boolean };
globals.IS_REACT_ACT_ENVIRONMENT = true;
const theme: PluginSurfaceProps["theme"] = { colors: { surface0: "#001100", surface1: "#002200", surface2: "#003300", border: "#004400", foreground: "#005500", foregroundMuted: "#006600", accent: "#007700", accentForeground: "#008800", statusSuccess: "#009900", statusWarning: "#00aa00", statusDanger: "#00bb00" } };
function snapshot(confirmDiff = true): Snapshot {
  return { scope: {}, directory: "/test/agent", agentDir: "/test/agent", defaultAgentDir: "/test/agent", preferences: preferencesSchema.parse({ confirmDiff }),
    documents: ["settings", "models", "mcp", "preferences"].map((kind) => ({ kind: kind as Snapshot["documents"][number]["kind"], path: `/test/agent/${kind}.json`, text: kind === "preferences" ? JSON.stringify({ confirmDiff }) : "{}", revision: "v1", exists: true, error: null })),
    globalSettings: "{}", globalMcp: "{}", resources: [], packages: [], warnings: [] };
}
async function mount(t: { after(fn: () => Promise<void>): void }, options: { confirmDiff?: boolean; commitError?: boolean; compact?: boolean; preferences?: boolean; warnings?: string[]; configure?(state: Snapshot): void; handlers?: Record<string, (input: any) => Promise<any>> } = {}) {
  const calls: { method: string; input: any }[] = [];
  const state = snapshot(options.confirmDiff ?? true);
  state.warnings = options.warnings ?? [];
  options.configure?.(state);
  const plan: Preview = { token: "preview-1", title: "Save", expiresAt: "2099-01-01T00:00:00Z", confirmationRequired: options.confirmDiff ?? true, changes: [{ path: "/test/agent/settings.json", diff: "--- old\n+++ new\n+new-model\n", additions: 1, deletions: 0 }], artifacts: [], warnings: [] };
  const handlers: Record<string, (input: any) => Promise<any>> = {
    read: async (scope) => ({ ...state, scope }), preferences: async () => ({ document: state.documents.find((d) => d.kind === "preferences"), defaultAgentDir: state.defaultAgentDir }),
    workspaces: async () => [{ id: "workspace-2", name: "项目二", directory: "/test/worktrees/project-two" }], prepare: async (input) => ({ ...plan, changes: input.edits.map((edit: {kind: string}) => ({ ...plan.changes[0], path: state.documents.find((d) => d.kind === edit.kind)!.path })) }),
    commit: async () => { if (options.commitError) throw new Error("stale revision"); return { message: "Saved" }; }, discard: async () => ({ discarded: true }),
    models: async () => [{ provider: "example", id: "small", context: "32K", maxOutput: "8K", reasoning: true, images: false }],
    "test-model": async () => ({ elapsedMs: 26 }),
    "probe-mcp": async () => ({ state: "connected", tools: ["search_items"] }),
    "search-packages": async () => [{ name: "pi-example", version: "1.0.0", description: "Example package" }],
    ...options.handlers,
  };
  globals.__piTestRpc = Object.fromEntries(Object.entries(handlers).map(([key, callback]) => [`zeonest.pi-settings.${key}`, async (input) => { calls.push({ method: key, input }); return callback(input); }]));
  let root!: ReactTestRenderer;
  const Surface = options.preferences ? PiPluginPreferences : PiSettingsPage;
  await act(async () => { root = create(<Surface theme={theme} host={{ id: "host-1", label: "Host" }} layout={{ compact: options.compact ?? false, platform: "web" }} />); });
  t.after(async () => { await act(async () => root.unmount()); });
  const host = (type: string, label: string) => root.root.findAll((n) => typeof n.type === "string" && n.type === type && (n.props.label === label || n.props.accessibilityLabel === label))[0]!;
  return { root, calls, host, state };
}

test("save opens diff first; cancel never calls commit and retains draft", async (t) => {
  const { root, calls, host } = await mount(t);
  await act(async () => host("TextInput", "默认模型 ID").props.onChangeText("new-model"));
  await act(async () => host("Pressable", "保存").props.onPress());
  assert.equal(calls.filter((c) => c.method === "commit").length, 0);
  assert.equal(root.root.findAll((n) => String(n.type) === "Modal" && n.props.title === "确认配置改动").length, 1);
  assert.match(JSON.stringify(root.toJSON()), /new-model/);
  await act(async () => host("Pressable", "取消，不写入").props.onPress());
  assert.equal(calls.filter((c) => c.method === "discard").length, 1);
  assert.equal(calls.filter((c) => c.method === "commit").length, 0);
  assert.equal(host("Pressable", "全局 / 项目工作区").props.disabled, true);
});

test("confirmed save commits the server token; failure remains visible without success", async (t) => {
  const { root, calls, host } = await mount(t, { commitError: true, compact: true });
  await act(async () => host("Pressable", "默认值与模型范围").props.onPress());
  await act(async () => host("TextInput", "默认模型 ID").props.onChangeText("new-model"));
  await act(async () => host("Pressable", "保存").props.onPress());
  await act(async () => host("Pressable", "确认应用").props.onPress());
  assert.deepEqual(calls.find((c) => c.method === "commit")!.input, { token: "preview-1", confirmed: true });
  assert.match(JSON.stringify(root.toJSON()), /stale revision/);
  assert.equal(root.root.findAll((n) => String(n.type) === "Modal" && n.props.title === "确认配置改动").length, 1);
});

test("disabled confirmation uses the same prepare endpoint then commits without modal", async (t) => {
  const { root, calls, host } = await mount(t, { confirmDiff: false });
  await act(async () => host("TextInput", "默认模型 ID").props.onChangeText("new-model"));
  await act(async () => host("Pressable", "保存").props.onPress());
  assert.deepEqual(calls.filter((c) => c.method === "prepare" || c.method === "commit").map((c) => c.method), ["prepare", "commit"]);
  assert.deepEqual(calls.find((c) => c.method === "commit")!.input, { token: "preview-1", confirmed: false });
  assert.equal(root.root.findAll((n) => String(n.type) === "Modal" && n.props.title === "确认配置改动").length, 0);
});

test("provider editor manages individual models and prepares the full model diff", async (t) => {
  const { calls, host } = await mount(t);
  await act(async () => host("Pressable", "添加供应商").props.onPress());
  await act(async () => host("TextInput", "供应商 ID").props.onChangeText("custom"));
  await act(async () => host("Pressable", "编辑 模型 1").props.onPress());
  await act(async () => host("TextInput", "模型 1 · ID").props.onChangeText("model-id"));
  const baseUrlField = host("TextInput", "Base URL");
  await act(async () => baseUrlField.props.onChangeText("https://custom.example/v1"));
  assert.equal(host("TextInput", "Base URL"), baseUrlField, "typing must not remount the native input");
  await act(async () => host("Pressable", "添加自定义模型").props.onPress());
  await act(async () => host("TextInput", "模型 2 · ID").props.onChangeText("second-model"));
  await act(async () => host("Pressable", "保存").props.onPress());
  const request = calls.find((call) => call.method === "prepare")!.input;
  assert.equal(request.edits[0].kind, "models");
  const providers = JSON.parse(request.edits[0].text).providers;
  assert.equal(providers.custom.baseUrl, "https://custom.example/v1");
  assert.deepEqual(providers.custom.models.map((model: { id: string }) => model.id), ["model-id", "second-model"]);
  assert.equal(calls.filter((call) => call.method === "commit").length, 0);
});

test("the pinned save action collects drafts across tabs, and cancellation keeps them", async (t) => {
  const { host, calls } = await mount(t);
  await act(async () => host("TextInput", "默认模型 ID").props.onChangeText("unsaved-model"));
  assert.equal(host("Pressable", "页面设置"), undefined);
  await act(async () => host("Pressable", "MCP").props.onPress());
  await act(async () => host("Pressable", "代码模式").props.onPress());
  await act(async () => host("SettingsSelect", "MCP 按需启用").props.onValueChange("false"));
  await act(async () => host("Pressable", "保存").props.onPress());
  assert.deepEqual(calls.find((call) => call.method === "prepare")!.input.edits.map((edit: {kind: string}) => edit.kind), ["settings", "mcp"]);
  await act(async () => host("Pressable", "取消，不写入").props.onPress());
  assert.equal(host("Pressable", "全局 / 项目工作区").props.disabled, true);
  await act(async () => host("Pressable", "模型").props.onPress());
  assert.equal(host("TextInput", "默认模型 ID").props.value, "unsaved-model");
});

test("compact page and diff use supplied theme tokens", async (t) => {
  const { root } = await mount(t, { compact: true });
  const output = JSON.stringify(root.toJSON()); assert.match(output, /#001100/); assert.match(output, /#005500/);
});

const warningToggle = (root: ReactTestRenderer) => root.root.findAll((node) =>
  String(node.type) === "Pressable" && typeof node.props.accessibilityLabel === "string" && node.props.accessibilityLabel.includes("配置警告，共"));

test("no warnings leave no warning card or extra scroll area", async (t) => {
  const { root } = await mount(t);
  assert.equal(warningToggle(root).length, 0);
  assert.equal(root.root.findAll((node) => String(node.type) === "ScrollView").length, 2);
});

test("many warnings start collapsed, expand in a bounded area and collapse without RPC", async (t) => {
  for (const compact of [false, true]) {
    const warnings = Array.from({ length: 100 }, (_, index) => `配置警告 ${index + 1}\n${"很长的路径/".repeat(50)}`);
    const { root, calls, host } = await mount(t, { compact, warnings });
    const warningTexts = () => root.root.findAll((node) => String(node.type) === "Text" && warnings.includes(node.props.children));
    assert.equal(warningToggle(root)[0]!.props.accessibilityState.expanded, false);
    assert.match(warningToggle(root)[0]!.props.accessibilityLabel, /共 100 条/);
    assert.equal(warningTexts().length, 1);
    assert.equal(warningTexts()[0]!.props.numberOfLines, 2);
    assert.equal(warningTexts()[0]!.props.style.color, theme.colors.statusWarning);
    const before = calls.length;
    await act(async () => warningToggle(root)[0]!.props.onPress());
    assert.equal(warningToggle(root)[0]!.props.accessibilityState.expanded, true);
    const scroll = host("ScrollView", "配置警告列表");
    assert.equal(scroll.props.style.maxHeight, compact ? 180 : 240);
    assert.equal(scroll.props.nestedScrollEnabled, true);
    assert.deepEqual(warningTexts().map((node) => node.props.children), warnings);
    assert.ok(warningTexts().every((node) => node.props.selectable && node.props.numberOfLines === undefined));
    assert.ok(host("Pressable", "默认值与模型范围"), "navigation remains mounted while warnings are expanded");
    await act(async () => warningToggle(root)[0]!.props.onPress());
    assert.equal(warningTexts().length, 1);
    assert.equal(root.root.findAll((node) => String(node.type) === "ScrollView").length, compact ? 1 : 2);
    assert.equal(calls.length, before);
  }
});

test("a single long warning is bounded too, and duplicate messages remain readable", async (t) => {
  const warning = "重复的警告\n".repeat(100);
  const { root } = await mount(t, { warnings: [warning] });
  assert.equal(root.root.findAll((node) => String(node.type) === "Text" && node.props.children === warning)[0]!.props.numberOfLines, 2);
  await act(async () => warningToggle(root)[0]!.props.onPress());
  assert.equal(root.root.findAll((node) => String(node.type) === "Text" && node.props.children === warning)[0]!.props.numberOfLines, undefined);
  const duplicate = await mount(t, { warnings: [warning, warning] });
  await act(async () => warningToggle(duplicate.root)[0]!.props.onPress());
  assert.equal(duplicate.root.root.findAll((node) => String(node.type) === "Text" && node.props.children === warning).length, 2);
});

test("refresh preserves expansion until the agent directory changes", async (t) => {
  const { root, host, state } = await mount(t, { warnings: ["配置目录警告"] });
  await act(async () => warningToggle(root)[0]!.props.onPress());
  await act(async () => host("Pressable", "刷新").props.onPress());
  assert.equal(warningToggle(root)[0]!.props.accessibilityState.expanded, true);
  state.agentDir = "/test/other-agent";
  await act(async () => host("Pressable", "刷新").props.onPress());
  assert.equal(warningToggle(root)[0]!.props.accessibilityState.expanded, false);
});

test("scope changes reset warning expansion; errors stay outside the collapsed warning list", async (t) => {
  const { root, host, state } = await mount(t, { warnings: ["首条警告", "第二条警告"], commitError: true });
  await act(async () => warningToggle(root)[0]!.props.onPress());
  await act(async () => host("Pressable", "全局 / 项目工作区").props.onPress());
  assert.match(JSON.stringify(root.toJSON()), /\/test\/worktrees\/project-two/);
  await act(async () => host("Pressable", "项目二").props.onPress());
  assert.equal(warningToggle(root)[0]!.props.accessibilityState.expanded, false);
  await act(async () => host("TextInput", "默认模型 ID").props.onChangeText("new-model"));
  await act(async () => host("Pressable", "保存").props.onPress());
  await act(async () => host("Pressable", "确认应用").props.onPress());
  assert.ok(root.root.findAll((node) => String(node.type) === "Text" && node.props.accessibilityRole === "alert" && node.props.children === "stale revision").length > 0);
  assert.equal(warningToggle(root)[0]!.props.accessibilityState.expanded, false);
  state.warnings = [];
  await act(async () => host("Pressable", "取消，不写入").props.onPress());
  await act(async () => host("Pressable", "刷新").props.onPress());
  await act(async () => host("Pressable", "放弃草稿并重新读取").props.onPress());
  assert.equal(warningToggle(root).length, 0);
});

test("catalog and model requests require confirmation and exact enabling preserves Pi matching rules", async (t) => {
  const { root, host, calls } = await mount(t, { compact: true, configure: (state) => {
    state.documents.find((doc) => doc.kind === "settings")!.text = '{"enabledModels":["other/*:high"]}';
  } });
  await act(async () => host("Pressable", "可用模型").props.onPress());
  await act(async () => host("Pressable", "读取 Pi 目录").props.onPress());
  assert.equal(calls.some(({ method }) => method === "models"), false);
  await act(async () => host("Pressable", "读取目录").props.onPress());
  assert.deepEqual(calls.find(({ method }) => method === "models")?.input, { confirmed: true, revision: "v1", preferencesRevision: "v1" });
  await act(async () => host("Pressable", "small").props.onPress());
  await act(async () => host("Pressable", "测试模型").props.onPress());
  assert.equal(calls.some(({ method }) => method === "test-model"), false);
  await act(async () => host("Pressable", "发送测试").props.onPress());
  assert.deepEqual(calls.find(({ method }) => method === "test-model")?.input, { confirmed: true, revision: "v1", preferencesRevision: "v1", provider: "example", id: "small" });
  assert.match(JSON.stringify(root.toJSON()), /26 ms/);
  await act(async () => host("Pressable", "添加精确规则").props.onPress());
  await act(async () => host("Pressable", "设为默认").props.onPress());
  await act(async () => host("Pressable", "保存").props.onPress());
  assert.deepEqual(JSON.parse(calls.find(({ method }) => method === "prepare")!.input.edits[0].text), {
    enabledModels: ["other/*:high", "example/small"], defaultProvider: "example", defaultModel: "small",
  });
});

test("MCP probe uses a saved selection; JSON import is staged separately", async (t) => {
  const { root, host, calls } = await mount(t, { configure: (state) => {
    state.documents.find((doc) => doc.kind === "mcp")!.text = '{"mcpServers":{"demo":{"command":"example"}}}';
  } });
  await act(async () => host("Pressable", "MCP").props.onPress());
  await act(async () => host("Pressable", "demo").props.onPress());
  await act(async () => host("Pressable", "测试连接").props.onPress());
  assert.equal(calls.some(({ method }) => method === "probe-mcp"), false);
  await act(async () => host("Pressable", "开始测试").props.onPress());
  assert.deepEqual(calls.find(({ method }) => method === "probe-mcp")?.input, { confirmed: true, revision: "v1", preferencesRevision: "v1", name: "demo" });
  assert.match(JSON.stringify(root.toJSON()), /search_items/);
  await act(async () => host("SettingsSelect", "从探测结果选择工具").props.onValueChange("search_items"));
  await act(async () => host("SettingsSelect", "添加工具规则").props.onValueChange("hidden"));
  assert.equal(host("SettingsSelect", "search_items").props.value, "hidden");
  assert.equal(host("Pressable", "测试连接").props.disabled, true);
  await act(async () => host("Pressable", "添加 MCP 服务器").props.onPress());
  await act(async () => host("Pressable", "导入 JSON").props.onPress());
  await act(async () => host("TextInput", "要导入的 MCP JSON").props.onChangeText('{"mcpServers":{"added":{"url":"https://example.org/mcp"}}}'));
  await act(async () => host("Pressable", "合并到草稿").props.onPress());
  assert.ok(host("Pressable", "added"));
  assert.equal(calls.some(({ method }) => method === "prepare"), false);
  await act(async () => host("Pressable", "保存").props.onPress());
  assert.deepEqual(JSON.parse(calls.find(({ method }) => method === "prepare")!.input.edits[0].text), { mcpServers: { demo: { command: "example", toolExposure: { search_items: "hidden" } }, added: { url: "https://example.org/mcp" } } });
});

test("skills apply bulk actions only to the filtered rows and keep all updated badges", async (t) => {
  const { host, calls } = await mount(t, { configure: (state) => {
    state.resources = ["example-one", "example-two", "other"].map((name) => ({ id: name, kind: "skill", scope: "global", name, description: "", path: `/test/agent/skills/${name}/SKILL.md`, enabled: true, modelInvocation: true }));
  } });
  await act(async () => host("Pressable", "技能").props.onPress());
  await act(async () => host("TextInput", "搜索技能").props.onChangeText("example"));
  await act(async () => host("Pressable", "批量操作").props.onPress());
  await act(async () => host("Pressable", "停用筛选结果").props.onPress());
  await act(async () => host("SettingsSelect", "筛选技能").props.onValueChange("disabled"));
  assert.ok(host("Pressable", "example-one") && host("Pressable", "example-two"));
  assert.equal(host("Pressable", "other"), undefined);
  await act(async () => host("Pressable", "保存").props.onPress());
  const rules = JSON.parse(calls.find(({ method }) => method === "prepare")!.input.edits[0].text).skills;
  assert.deepEqual(rules, ["-/test/agent/skills/example-one/SKILL.md", "-/test/agent/skills/example-two/SKILL.md"]);
});

test("package discovery searches npm only after an explicit action", async (t) => {
  const { host, calls } = await mount(t);
  await act(async () => host("Pressable", "插件").props.onPress());
  assert.equal(host("Pressable", "查找或安装包"), undefined);
  await act(async () => host("Pressable", "添加插件").props.onPress());
  assert.ok(host("Pressable", "引用本地路径"));
  await act(async () => host("TextInput", "搜索 npm 上的 Pi 包").props.onChangeText("example"));
  assert.equal(calls.some(({ method }) => method === "search-packages"), false);
  await act(async () => host("Pressable", "搜索 npm").props.onPress());
  assert.deepEqual(calls.find(({ method }) => method === "search-packages")?.input, { query: "example" });
  assert.ok(host("Pressable", "准备安装 pi-example"));
});

const subscriptionFixture = () => ({
  providers: [{ id: "sub", name: "订阅供应商 fixture", connected: true }],
  models: ["small", "large"].map((id) => ({ provider: "sub", id, context: "32K", contextWindow: 32768, maxOutput: "8K", reasoning: true, images: true })),
  rules: [{ pattern: "sub/*:high", matches: ["small", "large"].map((id) => ({ ref: `sub/${id}`, thinking: "high" })) }],
  refreshFailed: false,
});

test("subscription catalog refresh is explicit; switches and context overrides are staged together", async (t) => {
  const { host, calls } = await mount(t, {
    configure: (state) => {
      state.documents.find((d) => d.kind === "settings")!.text = '{"enabledModels":["sub/*:high"]}';
      state.documents.find((d) => d.kind === "models")!.text = '{"providers":{"sub":{"modelOverrides":{"small":{"name":"Keep me"}}}}}';
    },
    handlers: { subscriptions: async () => subscriptionFixture() },
  });
  await act(async () => host("Pressable", "订阅模型").props.onPress());
  await act(async () => host("Pressable", "读取订阅目录").props.onPress());
  assert.equal(calls.some((call) => call.method === "subscriptions"), false);
  await act(async () => host("Pressable", "读取目录").props.onPress());
  await act(async () => host("Pressable", "刷新模型目录").props.onPress());
  assert.equal(calls.filter((call) => call.method === "subscriptions").length, 1);
  await act(async () => host("Pressable", "刷新目录").props.onPress());
  assert.deepEqual(calls.findLast((call) => call.method === "subscriptions")?.input, { confirmed: true, revision: "v1", preferencesRevision: "v1", patterns: ["sub/*:high"], refresh: "sub" });
  await act(async () => host("Pressable", "small").props.onPress());
  await act(async () => host("SettingsSwitch", "在模型范围内启用").props.onValueChange(false));
  assert.equal(host("SettingsSwitch", "在模型范围内启用").props.value, false);
  await act(async () => host("TextInput", "上下文窗口（tokens）").props.onChangeText("65536"));
  await act(async () => host("Pressable", "保存").props.onPress());
  const edits = calls.find((call) => call.method === "prepare")?.input.edits;
  assert.deepEqual(JSON.parse(edits.find((edit: { kind: string }) => edit.kind === "settings").text), { enabledModels: ["sub/large:high"] });
  assert.deepEqual(JSON.parse(edits.find((edit: { kind: string }) => edit.kind === "models").text), { providers: { sub: { modelOverrides: { small: { name: "Keep me", contextWindow: 65536 } } } } });
  assert.equal(calls.some((call) => call.method === "commit"), false);
});

test("skill checks deduplicate filtered sources and plugin check-all ignores the search filter", async (t) => {
  const { host, calls } = await mount(t, { configure: (state) => {
    const sources = ["npm:pi-fixture", "npm:pi-other"];
    state.packages = sources.map((source) => ({ source, path: `/test/agent/${source}`, version: "1.0.0", enabled: true, scope: "global" }));
    state.resources = ["fixture-a", "fixture-b", "other"].map((name, i) => ({ id: name, kind: "skill", scope: "global", name, description: "", path: `/test/agent/${name}/SKILL.md`, packageSource: sources[i === 2 ? 1 : 0]!, enabled: true, modelInvocation: true }));
  }, handlers: { "package-version": async () => ({ state: "different", installed: "1.0.0", remote: "1.1.0" }) } });
  await act(async () => host("Pressable", "技能").props.onPress());
  await act(async () => host("TextInput", "搜索技能").props.onChangeText("fixture"));
  await act(async () => host("Pressable", "批量操作").props.onPress());
  await act(async () => host("Pressable", "检查技能更新").props.onPress());
  assert.deepEqual(calls.filter((call) => call.method === "package-version").map((call) => call.input.source), ["npm:pi-fixture"]);
  await act(async () => host("Pressable", "插件").props.onPress());
  await act(async () => host("TextInput", "搜索包或扩展").props.onChangeText("fixture"));
  assert.equal(host("Pressable", "npm:pi-other"), undefined);
  await act(async () => host("Pressable", "检查全部插件更新").props.onPress());
  assert.deepEqual(calls.filter((call) => call.method === "package-version").map((call) => call.input.source), ["npm:pi-fixture", "npm:pi-fixture", "npm:pi-other"]);
});

test("subscription logout is separately confirmed and can be cancelled", async (t) => {
  const { host, calls } = await mount(t, { handlers: {
    subscriptions: async () => subscriptionFixture(), "subscription-start": async () => ({ token: "fixture-token" }),
    "subscription-action": async () => ({ status: "cancelled" }),
  } });
  await act(async () => host("Pressable", "订阅模型").props.onPress());
  await act(async () => host("Pressable", "读取订阅目录").props.onPress());
  await act(async () => host("Pressable", "读取目录").props.onPress());
  await act(async () => host("Pressable", "退出订阅").props.onPress());
  assert.equal(calls.some((call) => call.method === "subscription-start"), false);
  await act(async () => host("Pressable", "确认退出").props.onPress());
  assert.deepEqual(calls.find((call) => call.method === "subscription-start")?.input, { confirmed: true, revision: "v1", preferencesRevision: "v1", provider: "sub", action: "logout" });
  await act(async () => host("Pressable", "取消订阅操作").props.onPress());
  assert.ok(calls.some((call) => call.method === "subscription-action" && call.input.action === "cancel"));
});
