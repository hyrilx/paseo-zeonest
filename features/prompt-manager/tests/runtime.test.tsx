import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type {
  PluginClientContext,
  PluginCommandCenterItemContribution,
  PluginScreenContribution,
  PluginScreenProps,
  PluginSidebarItemContribution,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { build } from "esbuild";
import { act, createElement } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { startPromptManager as StartFn } from "../client/runtime";
import { deletePrompt, listPrompts, savePrompt, type PromptRecord } from "../shared/contracts";
import { createSamplePromptDraft } from "../shared/template";

interface MockHostState {
  copied: string[];
  copyFailure: Error | null;
  toasts: Array<{ kind: "show" | "error"; message: string }>;
}

const mockHostState: MockHostState = {
  copied: [],
  copyFailure: null,
  toasts: [],
};

const nativeHostPlugin = {
  name: "prompt-manager-test-host",
  setup(builder: import("esbuild").PluginBuild) {
    builder.onResolve({ filter: /^(@getpaseo\/plugin\/client(\/ui)?|react-native)$/ }, (args) => ({
      path: args.path,
      namespace: "test-host",
    }));
    builder.onLoad({ filter: /.*/, namespace: "test-host" }, () => ({
      loader: "js",
      contents: `
        import React from 'react';
        const make = name => props => React.createElement(name, props, props.children);
        export const Text = make('Text'), View = make('View'), Pressable = make('Pressable');
        export const TextInput = React.forwardRef((props, ref) => React.createElement('TextInput', { ...props, ref }));
        export const Icon = make('Icon'), ScrollView = make('ScrollView'), SidebarRow = make('SidebarRow');
        export const Modal = Object.assign(
          ({ open, children, ...props }) => open ? React.createElement('Modal', props, children) : null,
          { Content: make('ModalContent') },
        );
        export const StyleSheet = { hairlineWidth: 1, create: styles => styles };
        export const copyText = async (text) => {
          if (globalThis.__promptMockHost.copyFailure) throw globalThis.__promptMockHost.copyFailure;
          globalThis.__promptMockHost.copied.push(text);
        };
        export const useToast = () => ({
          show(message) { globalThis.__promptMockHost.toasts.push({ kind: 'show', message }); },
          error(message) { globalThis.__promptMockHost.toasts.push({ kind: 'error', message }); },
        });
      `,
    }));
  },
};

const require = createRequire(import.meta.url);

async function loadRuntime() {
  const compiled = await build({
    entryPoints: [new URL("../client/runtime.tsx", import.meta.url).pathname],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    external: ["react", "react/jsx-runtime"],
    plugins: [nativeHostPlugin],
  });
  const mod = { exports: {} as { startPromptManager: typeof StartFn } };
  new Function("require", "module", "exports", compiled.outputFiles[0]!.text)(require, mod, mod.exports);
  return mod.exports;
}

const { startPromptManager } = await loadRuntime();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, __promptMockHost: mockHostState });

const theme = {
  colors: {
    surface0: "#ffffff",
    surface1: "#f5f5f5",
    surface2: "#e8e8e8",
    border: "#d4d4d4",
    foreground: "#111111",
    foregroundMuted: "#666666",
    accent: "#0055cc",
    accentForeground: "#ffffff",
    statusSuccess: "#15803d",
    statusWarning: "#b45309",
    statusDanger: "#b91c1c",
  },
};

function makeSampleRecord(id = "p-1"): PromptRecord {
  const draft = createSamplePromptDraft();
  return {
    ...draft,
    id,
    revision: "11111111-1111-4111-8111-111111111111",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

function createHarness(initialPrompts: PromptRecord[] = [makeSampleRecord()]) {
  let prompts = [...initialPrompts];
  let screen: PluginScreenContribution | undefined;
  let sidebar: PluginSidebarItemContribution | undefined;
  const commands = new Map<string, PluginCommandCenterItemContribution>();
  const openedScreens: Array<{ screenId: string; params?: Record<string, string> }> = [];
  let removed = 0;

  const client = {
    async rpc(contract: { name: string }, input: Record<string, unknown>) {
      if (contract.name === listPrompts.name) {
        return { prompts: [...prompts] };
      }
      if (contract.name === savePrompt.name) {
        const id = (input.id as string | undefined) ?? `p-${prompts.length + 1}`;
        const existing = prompts.find((item) => item.id === id);
        const saved: PromptRecord = {
          id,
          revision: "22222222-2222-4222-8222-222222222222",
          name: String(input.name ?? ""),
          description: String(input.description ?? ""),
          tags: (input.tags as string[]) ?? [],
          template: String(input.template ?? ""),
          placeholders: (input.placeholders as PromptRecord["placeholders"]) ?? [],
          createdAt: existing?.createdAt ?? 1_700_000_000_000,
          updatedAt: Date.now(),
        };
        prompts = [saved, ...prompts.filter((item) => item.id !== id)];
        return { status: "saved", prompt: saved };
      }
      if (contract.name === deletePrompt.name) {
        const id = String(input.id);
        prompts = prompts.filter((item) => item.id !== id);
        return { status: "deleted", id };
      }
      throw new Error(`Unexpected RPC: ${contract.name}`);
    },
    addScreen(contribution: PluginScreenContribution) {
      screen = contribution;
      return () => { removed++; };
    },
    addSidebarHeaderItem(contribution: PluginSidebarItemContribution) {
      sidebar = contribution;
      return () => { removed++; };
    },
    addCommandCenterItem(contribution: PluginCommandCenterItemContribution) {
      commands.set(contribution.id, contribution);
      return () => { removed++; };
    },
    openScreen(input: { screenId: string; params?: Record<string, string> }) {
      openedScreens.push(input);
    },
  };

  const cleanup = startPromptManager(client as unknown as PluginClientContext);
  return {
    get screen() { return screen!; },
    get sidebar() { return sidebar!; },
    commands,
    openedScreens,
    getPrompts: () => prompts,
    getRemoved: () => removed,
    cleanup,
  };
}

function findByTestId(root: ReactTestRenderer, testID: string): ReactTestInstance {
  const matches = root.root.findAll((node) => typeof node.type === "string" && node.props?.testID === testID);
  assert.ok(matches.length >= 1, `Expected to find element with testID="${testID}"`);
  return matches[0]!;
}

function textOf(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join("");
}

test("Command Center inserts prompt in-place via Sidebar Modal, guides placeholders, and copies to clipboard", async () => {
  mockHostState.copied = [];
  mockHostState.copyFailure = null;
  mockHostState.toasts = [];

  const harness = createHarness();
  const sidebarProps: PluginSidebarItemProps = {
    theme,
    host: { id: "local", label: "Local" },
    layout: { compact: false, platform: "web" },
    currentScreen: null,
    openScreen: (input) => { harness.openedScreens.push(input); },
    openPopover: () => {},
  };

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(harness.sidebar.Component, sidebarProps));
  });

  // Invoke Command Center "Prompt：插入 Prompt"
  const insertCmd = harness.commands.get("prompt-manager-insert");
  assert.ok(insertCmd);
  assert.equal(insertCmd.context, "global");

  await act(async () => {
    await insertCmd.onSelect({
      context: "global",
      openScreen: (input: { screenId: string; params?: Record<string, string> }) => { harness.openedScreens.push(input); },
    } as never);
  });

  // Opened in-place without navigating away
  assert.equal(harness.openedScreens.length, 0);
  assert.equal(renderer.root.findAllByType("Modal" as never).length, 1);

  // Pick the sample prompt
  await act(async () => {
    findByTestId(renderer, "prompt-picker-item-p-1").props.onPress();
  });

  // Fill text placeholder, customize multi-select, toggle checkbox off, toggle optional-line off
  await act(async () => {
    findByTestId(renderer, "apply-text-target").props.onChangeText("store.ts");
  });
  await act(async () => {
    // Unselect "边界条件" (opt-1) so only "逻辑正确性" remains -> omits separator!
    findByTestId(renderer, "apply-select-focus-opt-1").props.onPress();
  });
  await act(async () => {
    findByTestId(renderer, "apply-checkbox-strict_mode").props.onPress();
  });
  await act(async () => {
    // Turn off include_tests optional line -> nested test_framework & test_cases become skipped!
    findByTestId(renderer, "apply-optional-include_tests").props.onPress();
  });

  assert.ok(findByTestId(renderer, "apply-skipped-test_framework"));
  assert.ok(findByTestId(renderer, "apply-skipped-test_cases"));

  const previewText = textOf(findByTestId(renderer, "prompt-apply-preview-text"));
  assert.equal(
    previewText,
    "请帮我审查 store.ts 的代码改动，重点关注 逻辑正确性。\n请优先总结最关键的 2~3 个问题，保持简洁。",
  );

  // Confirm copy to clipboard
  await act(async () => {
    findByTestId(renderer, "prompt-apply-confirm").props.onPress();
  });

  assert.deepEqual(mockHostState.copied, [previewText]);
  assert.ok(mockHostState.toasts.some((item) => item.kind === "show" && item.message.includes("剪贴板")));
  // Modal closes after successful copy
  assert.equal(renderer.root.findAllByType("Modal" as never).length, 0);

  await act(async () => { renderer.unmount(); });
  harness.cleanup();
  assert.equal(harness.getRemoved(), 4);
});

test("Command Center falls back to openScreen when Sidebar is not mounted, and surfaces clipboard failure", async () => {
  mockHostState.copied = [];
  mockHostState.copyFailure = new Error("clipboard denied");
  mockHostState.toasts = [];

  const harness = createHarness();
  const insertCmd = harness.commands.get("prompt-manager-insert")!;

  // No sidebar mounted -> falls back to openScreen with modal=apply
  await insertCmd.onSelect({
    context: "global",
    openScreen: (input: { screenId: string; params?: Record<string, string> }) => { harness.openedScreens.push(input); },
  } as never);

  assert.equal(harness.openedScreens.length, 1);
  assert.equal(harness.openedScreens[0]!.screenId, "prompt-manager-hub");
  assert.equal(harness.openedScreens[0]!.params?.modal, "apply");

  // Mount screen in compact mode with params from fallback -> Apply Modal opens automatically
  const screenProps: PluginScreenProps = {
    theme,
    host: { id: "local", label: "Local" },
    layout: { compact: true, platform: "ios" },
    params: harness.openedScreens[0]!.params ?? {},
  };

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(harness.screen.Component, screenProps));
  });

  assert.equal(renderer.root.findAllByType("Modal" as never).length, 1);

  await act(async () => {
    findByTestId(renderer, "prompt-picker-item-p-1").props.onPress();
  });
  await act(async () => {
    findByTestId(renderer, "prompt-apply-confirm").props.onPress();
  });

  // Clipboard failed -> modal stays open and reports error toast
  assert.equal(renderer.root.findAllByType("Modal" as never).length, 1);
  assert.ok(mockHostState.toasts.some((item) => item.kind === "error"));

  await act(async () => { renderer.unmount(); });
  harness.cleanup();
});

test("Sidebar Management Screen supports creating, inserting placeholder tokens, saving, and deleting", async () => {
  mockHostState.copied = [];
  mockHostState.copyFailure = null;
  mockHostState.toasts = [];

  const harness = createHarness([]);
  const screenProps: PluginScreenProps = {
    theme,
    host: { id: "local", label: "Local" },
    layout: { compact: false, platform: "web" },
    params: {},
  };

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(harness.screen.Component, screenProps));
  });

  // Click "+ 新建"
  await act(async () => {
    findByTestId(renderer, "prompt-manager-new-btn").props.onPress();
  });

  await act(async () => {
    findByTestId(renderer, "prompt-editor-name").props.onChangeText("我的新 Prompt");
    findByTestId(renderer, "prompt-editor-tags").props.onChangeText("开发, 常用");
  });

  // Use quick-insert toolbar buttons
  await act(async () => {
    findByTestId(renderer, "insert-placeholder-text").props.onPress();
  });
  await act(async () => {
    findByTestId(renderer, "insert-placeholder-optional-line").props.onPress();
  });

  // Save via RPC
  await act(async () => {
    findByTestId(renderer, "prompt-editor-save-btn").props.onPress();
  });

  assert.equal(harness.getPrompts().length, 1);
  assert.equal(harness.getPrompts()[0]!.name, "我的新 Prompt");
  assert.deepEqual(harness.getPrompts()[0]!.tags, ["开发", "常用"]);
  assert.equal(harness.getPrompts()[0]!.placeholders.length, 2);

  // Open delete confirmation modal and confirm
  await act(async () => {
    findByTestId(renderer, "prompt-editor-delete-btn").props.onPress();
  });
  await act(async () => {
    findByTestId(renderer, "prompt-editor-delete-confirm").props.onPress();
  });

  assert.equal(harness.getPrompts().length, 0);

  await act(async () => { renderer.unmount(); });
  harness.cleanup();
});
