import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { PluginButtonContentProps, PluginClientContext, PluginComposerPillContribution, SettingsState } from "@getpaseo/plugin/client";
import { preferencesSchema } from "../../shared/settings";
import type { PreferencesStore } from "../../client/preferences";
import type { ReactElement } from "react";
import type { AgentSnapshot, TimelineItem, TimelineMessage, TimelinePage } from "../../client/types";
import type { StatsStore } from "../../client/store";

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: { contents: `export { startSessionStats } from './runtime'; export { SessionStatsDetails } from './details'; export { SessionStatsSettings } from './settings'; export { setSettingsState } from '@getpaseo/plugin/client';`, resolveDir: fileURLToPath(new URL("../../client", import.meta.url)), loader: "tsx" },
  bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react/jsx-runtime"],
  plugins: [{ name: "native-host", setup(builder) {
    builder.onResolve({ filter: /^(@getpaseo\/plugin\/client(?:\/ui)?|react-native)$/ }, (args) => ({ path: args.path, namespace: "test-host" }));
    builder.onLoad({ filter: /.*/, namespace: "test-host" }, () => ({ loader: "js", contents:
      `import React from 'react'; const component = name => props => React.createElement(name, props, props.children);
       export const Text = component('Text'), View = component('View'), Pressable = component('Pressable'), ScrollView = component('ScrollView'), Icon = component('Icon');
       export const SettingsAction = component('SettingsAction'), SettingsCard = component('SettingsCard'), SettingsRow = component('SettingsRow'), SettingsSection = component('SettingsSection'), SettingsSelect = component('SettingsSelect'), SettingsSwitch = component('SettingsSwitch');
       let state; export const useSettings = () => state; export const setSettingsState = value => { state = value; };` }));
  } }],
});
const module = { exports: {} as {
  startSessionStats: typeof import("../../client/runtime").startSessionStats;
  SessionStatsDetails: typeof import("../../client/details").SessionStatsDetails;
  SessionStatsSettings: typeof import("../../client/settings").SessionStatsSettings;
  setSettingsState(state: SettingsState<typeof preferencesSchema>): void;
} };
new Function("require", "module", "exports", compiled.outputFiles[0]!.text)(require, module, module.exports);
export const { startSessionStats, SessionStatsDetails, SessionStatsSettings, setSettingsState } = module.exports;

export const props: PluginButtonContentProps = {
  host: { id: "host", label: "host" }, layout: { compact: false, platform: "web" },
  context: "agent", agentId: "a", workspaceId: "w", close() {},
  theme: { colors: { surface0: "#101010", surface1: "#202020", surface2: "#303030", border: "#404040", foreground: "#eeeeee", foregroundMuted: "#aaaaaa",
    accent: "#7777ff", accentForeground: "#ffffff", statusSuccess: "#11aa11", statusWarning: "#ffbb00", statusDanger: "#ff1111" } },
};
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export const agent = (id = "a", workspaceId = "w"): AgentSnapshot => ({ id, workspaceId, archivedAt: null } as AgentSnapshot);
export const entry = (item: TimelineItem, seq: number, turnId = "history") => ({
  item, turnId, seqStart: seq, seqEnd: seq, provider: "pi", timestamp: "2026-01-01T00:00:00.000Z", sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [],
});
export function page(entries: ReturnType<typeof entry>[] = [], overrides: Partial<TimelinePage> = {}): TimelinePage {
  return { agentId: "a", agent: null, requestId: "r", direction: "tail", projection: "canonical", epoch: "e", reset: false, staleCursor: false, gap: false,
    window: { minSeq: 0, maxSeq: entries.at(-1)?.seqEnd ?? 0, nextSeq: 1 }, startCursor: entries.length ? { epoch: "e", seq: entries[0]!.seqStart } : null, endCursor: null,
    hasOlder: false, hasNewer: false, entries, error: null, ...overrides };
}
export function message(event: TimelineMessage["event"], seq?: number, agentId = "a", epoch = "e"): TimelineMessage {
  return { agentId, event, seq, epoch, timestamp: "2026-01-01T00:00:00.000Z" } as TimelineMessage;
}
export function toolItem(callId: string, status: "running" | "completed" | "failed" | "canceled" = "completed"): TimelineItem {
  return { type: "tool_call", callId, name: "test", status, error: null, detail: { type: "unknown", input: {}, output: {} } };
}
export interface Pill {
  contribution: PluginComposerPillContribution;
  label: string;
  removed: number;
  updates: number;
  source(): StatsStore;
  configuration(): PreferencesStore;
  reloadPreferences(): void;
  retry(): void;
}
type Observer = { snapshot(value: { entries: { agent: AgentSnapshot }[] }): void; update(message: unknown): void; error(error: Error): void };
export function fakeHost(initial = [agent()]) {
  const pills: Pill[] = [];
  const handlers = new Map<string, ((message: TimelineMessage) => void)[]>();
  const fetches: { id: string; options: unknown }[] = [];
  const released: string[] = [];
  const ready = new Map<string, Promise<void>>();
  let observer!: Observer;
  let current = initial;
  let directoryReleases = 0;
  let unobserves = 0;
  let settingsRead: () => Promise<unknown> = async () => ({ status: "ready", values: preferencesSchema.parse({}), revision: "r1" });
  let settingsReads = 0;
  let read: (id: string, options: unknown) => Promise<TimelinePage> = async (id) => page([], { agentId: id });
  const directory = {
    subscribe(value: Observer) { observer = value; observer.snapshot({ entries: current.map((agent) => ({ agent })) }); return () => { unobserves++; }; },
    async release() { directoryReleases++; },
  };
  const client = {
    rpc: async () => { settingsReads++; return settingsRead(); },
    paseo: { agents: {
      list: async () => ({ entries: current.map((agent) => ({ agent })), subscription: directory }),
      ref: (snapshot: AgentSnapshot) => ({ timeline: {
        subscribe(handler: (message: TimelineMessage) => void) {
          handlers.set(snapshot.id, [...handlers.get(snapshot.id) ?? [], handler]);
          return { ready: ready.get(snapshot.id) ?? Promise.resolve(), async release() { released.push(snapshot.id); } };
        },
        refetch: async (options: unknown) => { fetches.push({ id: snapshot.id, options }); return read(snapshot.id, options); },
      } }),
    } },
    addComposerPill(contribution: PluginComposerPillContribution) {
      const get = () => {
        if (contribution.button.behavior.kind !== "popover") throw new Error("Expected popover");
        const Content = contribution.button.behavior.Content as (props: PluginButtonContentProps) => ReactElement<{ source: StatsStore; configuration: PreferencesStore; reloadPreferences(): void; retry(): void }>;
        return Content(props).props;
      };
      const pill: Pill = { contribution, label: String(contribution.button.label), removed: 0, updates: 0, source: () => get().source, configuration: () => get().configuration, reloadPreferences: () => get().reloadPreferences(), retry: () => get().retry() };
      pills.push(pill);
      return { update(patch: { label?: string }) { pill.updates++; if (patch.label !== undefined) pill.label = patch.label; }, remove() { pill.removed++; } };
    },
  } as unknown as PluginClientContext;
  return {
    client, pills, handlers, fetches, released, ready, directory,
    setRead(value: typeof read) { read = value; },
    setSettingsRead(value: typeof settingsRead) { settingsRead = value; },
    get settingsReads() { return settingsReads; },
    emit(value: TimelineMessage) { handlers.get(value.agentId)?.at(-1)?.(value); },
    snapshot(agents: AgentSnapshot[]) { current = agents; observer.snapshot({ entries: agents.map((agent) => ({ agent })) }); },
    update(snapshot: AgentSnapshot) { observer.update({ type: "agent_update", payload: { kind: "upsert", agent: snapshot } }); },
    remove(id: string) { observer.update({ type: "agent_update", payload: { kind: "remove", agentId: id } }); },
    directoryError() { observer.error(new Error("offline")); },
    get directoryReleases() { return directoryReleases; },
    get unobserves() { return unobserves; },
  };
}
