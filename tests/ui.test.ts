import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { ReactElement } from "react";
import { projectRoot, loadFeatures, renderEntry } from "../tools/features.mjs";
import { createFeature } from "../tools/new-feature.mjs";

async function uiFixture(t: { after(fn: () => Promise<void>): void }, populated = true) {
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
      }, "both", id === "alpha");
      await writeFile(path.join(root, "features", id, "client/index.ts"), `import type { PluginClientContext } from "@getpaseo/plugin/client"; export default (client: PluginClientContext) => client.addCommandCenterItem({ id: "${id}-command", title: "${id}", icon: "Blocks", context: "global", onSelect() {} });`);
    }
  }
  const outfile = path.join(root, "ui-test.mjs");
  await build({
    absWorkingDir: root,
    stdin: {
      contents: renderEntry(await loadFeatures(root), "client") + '\nimport { FeatureManager as RawFeatureManager } from "./shell/client/feature-manager"; export const FeatureManager = (props) => RawFeatureManager({...props, featureCatalog, featureSettingsScreens}); export { setSettingsState } from "@getpaseo/plugin/client";',
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
              ? 'export const View = "View"; export const Text = "Text";'
              : ["SettingsAction", "SettingsCard", "SettingsRow", "SettingsSection", "SettingsSwitch"]
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
  assert.ok(nodes(tree).some((node) => node.props.title === "尚未集成子功能"));
  assert.equal(nodes(tree).some((node) => node.type === "SettingsSwitch"), false);
});

test("feature UI displays all metadata, pending state and settings even while disabled", async (t) => {
  const ui = await uiFixture(t);
  ui.setSettingsState(readySettings({ values: { enabled: { beta: true } } }));
  let opened = "";
  const tree = ui.FeatureManager({ ...props, openSettings: (id: string) => { opened = id; } });
  const visible = text(tree);
  assert.match(visible, /1 项开关已保存/);
  assert.match(visible, /版本 1.2.3 \/ 作者 测试作者/);
  assert.match(visible, /标签：工具/);
  assert.match(visible, /本次运行：未启用/);
  const all = nodes(tree);
  assert.ok(all.some((node) => node.props.title === "功能甲"));
  assert.ok(all.some((node) => node.props.label === "功能甲" && node.props.hint === "说明 alpha"));
  const action = all.find((node) => node.props.actionLabel === "打开配置");
  assert.ok(action);
  action.props.onPress();
  assert.equal(opened, "alpha-settings");
  assert.ok(all.some((node) => node.props.label === "无需配置"));
});

test("feature names are primary row labels and descriptions are hints in wide and compact layouts", async (t) => {
  const ui = await uiFixture(t);
  ui.setSettingsState(readySettings());
  for (const compact of [false, true]) {
    const tree = ui.FeatureManager({ ...props, layout: { ...props.layout, compact } });
    for (const [name, description] of [["功能甲", "说明 alpha"], ["功能乙", "说明 beta"]]) {
      const section = nodes(tree).find((node) => node.type === "SettingsSection" && node.props.title === name);
      assert.ok(section);
      const rows = nodes(section).filter((node) => node.type === "SettingsRow");
      assert.ok(rows.some((row) => row.props.label === name && row.props.hint === description));
      assert.equal(rows.some((row) => row.props.label === description), false);
    }
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
  const toggle = nodes(tree).find((node) => node.type === "SettingsSwitch");
  assert.ok(toggle);
  toggle.props.onValueChange(true);
  assert.deepEqual(calls, [[{ enabled: { removed: true, beta: false, alpha: true } }, "revision-1"]]);
});

test("loading/saving/invalid states never offer an enabled switch; invalid reset is explicit", async (t) => {
  const ui = await uiFixture(t);
  for (const settings of [{ status: "loading" }, readySettings({ saving: true })]) {
    ui.setSettingsState(settings);
    assert.ok(nodes(ui.FeatureManager(props))
      .filter((node) => node.type === "SettingsSwitch")
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
  assert.match(text(tree), /本次运行：未确认/);
  assert.match(text(tree), /启动失败：startup failed/);
  const reload = nodes(tree).find((node) => node.props.label === "revision conflict");
  assert.ok(reload);
  reload.props.onPress();
  assert.equal(reloads, 1);
  for (const node of nodes(tree).filter((node) => node.type === "Text")) {
    assert.ok(node.props.style?.color?.startsWith("theme-"));
  }
});

function fakeClient() {
  const screens: string[] = [];
  const commands: string[] = [];
  const removed: string[] = [];
  let resolve!: (value: { enabledIds: string[]; error: string | null }) => void;
  const ready = new Promise((done) => { resolve = done; });
  const client = {
    addSettingsScreen: (screen: { id: string }) => { screens.push(screen.id); return () => { removed.push(screen.id); }; },
    addCommandCenterItem: (command: { id: string }) => { commands.push(command.id); return () => { removed.push(command.id); }; },
    openSettings: () => {}, rpc: () => ready,
  };
  return { client, screens, commands, removed, resolve };
}

test("client starts only the server snapshot and keeps disabled configuration screens registered", async (t) => {
  const ui = await uiFixture(t);
  ui.setSettingsState(readySettings({ values: { enabled: { beta: true } } }));
  const fake = fakeClient();
  const cleanup = ui.default(fake.client);
  assert.deepEqual(fake.screens, ["zeonest-features", "alpha-settings"]);
  assert.deepEqual(fake.commands, ["zeonest-settings"]);
  fake.resolve({ enabledIds: ["alpha"], error: null });
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(fake.commands, ["zeonest-settings", "alpha-command"]);
  await cleanup(); await cleanup();
  assert.deepEqual(fake.removed, ["alpha-command", "zeonest-settings", "alpha-settings", "zeonest-features"]);
});

test("a late client snapshot after teardown cannot resurrect native contributions", async (t) => {
  const ui = await uiFixture(t);
  const fake = fakeClient();
  const cleanup = ui.default(fake.client);
  const closed = cleanup();
  fake.resolve({ enabledIds: ["alpha", "beta"], error: null });
  await closed;
  assert.deepEqual(fake.commands, ["zeonest-settings"]);
  assert.deepEqual(fake.removed, ["zeonest-settings", "alpha-settings", "zeonest-features"]);
});
