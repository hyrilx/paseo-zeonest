import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import React, { type ReactElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";

import { projectRoot, loadFeatures, renderEntry } from "../tools/features.mjs";
import { createFeature } from "../tools/new-feature.mjs";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function uiFixture(t: { after(fn: () => Promise<void>): void }, populated = true, allSettings = false) {
  const root = await mkdtemp(path.join(tmpdir(), "zeonest-ui-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const item of ["shell"]) {
    await cp(path.join(projectRoot, item), path.join(root, item), { recursive: true });
  }
  await symlink(path.join(projectRoot, "node_modules"), path.join(root, "node_modules"), "dir");
  await mkdir(path.join(root, "features"));
  if (populated) {
    for (const id of ["alpha", "beta"]) {
      await createFeature(root, {
        id, name: id === "alpha" ? "功能甲" : "功能乙", description: "说明 " + id,
        version: "1.2.3", tags: ["工具"], author: "测试作者",
      }, "both", id === "alpha" || allSettings);
      await writeFile(path.join(root, "features", id, "client/index.ts"), `import type { PluginClientContext } from "@getpaseo/plugin/client"; export default (client: PluginClientContext) => client.addCommandCenterItem({ id: "${id}-command", title: "${id}", icon: "Blocks", context: "global", onSelect() {} });`);
    }
  }
  const outfile = path.join(root, "ui-test.mjs");
  await build({
    absWorkingDir: root,
    stdin: {
      contents: renderEntry(await loadFeatures(root), "client") + '\nimport { FeatureManager as RawFeatureManager } from "./shell/client/feature-manager"; import { useSettings } from "@getpaseo/plugin/client"; export const FeatureManager = (props) => RawFeatureManager({...props, settings: useSettings(), featureCatalog, featureSettingsScreens}); export { setSettingsState } from "@getpaseo/plugin/client";',
      resolveDir: root, loader: "ts",
    },
    outfile, bundle: true, format: "esm", platform: "node", packages: "external",
    jsx: "automatic", logLevel: "silent",
    plugins: [{
      name: "native-host-test-adapter",
      setup(builder) {
        builder.onResolve({ filter: /^(@getpaseo\/plugin\/client(?:\/ui)?|react-native)$/ }, ({ path }) => ({ path, namespace: "test-host" }));
        builder.onLoad({ filter: /.*/, namespace: "test-host" }, ({ path }) => ({
          contents: path === "@getpaseo/plugin/client"
            ? "let state; export function setSettingsState(next) { state = next; } export function useSettings() { return state; }"
            : path === "react-native"
              ? 'export const ActivityIndicator = "ActivityIndicator", View = "View", Text = "Text", Switch = "Switch", Pressable = "Pressable"; export const useWindowDimensions = () => ({ width: 1000, height: 800 });'
              : ["Icon", "TextInput", "ScrollView", "SettingsAction", "SettingsCard", "SettingsRow", "SettingsSection", "SettingsSwitch"]
                .map((name) => "export const " + name + " = " + JSON.stringify(name) + ";").join("\n"),
          loader: "js",
        }));
      },
    }],
  });
  return import(pathToFileURL(outfile).href);
}

type Node = ReactElement<Record<string, any>, string>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join("");
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value && typeof value === "object" && "props" in value) return text((value as Node).props.children);
  return "";
}

const colors = Object.fromEntries([
  "surface0", "surface1", "surface2", "border", "foreground", "foregroundMuted",
  "accent", "accentForeground", "statusSuccess", "statusWarning", "statusDanger",
].map((key) => [key, "theme-" + key]));
const props = {
  theme: { colors }, layout: { compact: false, platform: "web" }, host: { id: "host-a", label: "A" },
  runtime: { status: "ready", enabledIds: [], error: null }, openSettings: (_id: string) => {},
  reloadState: { status: "idle", message: null }, reloadPlugin: () => {}, width: 720, query: "", setQuery: (_query: string) => {},
};

function readySettings(overrides = {}) {
  return {
    status: "ready", revision: "revision-1", values: { enabled: {} },
    saving: false, saveError: null, save: async () => true, reset: async () => true, reload: async () => {},
    ...overrides,
  };
}

test("empty shell renders an honest empty state without fictitious feature switches", async (t) => {
  const ui = await uiFixture(t, false);
  ui.setSettingsState(readySettings());
  const tree = ui.FeatureManager(props);
  assert.match(text(tree), /尚未集成子功能/);
  assert.equal(nodes(tree).some((node) => node.type === "Switch" || node.type === "TextInput"), false);
});

test("feature UI displays all metadata, pending state and settings even while disabled", async (t) => {
  const ui = await uiFixture(t);
  ui.setSettingsState(readySettings({ values: { enabled: { beta: true } } }));
  let opened = "";
  const tree = ui.FeatureManager({ ...props, openSettings: (id: string) => { opened = id; } });
  const visible = text(tree);
  assert.match(visible, /1 项开关待生效/);
  assert.match(visible, /v1.2.3 · 测试作者 · 工具/);
  assert.match(visible, /未启用 · 待启用/);
  const all = nodes(tree);
  const actions = all.filter((node) => node.type === "Pressable" && node.props.testID !== "zeonest-reload-button");
  assert.deepEqual(actions.map((node) => node.props.accessibilityLabel), ["功能甲：打开配置"]);
  const [action] = actions;
  assert.ok(action);
  action.props.onPress();
  assert.equal(opened, "alpha-settings");
});

test("feature names appear once as headings; the grid adapts to the available width and compact layout", async (t) => {
  const ui = await uiFixture(t);
  ui.setSettingsState(readySettings());
  for (const [compact, width, cardWidth] of [[false, 720, 354], [false, 540, "100%"], [true, 720, "100%"]]) {
    const tree = ui.FeatureManager({ ...props, layout: { ...props.layout, compact }, width });
    const grid = nodes(tree).find((node) => node.props.testID === "zeonest-feature-grid")!;
    const cards = grid.props.children as Node[];
    assert.equal(cards.length, 2);
    for (const [index, [name, description]] of ([["功能甲", "说明 alpha"], ["功能乙", "说明 beta"]] as const).entries()) {
      const card = cards[index];
      assert.ok(card);
      assert.equal(card.props.style.width, cardWidth);
      const headings = nodes(card).filter((node) => node.props.accessibilityRole === "header");
      assert.deepEqual(headings.map(text), [name]);
      assert.equal(text(card).split(name).length, 2);
      assert.match(text(card), new RegExp(description));
    }
  }
});

test("search matches metadata and shows a distinct no-results state", async (t) => {
  const ui = await uiFixture(t);
  ui.setSettingsState(readySettings());
  for (const [query, expected] of [[" ALPHA ", ["alpha"]], ["工具", ["alpha", "beta"]], ["测试作者", ["alpha", "beta"]], ["未匹配", []]] as const) {
    const tree = ui.FeatureManager({ ...props, query });
    const cards = nodes(tree).filter((node) => node.props.testID?.startsWith("zeonest-feature-") && node.props.testID !== "zeonest-feature-grid");
    assert.deepEqual(cards.map((node) => node.props.testID), expected.map((id) => `zeonest-feature-${id}`));
    if (!expected.length) assert.match(text(tree), /没有匹配的功能/);
  }
});

test("toggle saves a full document with the displayed revision and preserves unknown switches", async (t) => {
  const ui = await uiFixture(t);
  const calls: unknown[] = [];
  ui.setSettingsState(readySettings({
    values: { enabled: { removed: true, beta: false } },
    save: async (...args: unknown[]) => { calls.push(args); return true; },
  }));
  const tree = ui.FeatureManager(props);
  const toggle = nodes(tree).find((node) => node.type === "Switch");
  assert.ok(toggle);
  toggle.props.onValueChange(true);
  assert.deepEqual(calls, [[{ enabled: { removed: true, beta: false, alpha: true } }, "revision-1"]]);
});

test("loading/saving/invalid states never offer an enabled switch; invalid reset is explicit", async (t) => {
  const ui = await uiFixture(t);
  for (const settings of [{ status: "loading" }, readySettings({ saving: true })]) {
    ui.setSettingsState(settings);
    assert.ok(nodes(ui.FeatureManager(props))
      .filter((node) => node.type === "Switch")
      .every((node) => node.props.disabled === true));
  }
  let resets = 0;
  ui.setSettingsState(readySettings({ status: "invalid", error: "schema invalid", reset: async () => { resets++; } }));
  const tree = ui.FeatureManager(props);
  const reset = nodes(tree).find((node) => node.props.actionLabel === "重置开关");
  assert.ok(reset);
  assert.equal(resets, 0);
  reset.props.onPress();
  assert.equal(resets, 1);
});

test("conflict errors allow reload and startup failures do not claim a confirmed running state", async (t) => {
  const ui = await uiFixture(t);
  let reloads = 0;
  ui.setSettingsState(readySettings({ saveError: "revision conflict", reload: async () => { reloads++; } }));
  const tree = ui.FeatureManager({
    ...props, layout: { compact: true, platform: "ios" },
    runtime: { status: "error", error: "startup failed", enabledIds: [] },
  });
  assert.match(text(tree), /状态未确认/);
  assert.match(text(tree), /启动失败：startup failed/);
  const reload = nodes(tree).find((node) => node.props.label === "revision conflict");
  assert.ok(reload);
  reload.props.onPress();
  assert.equal(reloads, 1);
  for (const node of nodes(tree).filter((node) => node.type === "Text")) {
    assert.ok(node.props.style?.color?.startsWith("theme-"));
  }
});

function fakeClient(onReload: () => Promise<{ error: string | null }> = async () => ({ error: null })) {
  const screens: string[] = [];
  const components = new Map<string, React.ComponentType<PluginSurfaceProps>>();
  const commands: string[] = [];
  const removed: string[] = [];
  const opened: string[] = [];
  let resolve!: (value: { enabledIds: string[]; error: string | null }) => void;
  const ready = new Promise((done) => { resolve = done; });
  const client = {
    addSettingsScreen: (screen: { id: string; Component: React.ComponentType<PluginSurfaceProps> }) => { screens.push(screen.id); components.set(screen.id, screen.Component); return () => { removed.push(screen.id); }; },
    addCommandCenterItem: (command: { id: string }) => { commands.push(command.id); return () => { removed.push(command.id); }; },
    openSettings: (id: string) => { opened.push(id); }, rpc: (contract: { name: string }) => contract.name === "zeonest.shell.reload" ? onReload() : ready,
  };
  return { client, screens, commands, removed, opened, resolve, components };
}

test("all child settings stay inside one menu entry and receive native surface props", async (t) => {
  const ui = await uiFixture(t, true, true);
  for (const compact of [false, true]) {
    ui.setSettingsState(readySettings());
    const fake = fakeClient();
    const cleanup = ui.default(fake.client);
    fake.resolve({ enabledIds: [], error: null });
    const Component = fake.components.get("zeonest-features")!;
    const surfaceProps = {
      theme: props.theme, host: props.host, layout: { ...props.layout, compact },
      openScreen: () => {}, openSettings: () => {},
    };
    let root!: ReactTestRenderer;
    await act(async () => { root = create(React.createElement(Component, surfaceProps as unknown as PluginSurfaceProps)); });
    try {
      assert.deepEqual(fake.screens, ["zeonest-features"]);
      assert.deepEqual(fake.commands, ["zeonest-settings"]);
      for (const screen of Object.values(ui.featureSettingsScreens) as { id: string; title: string; Component: React.ComponentType<PluginSurfaceProps> }[]) {
        assert.equal(root.root.findAllByType(screen.Component).length, 0);
        const action = root.root.findByProps({ accessibilityLabel: `${screen.title}：打开配置` });
        await act(async () => action.props.onPress());
        assert.deepEqual(root.root.findByType(screen.Component).props, surfaceProps);
        assert.equal(root.root.findAll((node) => String(node.type) === "Switch").length, 0);
        const back = root.root.findByProps({ accessibilityLabel: "返回功能集" });
        assert.ok(back);
        await act(async () => back.props.onPress());
        assert.equal(root.root.findAllByType(screen.Component).length, 0);
        assert.equal(root.root.findAll((node) => String(node.type) === "Switch").length, 2);
      }
      assert.deepEqual(fake.opened, []);
      assert.deepEqual(fake.screens, ["zeonest-features"]);
    } finally {
      await act(async () => root.unmount());
      await cleanup();
    }
  }
});

test("web navigation resets the host scroller and restores both list scroll and search", async (t) => {
  const ui = await uiFixture(t);
  ui.setSettingsState(readySettings());
  const fake = fakeClient();
  const cleanup = ui.default(fake.client);
  fake.resolve({ enabledIds: [], error: null });
  const Component = fake.components.get("zeonest-features")!;
  const scroller = { scrollTop: 0 };
  const view = {
    parentElement: { parentElement: scroller },
    ownerDocument: { defaultView: { getComputedStyle: (node: unknown) => ({ overflowY: node === scroller ? "auto" : "visible" }) } },
  };
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(React.createElement(Component, props as unknown as PluginSurfaceProps), {
      createNodeMock: (element) => (element.props as { collapsable?: boolean }).collapsable === false ? view : null,
    });
  });
  try {
    await act(async () => root.root.findByProps({ accessibilityLabel: "搜索功能" }).props.onChangeText("alpha"));
    for (const offset of [216, 483]) {
      scroller.scrollTop = offset;
      await act(async () => root.root.findByProps({ accessibilityLabel: "功能甲：打开配置" }).props.onPress());
      assert.equal(scroller.scrollTop, 0);
      scroller.scrollTop = 830;
      await act(async () => root.root.findByProps({ accessibilityLabel: "返回功能集" }).props.onPress());
      assert.equal(scroller.scrollTop, offset);
      assert.equal(root.root.findByProps({ accessibilityLabel: "搜索功能" }).props.value, "alpha");
    }
  } finally {
    await act(async () => root.unmount());
    await cleanup();
  }
});

test("native navigation opens a fresh scroller and remounts the list at its captured offset", async (t) => {
  const ui = await uiFixture(t);
  ui.setSettingsState(readySettings());
  for (const platform of ["ios", "android"]) {
    const fake = fakeClient();
    const cleanup = ui.default(fake.client);
    fake.resolve({ enabledIds: [], error: null });
    const Component = fake.components.get("zeonest-features")!;
    const surface = { ...props, layout: { compact: true, platform } } as unknown as PluginSurfaceProps;
    let root!: ReactTestRenderer;
    await act(async () => { root = create(React.createElement(Component, surface)); });
    try {
      const scroll = () => root.root.findByProps({ testID: "zeonest-settings-scroll" });
      assert.equal(scroll().props.contentOffset.y, 0);
      scroll().props.onScroll({ nativeEvent: { contentOffset: { y: 269 } } });
      await act(async () => root.root.findByProps({ accessibilityLabel: "功能甲：打开配置" }).props.onPress());
      assert.equal(scroll().props.contentOffset.y, 0);
      assert.equal(scroll().props.onScroll, undefined);
      await act(async () => root.root.findByProps({ accessibilityLabel: "返回功能集" }).props.onPress());
      assert.equal(scroll().props.contentOffset.y, 269);
    } finally {
      await act(async () => root.unmount());
      await cleanup();
    }
  }
});

test("child settings remain reachable while shell settings and startup are loading or failed", async (t) => {
  const ui = await uiFixture(t);
  t.mock.method(console, "error", () => {});
  for (const status of ["loading", "invalid", "error"]) {
    ui.setSettingsState(status === "loading" ? { status } : readySettings({ status, error: "settings failed" }));
    const fake = fakeClient();
    const cleanup = ui.default(fake.client);
    if (status !== "loading") fake.resolve({ enabledIds: [], error: "startup failed" });
    const Component = fake.components.get("zeonest-features")!;
    let root!: ReactTestRenderer;
    await act(async () => { root = create(React.createElement(Component, props as unknown as PluginSurfaceProps)); });
    try {
      const action = root.root.findByProps({ accessibilityLabel: "功能甲：打开配置" });
      await act(async () => action.props.onPress());
      assert.equal(root.root.findAllByType(ui.featureSettingsScreens.alpha.Component).length, 1);
      const back = root.root.findByProps({ accessibilityLabel: "返回功能集" });
      await act(async () => back.props.onPress());
      assert.equal(root.root.findAllByType(ui.featureSettingsScreens.alpha.Component).length, 0);
      assert.match(JSON.stringify(root.toJSON()), status === "loading" ? /正在读取运行状态/ : /startup failed/);
      assert.deepEqual(fake.opened, []);
      assert.deepEqual(fake.screens, ["zeonest-features"]);
    } finally {
      await act(async () => root.unmount());
      fake.resolve({ enabledIds: [], error: null });
      await cleanup();
    }
  }
});

test("client starts only the server snapshot and registers a single settings screen", async (t) => {
  const ui = await uiFixture(t);
  ui.setSettingsState(readySettings({ values: { enabled: { beta: true } } }));
  const fake = fakeClient();
  const cleanup = ui.default(fake.client);
  assert.deepEqual(fake.screens, ["zeonest-features"]);
  assert.deepEqual(fake.commands, ["zeonest-settings"]);
  fake.resolve({ enabledIds: ["alpha"], error: null });
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(fake.commands, ["zeonest-settings", "alpha-command"]);
  await cleanup(); await cleanup();
  assert.deepEqual(fake.removed, ["alpha-command", "zeonest-settings", "zeonest-features"]);
});

test("a late client snapshot after teardown cannot resurrect native contributions", async (t) => {
  const ui = await uiFixture(t);
  const fake = fakeClient();
  const cleanup = ui.default(fake.client);
  const closed = cleanup();
  fake.resolve({ enabledIds: ["alpha", "beta"], error: null });
  await closed;
  assert.deepEqual(fake.commands, ["zeonest-settings"]);
  assert.deepEqual(fake.removed, ["zeonest-settings", "zeonest-features"]);
});

test("status banner is permanent and transitions cleanly across normal, loading, pending, reloading and error states", async (t) => {
  const ui = await uiFixture(t);
  let calls: number = 0;
  const statusIcon = (tree: unknown) => nodes(tree).find((node) => node.props.testID === "zeonest-status-icon")!;
  const reloadButton = (tree: unknown) => nodes(tree).find((node) => node.props.testID === "zeonest-reload-button")!;

  // Normal ready state: CircleCheck icon, enabled subtle reload button
  ui.setSettingsState(readySettings());
  const readyTree = ui.FeatureManager({ ...props, reloadPlugin: () => { calls++; } });
  assert.ok(nodes(readyTree).some((node) => node.props.testID === "zeonest-status-banner"));
  assert.match(text(readyTree), /运行正常/);
  assert.equal(nodes(statusIcon(readyTree)).find((node) => node.type === "Icon")!.props.name, "CircleCheck");
  assert.equal(reloadButton(readyTree).props.disabled, false);
  reloadButton(readyTree).props.onPress();
  assert.equal(calls, 1);

  // Loading settings or runtime: ActivityIndicator, disabled reload button
  ui.setSettingsState({ status: "loading" });
  const loadingTree = ui.FeatureManager({ ...props, reloadPlugin: () => { calls++; } });
  assert.ok(nodes(statusIcon(loadingTree)).some((node) => node.type === "ActivityIndicator"));
  assert.equal(reloadButton(loadingTree).props.disabled, true);
  reloadButton(loadingTree).props.onPress();
  assert.equal(calls, 1);

  // Pending switches & saving/reloading locks
  for (const saving of [false, true]) {
    for (const running of [false, true]) {
      ui.setSettingsState(readySettings({ values: { enabled: { alpha: true } }, saving }));
      const tree = ui.FeatureManager({ ...props,
        reloadState: { status: running ? "running" : "idle", message: null },
        reloadPlugin: () => { calls++; },
      });
      const iconBox = statusIcon(tree);
      if (running) {
        assert.ok(nodes(iconBox).some((node) => node.type === "ActivityIndicator"));
        assert.match(text(tree), /正在重新加载/);
      } else {
        assert.equal(nodes(iconBox).find((node) => node.type === "Icon")!.props.name, "TriangleAlert");
        assert.match(text(tree), /1 项开关待生效/);
      }
      const button = reloadButton(tree);
      assert.equal(button.props.disabled, saving || running);
      const before: number = calls;
      button.props.onPress();
      assert.equal(calls, before + (saving || running ? 0 : 1));
    }
  }
});

async function mountShell(t: { after(fn: () => Promise<void>): void }, onReload: () => Promise<{ error: string | null }>) {
  const ui = await uiFixture(t);
  ui.setSettingsState(readySettings({ values: { enabled: { alpha: true } } }));
  const fake = fakeClient(onReload);
  const cleanup = ui.default(fake.client);
  fake.resolve({ enabledIds: [], error: null });
  const Component = fake.components.get("zeonest-features")!;
  let root!: ReactTestRenderer;
  await act(async () => { root = create(React.createElement(Component, props as unknown as PluginSurfaceProps)); });
  t.after(async () => {
    await act(async () => root.unmount());
    await cleanup();
  });
  const button = () => root.root.findByProps({ testID: "zeonest-reload-button" });
  const statusIcon = () => root.root.findByProps({ testID: "zeonest-status-icon" });
  return { root, button, statusIcon, cleanup, ui };
}

test("real settings hooks coalesce double clicks, lock switches and surface CLI errors for retry", async (t) => {
  let finish!: (value: { error: string | null }) => void;
  let calls: number = 0;
  const { root, button, statusIcon } = await mountShell(t, () => {
    calls++;
    return new Promise((resolve) => { finish = resolve; });
  });
  await act(async () => {
    const press = button().props.onPress;
    press(); press();
  });
  assert.equal(calls, 1);
  assert.equal(button().props.disabled, true);
  assert.equal(statusIcon().findAll((node) => String(node.type) === "ActivityIndicator").length, 1);
  assert.match(JSON.stringify(root.toJSON()), /正在重新加载/);
  assert.ok(root.root.findAll((node) => String(node.type) === "Switch").every((node) => node.props.disabled));
  await act(async () => { finish({ error: "CLI missing" }); });
  assert.match(JSON.stringify(root.toJSON()), /CLI missing/);
  assert.equal(statusIcon().find((node) => String(node.type) === "Icon").props.name, "CircleAlert");
  assert.equal(button().props.disabled, false);
  assert.ok(root.root.findAll((node) => String(node.type) === "Switch").every((node) => !node.props.disabled));
  await act(async () => { button().props.onPress(); finish({ error: null }); });
  assert.equal(calls, 2);
  assert.equal(statusIcon().findAll((node) => String(node.type) === "ActivityIndicator").length, 1);
  assert.doesNotMatch(JSON.stringify(root.toJSON()), /重载结果尚未确认|确认本次运行状态/);
});

test("self-reload RPC interruption stays in loading state until refresh, falls back on timeout and ignores teardown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reject!: (error: Error) => void;
  const { root, button, statusIcon, cleanup } = await mountShell(t, () => new Promise((_resolve, fail) => { reject = fail; }));
  await act(async () => button().props.onPress());
  await act(async () => reject(new Error("Plugin stopped: zeonest")));
  assert.equal(statusIcon().findAll((node) => String(node.type) === "ActivityIndicator").length, 1);
  assert.equal(button().props.disabled, true);
  assert.ok(root.root.findAll((node) => String(node.type) === "Switch").every((node) => node.props.disabled));
  assert.doesNotMatch(JSON.stringify(root.toJSON()), /重载结果尚未确认|重载成功/);
  await act(async () => { t.mock.timers.tick(30_000); });
  assert.match(JSON.stringify(root.toJSON()), /等待页面刷新超时/);
  assert.equal(button().props.disabled, false);
  await act(async () => button().props.onPress());
  await act(async () => { root.unmount(); await cleanup(); });
  await act(async () => reject(new Error("late disconnect")));
  t.mock.timers.tick(30_000);
  assert.equal(root.toJSON(), null);
});
