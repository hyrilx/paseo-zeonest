import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { Questionnaire } from "../client/transform";
import type { TimelineData } from "../shared/contracts";
import { questions, result } from "./fixtures/questionnaire";

const require = createRequire(import.meta.url);
// The compiled renderer uses CJS; share its Query context rather than the ESM copy.
const { QueryClient, QueryClientProvider } = require("@tanstack/react-query") as typeof import("@tanstack/react-query");
const compiled = await build({
  stdin: { contents: "export { default } from './index'; export { QuestionnaireRenderer } from './questionnaire';", resolveDir: new URL("../client", import.meta.url).pathname, loader: "ts" },
  bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", external: ["react", "react/jsx-runtime", "@tanstack/react-query"],
  plugins: [{ name: "native-host", setup(builder) {
    builder.onResolve({ filter: /^@getpaseo\/plugin\/client$/ }, () => ({ path: "rpc", namespace: "test-rpc" }));
    builder.onLoad({ filter: /.*/, namespace: "test-rpc" }, () => ({ loader: "js", contents: `export const useRpc = () => globalThis.__questionnaireRpc;` }));
    builder.onResolve({ filter: /^(@getpaseo\/plugin\/client\/ui|react-native)$/ }, (args) => ({ path: args.path, namespace: "test-host" }));
    builder.onLoad({ filter: /.*/, namespace: "test-host" }, () => ({ loader: "js", contents: `import React from 'react';
      const component = name => props => React.createElement(name, props, props.children);
      export const Text = component('Text'), View = component('View'), Pressable = component('Pressable'), Icon = component('Icon');` }));
  } }],
});
const module = { exports: {} as {
  default(client: PluginClientContext): () => void;
  QuestionnaireRenderer: React.ComponentType<PluginTimelineItemProps<TimelineData>>;
} };
new Function("require", "module", "exports", compiled.outputFiles[0]!.text)(require, module, module.exports);
const { default: contribute, QuestionnaireRenderer } = module.exports;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const theme: PluginTimelineItemProps["theme"] = { colors: {
  surface0: "#101010", surface1: "#202020", surface2: "#303030", border: "#404040", foreground: "#eeeeee", foregroundMuted: "#aaaaaa",
  accent: "#abcdef", accentForeground: "#111111", statusSuccess: "#00cc00", statusWarning: "#cccc00", statusDanger: "#cc0000",
} };
function props(data: TimelineData = { questions, result }): PluginTimelineItemProps<TimelineData> {
  return { agentId: "agent-1", item: { type: "plugin", kind: "ask-user-question", version: 1, data }, timestamp: new Date(0), theme, host: { id: "host", label: "Host" }, layout: { compact: false, platform: "web" } };
}
const find = (root: ReactTestRenderer, type: string, predicate: (node: ReactTestInstance) => boolean = () => true) => root.root.findAll((node) => typeof node.type === "string" && node.type === type && predicate(node));
const button = (root: ReactTestRenderer, label: string) => find(root, "Pressable", (node) => node.props.accessibilityLabel === label)[0]!;
const press = async (root: ReactTestRenderer, label: string) => { await act(async () => button(root, label).props.onPress()); };
const text = (root: ReactTestRenderer) => JSON.stringify(root.toJSON());
async function mount(t: { after(fn: () => Promise<void>): void }, input = props()) {
  let root!: ReactTestRenderer;
  await act(async () => { root = create(<QuestionnaireRenderer {...input} />); });
  t.after(async () => { await act(async () => root.unmount()); });
  return root;
}

test("questionnaire defaults to folded; expansion shows all options, descriptions and answers", async (t) => {
  const root = await mount(t);
  assert.equal(button(root, "问答选项回顾").props.accessibilityState.expanded, false);
  assert.equal(find(root, "View", (node) => /^option-/.test(node.props.testID ?? "")).length, 0);
  await press(root, "问答选项回顾");
  assert.equal(find(root, "View", (node) => /^option-/.test(node.props.testID ?? "")).length, 7);
  for (const question of questions) {
    assert.ok(text(root).includes(question.question));
    for (const option of question.options) {
      assert.ok(text(root).includes(option.label));
      assert.ok(text(root).includes(option.description));
    }
  }
  const selected = find(root, "Text", (node) => JSON.stringify(node.props.children).includes("（已选）"));
  assert.equal(selected.length, 3);
  assert.ok(selected.some((node) => JSON.stringify(node.props.children).includes("SQLite")));
  assert.ok(!selected.some((node) => JSON.stringify(node.props.children).includes("本地")));
  assert.ok(text(root).includes("自定义：本地"));
  assert.ok(text(root).includes("另外检查打包内容"));
  assert.ok(text(root).includes(result.globalNote));
  assert.ok(text(root).includes("先保持简单。"));
  assert.ok(!text(root).includes("Type something."));
  await press(root, "问答选项回顾");
  assert.equal(find(root, "View", (node) => /^option-/.test(node.props.testID ?? "")).length, 0);
});

test("previews preserve full source text and can expand independently for unselected options", async (t) => {
  const root = await mount(t);
  await press(root, "问答选项回顾");
  assert.equal(button(root, "问题 1 选项 1 预览").props.accessibilityState.expanded, false);
  await press(root, "问题 1 选项 2 预览");
  assert.equal(button(root, "问题 1 选项 1 预览").props.accessibilityState.expanded, false);
  assert.equal(button(root, "问题 1 选项 2 预览").props.accessibilityState.expanded, true);
  assert.ok(text(root).includes("连接到独立数据库。"));
  await press(root, "问题 1 选项 1 预览");
  assert.equal(find(root, "Text", (node) => node.props.children === questions[0]!.options[0]!.preview && node.props.selectable).length, 1);
  await press(root, "问题 1 选项 2 预览");
  assert.ok(!text(root).includes("连接到独立数据库。"));
});

test("partial answers, cancellations and tool errors show their state without fabricating answers", async (t) => {
  const root = await mount(t, props({ questions, result: { answers: [result.answers[0]!], cancelled: true, globalNote: "等确认后再回答。" } }));
  assert.ok(text(root).includes("已取消"));
  await press(root, "问答选项回顾");
  assert.equal(find(root, "Text", (node) => JSON.stringify(node.props.children).includes("未回答")).length, 2);
  assert.ok(text(root).includes("等确认后再回答。"));
  await act(async () => root.update(<QuestionnaireRenderer {...props({ questions, result: { answers: [], cancelled: false, error: "no_ui" } })} />));
  assert.ok(text(root).includes("出错"));
  assert.ok(text(root).includes("no_ui"));
  assert.equal(find(root, "View", (node) => /^option-/.test(node.props.testID ?? "")).length, 7);
  await act(async () => root.update(<QuestionnaireRenderer {...props({ questions, result: { answers: [], cancelled: false, unanswered: [0, 1, 2] } })} />));
  assert.ok(text(root).includes("部分回答"));
});

test("live completion updates preserve expansion and empty custom text is explicit", async (t) => {
  const root = await mount(t, props({ questions, result: { answers: [], cancelled: true } }));
  await press(root, "问答选项回顾");
  await act(async () => root.update(<QuestionnaireRenderer {...props({ questions, result: { ...result, answers: [{ ...result.answers[2]!, answer: null }] } })} />));
  assert.equal(button(root, "问答选项回顾").props.accessibilityState.expanded, true);
  assert.ok(text(root).includes("自定义：（空回答）"));
  assert.equal(find(root, "Text", (node) => JSON.stringify(node.props.children).includes("（已选）")).length, 0);
});

test("wide/compact layouts use only supplied theme colors including error state", async (t) => {
  for (const compact of [false, true]) {
    const input = props({ questions, result: { ...result, error: "no_ui" } });
    input.layout.compact = compact;
    if (compact) input.theme = { colors: Object.fromEntries(Object.keys(theme.colors).map((key, index) => [key, `color-${index}`])) as unknown as typeof theme.colors };
    const root = await mount(t, input);
    assert.equal(button(root, "问答选项回顾").props.style.minHeight, 32);
    await press(root, "问答选项回顾");
    assert.equal(find(root, "View", (node) => node.props.testID === "questionnaire-details")[0]!.props.style.paddingLeft, compact ? 10 : 14);
    await press(root, "问题 1 选项 1 预览");
    const palette = new Set(Object.values(input.theme.colors));
    for (const node of find(root, "Text")) {
      assert.ok(palette.has(node.props.style.color), `un-themed text: ${JSON.stringify(node.props.children)}`);
    }
    for (const node of find(root, "View")) {
      for (const property of ["borderColor", "backgroundColor"]) {
        if (node.props.style?.[property]) assert.ok(palette.has(node.props.style[property]));
      }
    }
  }
});

test("tool row is borderless when folded and gives native-like hover and press feedback", async (t) => {
  const root = await mount(t);
  const card = find(root, "View", (node) => node.props.testID === "questionnaire")[0]!;
  assert.equal(card.props.style.borderWidth, undefined);
  assert.equal(card.props.style.backgroundColor, undefined);
  assert.equal(button(root, "问答选项回顾").props.style.backgroundColor, undefined);
  assert.equal(find(root, "Icon")[0]!.props.name, "MessageCircleQuestion");
  await act(async () => button(root, "问答选项回顾").props.onHoverIn());
  assert.equal(find(root, "Icon")[0]!.props.name, "ChevronRight");
  assert.equal(button(root, "问答选项回顾").props.style.backgroundColor, theme.colors.surface1);
  await act(async () => button(root, "问答选项回顾").props.onPressIn());
  assert.equal(button(root, "问答选项回顾").props.style.opacity, 0.9);
  await act(async () => button(root, "问答选项回顾").props.onHoverOut());
  assert.equal(button(root, "问答选项回顾").props.style.opacity, 1);
  assert.equal(button(root, "问答选项回顾").props.style.backgroundColor, undefined);
  await press(root, "问答选项回顾");
  assert.equal(find(root, "Icon")[0]!.props.name, "ChevronDown");
  assert.equal(find(root, "Icon", (node) => node.props.name === "Check").length, 3);
  for (const option of find(root, "View", (node) => /^option-/.test(node.props.testID ?? ""))) {
    assert.equal(option.props.style.borderWidth, undefined);
    assert.equal(option.props.style.backgroundColor, undefined);
  }
  await act(async () => button(root, "问答选项回顾").props.onPressIn());
  await act(async () => button(root, "问答选项回顾").props.onPressOut());
  assert.equal(button(root, "问答选项回顾").props.style.opacity, 1);
  assert.equal(button(root, "问答选项回顾").props.style.backgroundColor, theme.colors.surface1);
});

test("light and dark themes preserve hierarchy and touch target sizing on compact native layouts", async (t) => {
  const light: typeof theme = { colors: {
    surface0: "#ffffff", surface1: "#f5f5f5", surface2: "#eeeeee", border: "#dddddd", foreground: "#202020", foregroundMuted: "#666666",
    accent: "#226644", accentForeground: "#ffffff", statusSuccess: "#228844", statusWarning: "#886600", statusDanger: "#aa2222",
  } };
  for (const palette of [theme, light]) {
    for (const platform of ["web", "ios", "android"] as const) {
      const input = props(); input.theme = palette; input.layout = { compact: true, platform };
      const root = await mount(t, input);
      assert.equal(button(root, "问答选项回顾").props.style.minHeight, platform === "web" ? 32 : 44);
      await press(root, "问答选项回顾");
      await press(root, "问题 1 选项 1 预览");
      assert.equal(button(root, "问题 1 选项 1 预览").props.style.minHeight, platform === "web" ? undefined : 44);
      for (const node of find(root, "Icon")) assert.ok(Object.values(palette.colors).includes(node.props.color));
      const chosen = find(root, "Text", (node) => JSON.stringify(node.props.children).includes("（已选）"));
      assert.equal(chosen.length, 3);
      for (const node of chosen) assert.equal(node.props.style.color, palette.colors.accent);
      const option = find(root, "View", (node) => node.props.testID === "option-0-1")[0]!;
      assert.equal(option.props.style.backgroundColor, undefined);
    }
  }
});

test("long questions and option text wrap without truncation or fixed content widths", async (t) => {
  const long = "较长的选项说明需要自然换行，不截断用户回顾时需要的信息。".repeat(12);
  const input = props({ questions: [{ question: long, header: "长文案", options: [
    { label: long, description: long, preview: long }, { label: "短选项", description: "短说明" },
  ] }], result: { answers: [{ questionIndex: 0, question: long, kind: "custom", answer: long }], cancelled: false } });
  input.layout.compact = true;
  const root = await mount(t, input);
  await press(root, "问答选项回顾"); await press(root, "问题 1 选项 1 预览");
  const texts = find(root, "Text", (node) => JSON.stringify(node.props.children).includes(long));
  assert.ok(texts.length >= 5);
  for (const node of texts) {
    assert.equal(node.props.numberOfLines, undefined);
    assert.equal(node.props.style.width, undefined);
  }
  const option = find(root, "View", (node) => node.props.testID === "option-0-0")[0]!;
  assert.equal(option.props.style.minWidth, 0);
  const content = find(root, "View", (node) => node.props.style?.flex === 1 && node.props.style?.minWidth === 0);
  assert.equal(content.length, 2);
});

const rpcGlobal = globalThis as typeof globalThis & {
  __questionnaireRpc: (input: { agentId: string; callId: string; summary: string }) => Promise<Questionnaire | null>;
};
async function mountRecovered(t: { after(fn: () => Promise<void>): void }, rpc: typeof rpcGlobal.__questionnaireRpc, input = props({ callId: "call-1", summary: "原始问题: 用户答案" })) {
  rpcGlobal.__questionnaireRpc = rpc;
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  let root!: ReactTestRenderer;
  await act(async () => { root = create(<QueryClientProvider client={client}><QuestionnaireRenderer {...input} /></QueryClientProvider>); });
  t.after(async () => { await act(async () => root.unmount()); client.clear(); });
  return root;
}
const flushQuery = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

test("projected Questions rows recover on first expansion and retain expansion on arrival", async (t) => {
  let calls = 0;
  let resolve!: (data: Questionnaire) => void;
  const pending = new Promise<Questionnaire>((done) => { resolve = done; });
  const root = await mountRecovered(t, async (input) => {
    calls++; assert.deepEqual(input, { agentId: "agent-1", callId: "call-1", summary: "原始问题: 用户答案" });
    return pending;
  });
  assert.equal(calls, 0);
  await press(root, "问答选项回顾");
  assert.equal(calls, 1);
  assert.ok(text(root).includes("正在读取原始选项"));
  assert.ok(text(root).includes("原始问题: 用户答案"));
  await act(async () => { resolve({ questions, result }); });
  await flushQuery();
  assert.equal(button(root, "问答选项回顾").props.accessibilityState.expanded, true);
  assert.equal(find(root, "View", (node) => /^option-/.test(node.props.testID ?? "")).length, 7);
  assert.ok(!text(root).includes("原始选项不可用"));
  await press(root, "问答选项回顾"); await press(root, "问答选项回顾");
  assert.equal(calls, 1);
});

test("missing session and RPC errors retain Q/A and allow manual recovery retry", async (t) => {
  for (const missing of [true, false]) {
    let calls = 0;
    let ready = false;
    const root = await mountRecovered(t, async () => {
      calls++;
      if (ready) return { questions, result };
      if (missing) return null;
      throw new Error("read failed");
    });
    await press(root, "问答选项回顾");
    await flushQuery(); await flushQuery();
    assert.equal(calls, 2);
    assert.ok(text(root).includes("原始选项不可用"));
    assert.ok(text(root).includes("原始问题: 用户答案"));
    for (const node of find(root, "Text")) assert.ok(Object.values(theme.colors).includes(node.props.style.color));
    ready = true;
    await press(root, "重试读取选项"); await flushQuery();
    assert.equal(find(root, "View", (node) => /^option-/.test(node.props.testID ?? "")).length, 7);
  }
});

function clientStub(events: string[], fail: "setup" | "cleanup" | undefined = undefined): PluginClientContext {
  return {
    addTimelineRenderer(contribution: { kind: string; version: number; schema: { safeParse(value: unknown): { success: boolean } } }) {
      events.push("renderer:add");
      assert.equal(contribution.kind, "ask-user-question");
      assert.equal(contribution.version, 1);
      assert.ok(contribution.schema.safeParse({ questions, result }).success);
      return () => { events.push("renderer:remove"); };
    },
    addTimelineTransformer(contribution: { query: { itemType: string } }) {
      events.push("transformer:add");
      assert.equal(contribution.query.itemType, "tool_call");
      if (fail === "setup") throw new Error("registration failed");
      return () => { events.push("transformer:remove"); if (fail === "cleanup") throw new Error("cleanup failed"); };
    },
  } as unknown as PluginClientContext;
}

test("registration orders renderer before transformer and cleanup is idempotent", () => {
  const events: string[] = [];
  const cleanup = contribute(clientStub(events));
  cleanup();
  cleanup();
  assert.deepEqual(events, ["renderer:add", "transformer:add", "transformer:remove", "renderer:remove"]);
});

test("transformer registration failure rolls back renderer", () => {
  const events: string[] = [];
  assert.throws(() => contribute(clientStub(events, "setup")), /registration failed/);
  assert.deepEqual(events, ["renderer:add", "transformer:add", "renderer:remove"]);
});

test("transformer cleanup failure still releases renderer once", () => {
  const events: string[] = [];
  const cleanup = contribute(clientStub(events, "cleanup"));
  assert.throws(cleanup, /cleanup failed/);
  cleanup();
  assert.deepEqual(events, ["renderer:add", "transformer:add", "transformer:remove", "renderer:remove"]);
});
