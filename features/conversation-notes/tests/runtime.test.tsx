import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { settingsRpc } from "@getpaseo/plugin";
import type { PluginButtonContentProps, PluginClientContext, PluginSettingsScreenContribution, PluginSurfaceProps, SettingsState } from "@getpaseo/plugin/client";
import { build } from "esbuild";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { startNotes as start } from "../client/runtime";
import { notePresence, noteSummaries, readGlobalNote, readNote, saveGlobalNote, saveNote } from "../shared/contracts";
import { defaultPreferences, preferences, preferencesSchema, type Preferences } from "../shared/settings";
import { deferred } from "./deferred";

const settingsRead = settingsRpc(preferences.id).read;
const nativeHost = { name: "native-host", setup(builder: import("esbuild").PluginBuild) {
    builder.onResolve({ filter: /^(@getpaseo\/plugin\/client(\/ui)?|react-native)$/ }, (args) => ({ path: args.path, namespace: "test-host" }));
    builder.onLoad({ filter: /.*/, namespace: "test-host" }, () => ({ loader: "js", contents: `
      import React from 'react'; const make = name => props => React.createElement(name, props, props.children);
      export function useSettings(definition) { return getSettings(definition); }
      export const SettingsCard = make('SettingsCard'), SettingsRow = make('SettingsRow'), SettingsSelect = make('SettingsSelect'),
        SettingsSwitch = make('SettingsSwitch'), SettingsAction = make('SettingsAction');
      export const Text = make('Text'), View = make('View'), Pressable = make('Pressable');
      export const TextInput = React.forwardRef((props, ref) => React.createElement('TextInput', { ...props, ref }));
      export const Icon = make('Icon'), Markdown = make('Markdown'), ScrollView = make('ScrollView'), SidebarRow = make('SidebarRow');
      export const Keyboard = { dismiss() {} }, BackHandler = { addEventListener: () => ({ remove() {} }) };
      export const FlatList = ({ data, renderItem, keyExtractor, ListHeaderComponent, ListEmptyComponent, ...props }) => React.createElement('FlatList', props,
        ListHeaderComponent, ...data.map(item => React.createElement(React.Fragment, {key: keyExtractor(item)}, renderItem({item}))),
        data.length ? null : ListEmptyComponent);
      export const Modal = Object.assign(({ open, children, ...props }) => open ? React.createElement('Modal', props, children) : null, { Content: make('ModalContent') });
      export const Platform = { select: options => options.default }, StyleSheet = { create: styles => styles };
      export const copyText = async () => {};
    ` }));
} };
const require = createRequire(import.meta.url);
async function load<T>(path: string, getSettings?: (definition: typeof preferences) => SettingsState<typeof preferencesSchema>) {
  const compiled = await build({
    entryPoints: [new URL(path, import.meta.url).pathname],
    bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react/jsx-runtime"],
    plugins: [nativeHost],
  });
  const module = { exports: {} as T };
  new Function("require", "module", "exports", "getSettings", compiled.outputFiles[0]!.text)(require, module, module.exports, getSettings);
  return module.exports;
}
const { startNotes } = await load<{ startNotes: typeof start }>("../client/runtime.tsx");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const props: PluginButtonContentProps = {
  context: "agent", workspaceId: "w", agentId: "a", close() {}, host: { id: "h", label: "host" },
  layout: { compact: true, platform: "web" }, theme: { colors: {
    surface0: "#fff", surface1: "#eee", surface2: "#ddd", border: "#ccc", foreground: "#111", foregroundMuted: "#555",
    accent: "#00a", accentForeground: "#fff", statusSuccess: "#080", statusWarning: "#880", statusDanger: "#800",
  } },
};
const entries = (...ids: string[]) => ({ subscriptionId: "test", entries: ids.map((id) => ({ agent: { id, workspaceId: "w", archivedAt: null } })) });

test("native pills follow the session directory and keep a failed draft in its own panel", async (t) => {
  type Pill = Parameters<PluginClientContext["addComposerPill"]>[0];
  type Directory = Awaited<ReturnType<PluginClientContext["paseo"]["agents"]["list"]>>;
  type Observer = Parameters<NonNullable<Directory["subscription"]>["subscribe"]>[0];
  const registered = new Map<string, Pill>();
  const reads: string[] = [];
  let preferencesReads = 0;
  let hostPreferences: () => Promise<unknown> = async () => ({ status: "ready", revision: "1", values: {} });
  const writes: { sessionId: string; markdown: string }[] = [];
  const presence = deferred<{ present: string[] }>();
  let fail = true;
  let observer!: Observer;
  let released = 0;
  let stopListening = 0;
  const client = {
    paseo: { agents: { list: async (query: { scope: string; sync: object; signal: AbortSignal }) => {
      assert.equal(query.scope, "active"); assert.deepEqual(query.sync, {});
      return { subscription: { subscribe: (listener: Observer) => {
        observer = listener;
        observer.snapshot(entries("a", "b") as Parameters<Observer["snapshot"]>[0]);
        return () => { stopListening++; };
      }, release: async () => { released++; } } };
    } } },
    rpc: async ({ name }: { name: string }, input: { sessionId: string; markdown: string }) => {
      if (name === notePresence.name) return presence.promise;
      if (name === settingsRead.name) {
        assert.deepEqual(input, {});
        preferencesReads++;
        return hostPreferences();
      }
      if (name === readNote.name) { reads.push(input.sessionId); return { revision: null, markdown: "" }; }
      assert.equal(name, saveNote.name);
      writes.push(input);
      if (fail) throw new Error("offline");
      return { status: "saved", note: { revision: "f91021c2-c29f-43cb-a13f-96c220280b4f", markdown: input.markdown } };
    },
    addScreen: () => () => {},
    addSidebarHeaderItem: () => () => {},
    addComposerPill: (pill: Pill) => {
      registered.set(pill.agentId, pill);
      return { update: (patch: Partial<Pill["button"]>) => { Object.assign(pill.button, patch); }, remove: () => registered.delete(pill.agentId) };
    },
  } as unknown as PluginClientContext;
  const stop = startNotes(client);
  t.after(stop);
  await act(async () => {});
  assert.deepEqual([...registered.keys()], ["a", "b"]);
  assert.ok([...registered.values()].every((pill) => pill.workspaceId === "w"));
  assert.deepEqual(reads, [], "presence does not read note bodies into the client");
  assert.equal(preferencesReads, 0, "closed pills do not fetch settings");
  const content = (id: string) => {
    const behavior = registered.get(id)!.button.behavior;
    assert.equal(behavior.kind, "popover"); return behavior.Content;
  };
  const A = content("a"), B = content("b");
  let root!: ReactTestRenderer;
  let mounted = true;
  t.after(async () => { if (mounted) await act(async () => root.unmount()); });
  await act(async () => { root = create(createElement(A, { ...props, agentId: "b" })); });
  assert.equal(root.toJSON(), null);
  assert.deepEqual(reads, []);
  await act(async () => { root.update(createElement(A, props)); });
  assert.deepEqual(reads, ["a"]);
  const textbox = () => root.root.findByType("TextInput" as never);
  const editorRows = () => {
    const panel = root.toJSON();
    assert.ok(panel && !Array.isArray(panel));
    return panel.children ?? [];
  };
  const statusButton = () => root.root.find((node) => node.type === ("Pressable" as never) && node.props.testID === "conversation-notes-status");
  const statusLabel = () => statusButton().props.accessibilityLabel;
  assert.match(statusLabel(), /没有待保存的更改/);
  const input = textbox();
  assert.equal(editorRows().length, 2);
  await act(async () => { textbox().props.onChangeText("A 的草稿"); });
  assert.match(statusLabel(), /待保存$/);
  assert.equal(editorRows().length, 2, "pending status adds no row");
  assert.equal(textbox(), input, "pending status leaves the editor mounted");
  await act(async () => { root.update(createElement(B, { ...props, agentId: "b" })); });
  assert.equal(textbox().props.value, "");
  assert.deepEqual(reads, ["a", "b"]);
  assert.equal(registered.get("a")?.button.label, "笔记 · 未保存");
  assert.equal(writes[0]?.sessionId, "a");
  await act(async () => { root.update(createElement(A, props)); });
  assert.equal(textbox().props.value, "A 的草稿");
  assert.match(statusLabel(), /保存失败，草稿已保留/);
  assert.equal(editorRows().length, 2, "failed saves also leave no footer");
  const press = (matches: (props: Record<string, unknown>) => boolean) =>
    root.root.findAll((node) => node.type === ("Pressable" as never) && matches(node.props))[0]!.props.onPress();
  await act(async () => { statusButton().props.onPress(); });
  const dialog = () => root.root.findByType("Modal" as never);
  assert.equal(dialog().props.title, "笔记状态");
  fail = false;
  await act(async () => { press((button) => button.accessibilityLabel === "重试保存"); });
  assert.match(statusLabel(), /没有待保存的更改/);
  await act(async () => { dialog().props.onOpenChange(false); });
  assert.equal(textbox().props.value, "A 的草稿");
  assert.equal(editorRows().length, 2);
  assert.deepEqual(writes.map(({ sessionId, markdown }) => [sessionId, markdown]), [["a", "A 的草稿"], ["a", "A 的草稿"]]);
  assert.equal(registered.get("a")?.button.label, "笔记 ·");
  assert.equal(content("a"), A, "presence updates the registration without remounting its content");
  await act(async () => { textbox().props.onChangeText("# A\n\n记录\n- [ ] 查资料"); });
  await act(async () => {
    const position = textbox().props.value.indexOf("记录");
    textbox().props.onSelectionChange({ nativeEvent: { selection: { start: position, end: position + 2 } } });
    press((button) => button.accessibilityLabel === "加粗");
  });
  assert.equal(textbox().props.value, "# A\n\n**记录**\n- [ ] 查资料");
  const tab = (label: string) => press((button) => button.accessibilityRole === "tab" && button.accessibilityLabel === label);
  const bodyHeight = () => root.root.find((node) => node.type === ("View" as never)
    && node.props.testID === "conversation-notes-body").props.style[1].height;
  const editHeight = bodyHeight();
  assert.ok(editHeight > 0, "the body has a fixed height");
  await act(async () => { tab("预览"); });
  assert.equal(root.root.findAllByType("TextInput" as never).length, 0);
  assert.equal(bodyHeight(), editHeight);
  assert.equal(root.root.findByType("ScrollView" as never).props.style.flex, 1, "preview scrolls within the fixed body");
  const checkbox = () => root.root.findAll((node) => node.type === ("Pressable" as never) && node.props.accessibilityRole === "checkbox")[0]!;
  assert.equal(checkbox().props["aria-checked"], false);
  await act(async () => { checkbox().props.onPress(); });
  assert.equal(checkbox().props["aria-checked"], true);
  await act(async () => { tab("编辑"); });
  assert.equal(bodyHeight(), editHeight);
  assert.equal(textbox().props.value, "# A\n\n**记录**\n- [x] 查资料");
  const previewPreferences = { defaultView: "preview", editorSize: "large", showToolbar: false } satisfies Preferences;
  const delayed = deferred<unknown>();
  hostPreferences = () => delayed.promise;
  await act(async () => { root.update(createElement(B, { ...props, agentId: "b" })); });
  assert.equal(root.root.findAllByType("TextInput" as never).length, 0, "no flash of the default editor while preferences load");
  assert.equal(bodyHeight(), editHeight);
  hostPreferences = async () => ({ status: "ready", revision: "2", values: previewPreferences });
  await act(async () => { root.update(createElement(A, props)); });
  assert.equal(root.root.findByType("ScrollView" as never).props.testID, "conversation-notes-preview");
  await act(async () => { tab("编辑"); });
  assert.equal(bodyHeight(), editHeight);
  assert.equal(textbox().props.style[2].fontSize, 17);
  assert.equal(root.root.findAll((node) => node.props.accessibilityRole === "toolbar").length, 0);
  await act(async () => { delayed.resolve({ status: "ready", revision: "1", values: {} }); });
  assert.equal(textbox().props.style[2].fontSize, 17, "a late response from a closed panel does not change the current panel");
  await act(async () => { root.update(createElement(B, { ...props, agentId: "b" })); });
  assert.equal(root.root.findByType("ScrollView" as never).props.testID, "conversation-notes-preview", "the manual switch did not change the host default");
  hostPreferences = async () => { throw new Error("offline"); };
  await act(async () => { root.update(createElement(A, props)); });
  assert.equal(textbox().props.style[2].fontSize, 14);
  assert.ok(root.root.findAll((node) => node.props.accessibilityRole === "toolbar").length > 0);
  await act(async () => { mounted = false; root.unmount(); observer.snapshot(entries("b") as Parameters<Observer["snapshot"]>[0]); });
  assert.equal(writes[2]?.markdown, "# A\n\n**记录**\n- [x] 查资料");
  assert.equal(registered.has("a"), false);
  await stop();
  presence.resolve({ present: ["b"] });
  await act(async () => {});
  assert.equal(registered.size, 0);
  assert.equal(released, 1); assert.equal(stopListening, 1);
});

test("sidebar opens the host notes hub and shares session drafts with the composer", async (t) => {
  type Client = PluginClientContext;
  const sources = [
    { agent: { id: "a", title: "设计讨论", workspaceId: "w", archivedAt: null }, project: { projectName: "项目", workspaceName: "工作区" } },
    { agent: { id: "b", title: "归档会话", workspaceId: "w", archivedAt: "2026-11-20" } },
  ];
  const saved: { id: string; text: string }[] = [];
  const rpcReads: string[] = [];
  const routes: unknown[] = [];
  let global = { revision: null as string | null, markdown: "# 全局笔记正文" };
  let failCatalog = true;
  let screen!: Parameters<Client["addScreen"]>[0];
  let sidebar!: Parameters<Client["addSidebarHeaderItem"]>[0];
  let pill!: Parameters<Client["addComposerPill"]>[0];
  let removed = 0;
  const client = {
    addScreen(value: typeof screen) { screen = value; return () => { removed++; }; },
    addSidebarHeaderItem(value: typeof sidebar) { sidebar = value; return () => { removed++; }; },
    addComposerPill(value: typeof pill) { pill = value; return { remove() {}, update() {} }; },
    paseo: { agents: { async list(query: { scope?: string; filter?: unknown }) {
      if (!query.scope) {
        assert.deepEqual(query.filter, { includeArchived: true, includeBackground: true });
        return { entries: sources, pageInfo: { hasMore: false } };
      }
      return { subscription: { subscribe: (listener: { snapshot(value: unknown): void }) => {
        listener.snapshot({ entries: [sources[0]] }); return () => {};
      }, release: async () => {} } };
    } } },
    async rpc({ name }: { name: string }, input: { sessionId: string; markdown: string }) {
      if (name === notePresence.name) return { present: ["a"] };
      if (name === settingsRead.name) return { status: "ready", values: {} };
      if (name === noteSummaries.name) {
        if (failCatalog) throw new Error("offline");
        return { notes: [{ sessionId: "a", snippet: "编辑文档", createdAt: 4, updatedAt: 20 }, { sessionId: "b", snippet: "保留结论", createdAt: 5, updatedAt: 10 }], unreadable: [] };
      }
      if (name === readGlobalNote.name) return global;
      if (name === readNote.name) { rpcReads.push(input.sessionId); return { revision: null, markdown: "编辑文档" }; }
      const revision = "f91021c2-c29f-43cb-a13f-96c220280b4f";
      if (name === saveGlobalNote.name) {
        global = { revision, markdown: input.markdown };
        saved.push({ id: "global", text: input.markdown });
        return { status: "saved", note: global };
      }
      assert.equal(name, saveNote.name);
      saved.push({ id: input.sessionId, text: input.markdown });
      return { status: "saved", note: { revision, markdown: input.markdown }, timestamps: { createdAt: 4, updatedAt: 30 } };
    },
  } as unknown as Client;
  const stop = startNotes(client);
  t.after(stop);
  let nav!: ReactTestRenderer, page!: ReactTestRenderer, composer: ReactTestRenderer | undefined;
  try {
    await act(async () => { nav = create(createElement(sidebar.Component, { ...props, currentScreen: null, openScreen(input) { routes.push(input); }, openPopover() {} })); });
    await act(async () => { nav.root.findByType("SidebarRow" as never).props.onPress(); });
    assert.deepEqual(routes.at(0), { screenId: screen.id });
    const navigation = { openAgent: (input: unknown) => routes.push(input), openWorkspace() {} };
    await act(async () => { page = create(createElement(screen.Component, { ...props, params: {}, navigation }), {
      createNodeMock: ({ props: nodeProps }) => ({
        focus() {},
        measureInWindow: (callback: (x: number, y: number, w: number, h: number) => void) => {
          const { testID } = nodeProps as { testID?: string };
          if (testID === "conversation-notes-hub") callback(10, 50, 390, 780);
          if (testID === "conversation-notes-sort-trigger") callback(214, 430, 112, 36);
        },
      }),
    }); });
    const inputs = () => page.root.findAllByType("TextInput" as never);
    const globalInput = () => inputs().find((node) => node.props.placeholder === "写全局笔记…")!;
    const queryInput = () => inputs().find((node) => node.props.accessibilityLabel === "搜索会话笔记")!;
    const button = (label: string) => page.root.find((node) => node.type === ("Pressable" as never) && node.props.accessibilityLabel === label);
    assert.equal(globalInput().props.value, "# 全局笔记正文", "global note works if the catalog fails");
    failCatalog = false;
    await act(async () => { button("重试").props.onPress(); });
    const list = () => page.root.findByType("FlatList" as never);
    const rowOrder = () => list().findAll((node) => node.type === ("Pressable" as never) && node.props.accessibilityLabel?.startsWith("笔记："))
      .map((node) => node.props.accessibilityLabel);
    assert.deepEqual(list().props.stickyHeaderIndices, [1]);
    assert.ok(queryInput().parent, "the compact page renders the search field in the sticky controls row");
    assert.deepEqual(rowOrder(), ["笔记：设计讨论", "笔记：归档会话"]);
    const menu = () => page.root.findAll((node) => node.type === ("View" as never) && node.props.testID === "conversation-notes-sort-menu").at(0);
    await act(async () => { button("当前降序，切换为升序").props.onPress(); });
    assert.equal(menu(), undefined, "the direction icon applies immediately without opening the menu");
    assert.deepEqual(rowOrder(), ["笔记：归档会话", "笔记：设计讨论"]);
    const field = () => button("排序字段：笔记更新时间");
    await act(async () => { field().props.onPress(); });
    assert.equal(field().props["aria-expanded"], true);
    assert.deepEqual(menu()?.props.style[1], { left: 148, top: 420, width: 168, height: 190 });
    const radios = () => menu()?.findAll((node) => node.type === ("Pressable" as never) && node.props.accessibilityRole === "radio") ?? [];
    assert.deepEqual(radios().map((node) => node.props.accessibilityLabel), ["名称", "笔记创建时间", "笔记更新时间", "对话创建时间", "对话更新时间"]);
    assert.equal(radios()[2]?.props["aria-checked"], true);
    await act(async () => { button("关闭排序选项").props.onPress(); });
    assert.equal(field().props["aria-expanded"], false);
    assert.deepEqual(rowOrder(), ["笔记：归档会话", "笔记：设计讨论"]);
    await act(async () => { field().props.onPress(); });
    await act(async () => { radios()[1]?.props.onPress(); });
    assert.equal(menu(), undefined, "selecting a field closes the dropdown");
    assert.ok(button("排序字段：笔记创建时间"));
    assert.ok(button("当前升序，切换为降序"));
    assert.deepEqual(rowOrder(), ["笔记：设计讨论", "笔记：归档会话"]);
    await act(async () => { button("当前升序，切换为降序").props.onPress(); });
    assert.deepEqual(rowOrder(), ["笔记：归档会话", "笔记：设计讨论"]);
    assert.deepEqual(rpcReads, [], "the hub does not read individual note bodies before selection");
    await act(async () => { globalInput().props.onChangeText("新全局正文"); queryInput().props.onChangeText("项目"); });
    assert.throws(() => button("笔记：归档会话"));
    await act(async () => { button("笔记：设计讨论").props.onPress(); });
    assert.equal(button("笔记：设计讨论").props["aria-expanded"], true);
    assert.equal(queryInput().props.value, "项目", "expanding preserves the search field");
    assert.equal(globalInput().props.value, "新全局正文", "the global editor remains mounted while a conversation expands");
    assert.deepEqual(rpcReads, ["a"]);
    await act(async () => { button("打开会话").props.onPress(); });
    assert.deepEqual(routes.at(-1), { agentId: "a", serverId: "h" });
    assert.equal(pill.button.behavior.kind, "popover");
    const { Content } = pill.button.behavior;
    await act(async () => { composer = create(createElement(Content, props)); });
    const detail = () => inputs().find((node) => node.props.placeholder === "写 Markdown…")!;
    await act(async () => { detail().props.onChangeText("共享草稿"); });
    assert.equal(composer!.root.findByType("TextInput" as never).props.value, "共享草稿");
    assert.deepEqual(rpcReads, ["a"], "opening the second surface does not race a new load");
    await act(async () => { button("笔记：设计讨论").props.onPress(); composer!.unmount(); composer = undefined; });
    assert.equal(button("笔记：设计讨论").props["aria-expanded"], false);
    assert.equal(detail(), undefined);
    assert.equal(queryInput().props.value, "项目");
    assert.match(JSON.stringify(page.toJSON()), /共享草稿/);
  } finally { await act(async () => { nav?.unmount(); page?.unmount(); composer?.unmount(); }); }
  assert.deepEqual(saved.sort((left, right) => left.id.localeCompare(right.id)),
    [{ id: "a", text: "共享草稿" }, { id: "global", text: "新全局正文" }]);
  await stop();
  assert.equal(removed, 2);
});

test("native settings save the displayed revision, retain a failed draft, and never overwrite newer preferences", async () => {
  type State = SettingsState<typeof preferencesSchema>;
  const saves: [Preferences, string][] = [];
  const state: Extract<State, { status: "ready" }> = {
    status: "ready", values: defaultPreferences, revision: "first", saving: false, saveError: null,
    async save(values, revision) {
      saves.push([values, revision]);
      if (saves.length === 1) { state.saveError = "offline"; return false; }
      state.values = values; state.revision = "third"; state.saveError = null;
      return true;
    },
    async reset() { return true; },
    async reload() { state.saveError = null; },
  };
  const { default: { Component } } = await load<{ default: PluginSettingsScreenContribution }>("../client/settings.tsx", (definition) => {
    assert.equal(definition.id, preferences.id); return state;
  });
  const page: PluginSurfaceProps = props;
  let root!: ReactTestRenderer;
  await act(async () => { root = create(createElement(Component, page)); });
  try {
    const field = (label: string) => root.root.find((node) => ["SettingsSelect", "SettingsSwitch"].includes(String(node.type)) && node.props.label === label);
    const action = (label: string) => root.root.find((node) => node.type === ("SettingsAction" as never) && node.props.actionLabel === label);
    assert.equal(action("保存").props.disabled, true);
    await act(async () => { field("打开时的视图").props.onValueChange("preview"); });
    await act(async () => { field("编辑字号").props.onValueChange("large"); });
    await act(async () => { field("显示 Markdown 工具栏").props.onValueChange(false); });
    await act(async () => { action("保存").props.onPress(); });
    assert.deepEqual(saves, [[{ defaultView: "preview", editorSize: "large", showToolbar: false }, "first"]]);
    assert.equal(field("编辑字号").props.value, "large");
    assert.equal(action("保存").props.disabled, false, "failure leaves the draft available to retry");
    state.revision = "second";
    state.values = { ...defaultPreferences, editorSize: "small" };
    await act(async () => { root.update(createElement(Component, { ...page })); });
    assert.equal(action("保存").props.disabled, true);
    assert.equal(field("打开时的视图").props.value, "preview", "a newer host revision does not replace the draft");
    await act(async () => { action("放弃").props.onPress(); });
    assert.equal(field("编辑字号").props.value, "small");
    await act(async () => { field("打开时的视图").props.onValueChange("preview"); });
    await act(async () => { action("保存").props.onPress(); });
    assert.deepEqual(saves[1], [{ defaultView: "preview", editorSize: "small", showToolbar: true }, "second"]);
    assert.equal(action("保存").props.disabled, true);
  } finally { await act(async () => { root.unmount(); }); }
});
