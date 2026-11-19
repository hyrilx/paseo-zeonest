import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
// The fixture is CommonJS; share its Query context rather than the separate ESM context.
const { QueryClient, QueryClientProvider } = createRequire(import.meta.url)("@tanstack/react-query") as typeof import("@tanstack/react-query");
import type { PluginAgentPanelContribution, PluginClientContext, PluginCommandCenterItemContribution, PluginWorkspacePanelContribution } from "@getpaseo/plugin/client";
import type { Observe } from "../client/panel";
import { preferencesSchema } from "../shared/settings";
import { WorkspaceFileActivityPanel, listWorkspaceAgents, registerFileActivity, setPaseo, setSettingsState, workspaceProps } from "./fixtures/host";
import { deferred, fakeAgent, flush, record, tool, user } from "./fixtures/timeline";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type Paseo = PluginClientContext["paseo"];
type DirectoryPage = Awaited<ReturnType<Paseo["agents"]["list"]>>;
type WorkspaceContribution = Extract<PluginWorkspacePanelContribution, { context?: "workspace" }>;
const control = (root: ReactTestRenderer, type: string, label: string) => root.root.findAll((node) => String(node.type) === type && node.props.label === label)[0]!;
const choice = (id: string) => ({ id, label: "会话 " + id });
const entry = (id: string, workspaceId = "w", archivedAt: string | null = null) => ({ agent: { id, workspaceId, title: id, provider: "pi", archivedAt } });
const directory = (entries: ReturnType<typeof entry>[], nextCursor: string | null = null): DirectoryPage => ({ requestId: "r", entries, pageInfo: { nextCursor, prevCursor: null, hasMore: nextCursor !== null } } as unknown as DirectoryPage);
function setup() {
  const refs: string[] = [];
  const released: string[] = [];
  const paseo = { agents: { ref(id: string) { refs.push(id); return { ...fakeAgent().agent, id }; } } } as unknown as Paseo;
  setPaseo(paseo);
  setSettingsState({ status: "ready", values: preferencesSchema.parse({}), revision: "r", saving: false, saveError: null, save: async () => true, reset: async () => true, reload: async () => {} });
  const observe: Observe = (agent, _, source) => {
    source.set({ status: "ready", partial: false, warning: "", records: [user(1, "turn-" + agent.id), record(tool("call-" + agent.id, { type: "read", filePath: agent.id + ".ts", content: "private body" }), 2, "turn-" + agent.id)] });
    return { retry() {}, async stop() { released.push(agent.id); } };
  };
  return { refs, released, observe, paseo };
}
const settle = async () => { await act(async () => { await flush(); await delay(5); }); };
async function mount(component: React.ReactNode) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let root!: ReactTestRenderer;
  await act(async () => { root = create(<QueryClientProvider client={query}>{component}</QueryClientProvider>); await flush(); });
  await settle();
  return { root, async stop() { await act(async () => root.unmount()); query.clear(); } };
}
function registry() {
  const panels: { context: "workspace" | "agent"; id: string; locations: readonly string[] }[] = [];
  let workspace!: WorkspaceContribution;
  let command!: PluginCommandCenterItemContribution;
  const removed: string[] = [];
  const client = {
    addWorkspacePanel(value: WorkspaceContribution) { workspace = value; panels.push({ ...value, context: "workspace", locations: value.locations ?? ["workspace"] }); return () => { removed.push(value.id); }; },
    addAgentPanel(value: PluginAgentPanelContribution) { panels.push({ ...value, context: "agent", locations: value.locations ?? ["workspace"] }); return () => { removed.push(value.id); }; },
    addCommandCenterItem(value: PluginCommandCenterItemContribution) { command = value; return () => { removed.push(value.id); }; },
  } as PluginClientContext;
  return { client, panels, removed, get workspace() { return workspace; }, get command() { return command; } };
}

test("host + launcher includes the workspace contribution; current-agent command opens the exact agent panel", async () => {
  const host = registry(); const stop = registerFileActivity(host.client);
  // Mirrors the desktop launcher: agent-context registrations are excluded before location filtering.
  const launcher = host.panels.filter((panel) => panel.context === "workspace" && panel.locations.includes("explorer"));
  assert.deepEqual(launcher.map((panel) => panel.id), ["file-activity"]);
  assert.equal(new Set(host.panels.map((panel) => panel.id)).size, 2);
  const opened: unknown[] = [];
  const command = host.command;
  assert.ok(command.context === "agent");
  const context = { openPanel: (...args: unknown[]) => opened.push(args) } as unknown as Parameters<typeof command.onSelect>[0];
  await command.onSelect(context);
  assert.deepEqual(opened, [["file-activity-agent", { location: "explorer" }]]);
  await stop(); await stop(); await command.onSelect(context);
  assert.equal(opened.length, 1);
  assert.deepEqual(host.removed.sort(), ["file-activity", "file-activity-agent", "file-activity-current"]);
});
test("registration failure rolls back previously registered launchers", async () => {
  let removed = 0;
  const client = { addWorkspacePanel() { return () => { removed++; }; }, addAgentPanel() { throw new Error("registration failed"); } } as unknown as PluginClientContext;
  assert.throws(() => registerFileActivity(client), /registration failed/);
  await flush(); assert.equal(removed, 1);
});
test("workspace directory pages all agents, filters workspace/archive and rejects non-progressing cursors", async () => {
  const calls: unknown[] = [];
  const paseo = { agents: { async list(options: unknown) { calls.push(options); return calls.length === 1 ? directory([entry("foreign", "other"), entry("a"), entry("old", "w", "date")], "next") : directory([entry("a"), entry("b")]); } } } as unknown as Paseo;
  assert.deepEqual((await listWorkspaceAgents(paseo, "w", new AbortController().signal)).map((agent) => agent.id), ["a", "b"]);
  assert.equal(calls.length, 2); assert.equal((calls[1] as { page: { cursor: string } }).page.cursor, "next");
  for (const next of ["repeat", null]) {
    const broken = { agents: { list: async () => ({ ...directory([], next), pageInfo: { hasMore: true, nextCursor: next } }) } } as unknown as Paseo;
    await assert.rejects(listWorkspaceAgents(broken, "w", new AbortController().signal), /分页未前进/);
  }
});
test("directory cancellation blocks requests and discards late responses; errors remain visible to callers", async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const pending = deferred<DirectoryPage>();
  const paseo = { agents: { list() { calls++; return pending.promise; } } } as unknown as Paseo;
  await assert.rejects(listWorkspaceAgents(paseo, "w", controller.signal), /已取消/); assert.equal(calls, 0);
  const active = new AbortController(); const result = listWorkspaceAgents(paseo, "w", active.signal);
  active.abort(); pending.resolve(directory([entry("a")])); await assert.rejects(result, /已取消/);
  const failed = { agents: { list: async () => { throw new Error("offline"); } } } as unknown as Paseo;
  await assert.rejects(listWorkspaceAgents(failed, "w", new AbortController().signal), /offline/);
});
test("workspace panel requires an explicit choice for multiple agents, preserves per-agent views and restores selection", async () => {
  const host = setup(); const props = workspaceProps(); let saved: unknown;
  props.tab.setState = (value) => { saved = value; };
  const loadAgents = async () => [choice("a"), choice("b")];
  const view = await mount(<WorkspaceFileActivityPanel {...props} observe={host.observe} loadAgents={loadAgents} />);
  assert.deepEqual(host.refs, []); assert.match(JSON.stringify(view.root.toJSON()), /请选择要查看的会话/);
  await act(async () => control(view.root, "SettingsSelect", "会话").props.onValueChange("a"));
  await act(async () => control(view.root, "SettingsSelect", "查看范围").props.onValueChange("all"));
  await act(async () => control(view.root, "SettingsSelect", "会话").props.onValueChange("b"));
  assert.equal(control(view.root, "SettingsSelect", "查看范围").props.value, "latest");
  await act(async () => control(view.root, "SettingsSelect", "排序").props.onValueChange("path"));
  await act(async () => control(view.root, "SettingsSelect", "会话").props.onValueChange("a"));
  assert.equal(control(view.root, "SettingsSelect", "查看范围").props.value, "all");
  assert.equal(control(view.root, "SettingsSelect", "排序").props.value, "time");
  assert.deepEqual(host.refs, ["a", "b", "a"]); assert.deepEqual(host.released, ["a", "b"]);
  assert.ok(!JSON.stringify(saved).includes("private body"));
  await view.stop();
  props.tab = { ...props.tab, state: saved };
  const restored = await mount(<WorkspaceFileActivityPanel {...props} observe={host.observe} loadAgents={loadAgents} />);
  assert.equal(control(restored.root, "SettingsSelect", "会话").props.value, "a");
  assert.equal(control(restored.root, "SettingsSelect", "查看范围").props.value, "all");
  await restored.stop();
});
test("single-agent workspace auto-selects; invalid persisted state falls back safely", async () => {
  for (const state of [null, { selectedAgentId: 123, views: { unsafe: "bad" } }]) {
    const host = setup(); const props = workspaceProps(); props.tab = { ...props.tab, state };
    const view = await mount(<WorkspaceFileActivityPanel {...props} observe={host.observe} loadAgents={async () => [choice("a")]} />);
    assert.equal(control(view.root, "SettingsSelect", "会话").props.value, "a"); assert.deepEqual(host.refs, ["a"]);
    await view.stop();
  }
});
test("workspace loading, error/retry and empty directory states are actionable", async () => {
  const host = setup(); const pending = deferred<ReturnType<typeof choice>[]>(); let attempts = 0;
  const view = await mount(<WorkspaceFileActivityPanel {...workspaceProps()} observe={host.observe} loadAgents={() => ++attempts === 1 ? pending.promise : Promise.resolve([])} />);
  assert.match(JSON.stringify(view.root.toJSON()), /正在读取工作区会话/);
  await act(async () => { pending.reject(new Error("offline")); await flush(); }); await settle();
  assert.match(JSON.stringify(view.root.toJSON()), /会话列表读取失败.*offline/);
  await act(async () => { control(view.root, "SettingsAction", "重新读取会话列表").props.onPress(); await flush(); }); await settle();
  assert.match(JSON.stringify(view.root.toJSON()), /当前工作区没有可用会话/); assert.deepEqual(host.refs, []);
  await view.stop();
});
test("unavailable persisted selection never silently switches to another agent", async () => {
  const host = setup(); const props = workspaceProps(); props.tab = { ...props.tab, state: { selectedAgentId: "missing", views: {} } };
  const view = await mount(<WorkspaceFileActivityPanel {...props} observe={host.observe} loadAgents={async () => [choice("a")]} />);
  assert.equal(control(view.root, "SettingsSelect", "会话").props.value, "missing"); assert.deepEqual(host.refs, []);
  assert.match(JSON.stringify(view.root.toJSON()), /所选会话当前不可用/); await view.stop();
});
test("plugin cleanup aborts workspace directory requests and ignores their late results", async () => {
  setup(); const pending = deferred<DirectoryPage>(); let signal: AbortSignal | undefined;
  setPaseo({ agents: { list(options: { signal: AbortSignal }) { signal = options.signal; return pending.promise; }, ref() { throw new Error("late observation"); } } } as unknown as Paseo);
  const host = registry(); const stop = registerFileActivity(host.client); const Component = host.workspace.Component;
  const view = await mount(<Component {...workspaceProps()} />);
  assert.ok(signal); assert.equal(signal.aborted, false);
  await stop(); assert.equal(signal.aborted, true);
  await act(async () => { pending.resolve(directory([entry("a")])); await flush(); }); await settle();
  assert.match(JSON.stringify(view.root.toJSON()), /会话列表读取失败/); await view.stop();
});
