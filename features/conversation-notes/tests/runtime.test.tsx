import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type { PluginButtonContentProps, PluginClientContext } from "@getpaseo/plugin/client";
import { build } from "esbuild";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { startNotes as start } from "../client/runtime";
import { notePresence, readNote, saveNote } from "../shared/contracts";
import { deferred } from "./deferred";

const require = createRequire(import.meta.url);
const compiled = await build({
  entryPoints: [new URL("../client/runtime.tsx", import.meta.url).pathname],
  bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react/jsx-runtime"],
  plugins: [{ name: "native-host", setup(builder) {
    builder.onResolve({ filter: /^(@getpaseo\/plugin\/client\/ui|react-native)$/ }, (args) => ({ path: args.path, namespace: "test-host" }));
    builder.onLoad({ filter: /.*/, namespace: "test-host" }, () => ({ loader: "js", contents: `
      import React from 'react'; const make = name => props => React.createElement(name, props, props.children);
      export const Text = make('Text'), View = make('View'), Pressable = make('Pressable');
      export const TextInput = React.forwardRef((props, ref) => React.createElement('TextInput', { ...props, ref }));
      export const Icon = make('Icon'), Markdown = make('Markdown');
      export const Platform = { select: options => options.default }, StyleSheet = { create: styles => styles };
      export const copyText = async () => {};
    ` }));
  } }],
});
const module = { exports: {} as { startNotes: typeof start } };
new Function("require", "module", "exports", compiled.outputFiles[0]!.text)(require, module, module.exports);
const { startNotes } = module.exports;
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
      if (name === readNote.name) { reads.push(input.sessionId); return { revision: null, markdown: "" }; }
      assert.equal(name, saveNote.name);
      writes.push(input);
      if (fail) throw new Error("offline");
      return { status: "saved", note: { revision: "f91021c2-c29f-43cb-a13f-96c220280b4f", markdown: input.markdown } };
    },
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
  await act(async () => { textbox().props.onChangeText("A 的草稿"); });
  await act(async () => { root.update(createElement(B, { ...props, agentId: "b" })); });
  assert.equal(textbox().props.value, "");
  assert.deepEqual(reads, ["a", "b"]);
  assert.equal(registered.get("a")?.button.label, "笔记 · 未保存");
  assert.equal(writes[0]?.sessionId, "a");
  await act(async () => { root.update(createElement(A, props)); });
  assert.equal(textbox().props.value, "A 的草稿");
  assert.match(JSON.stringify(root.toJSON()), /保存失败，草稿已保留/);
  fail = false;
  const press = (matches: (props: Record<string, unknown>) => boolean) =>
    root.root.findAll((node) => node.type === ("Pressable" as never) && matches(node.props))[0]!.props.onPress();
  await act(async () => { press((button) => button.accessibilityLabel === "重试保存"); });
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
  await act(async () => { tab("预览"); });
  assert.equal(root.root.findAllByType("TextInput" as never).length, 0);
  const checkbox = () => root.root.findAll((node) => node.type === ("Pressable" as never) && node.props.accessibilityRole === "checkbox")[0]!;
  assert.equal(checkbox().props["aria-checked"], false);
  await act(async () => { checkbox().props.onPress(); });
  assert.equal(checkbox().props["aria-checked"], true);
  await act(async () => { tab("编辑"); });
  assert.equal(textbox().props.value, "# A\n\n**记录**\n- [x] 查资料");
  await act(async () => { mounted = false; root.unmount(); observer.snapshot(entries("b") as Parameters<Observer["snapshot"]>[0]); });
  assert.equal(writes[2]?.markdown, "# A\n\n**记录**\n- [x] 查资料");
  assert.equal(registered.has("a"), false);
  await stop();
  presence.resolve({ present: ["b"] });
  await act(async () => {});
  assert.equal(registered.size, 0);
  assert.equal(released, 1); assert.equal(stopListening, 1);
});
