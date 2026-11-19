import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { PluginAgentPanelProps, PluginClientContext, PluginWorkspacePanelProps, SettingsState } from "@getpaseo/plugin/client";
import type { preferencesSchema } from "../../shared/settings";

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: { contents: `export { registerFileActivity } from './runtime'; export { ActivityView, FileActivityPanel } from './panel'; export { WorkspaceFileActivityPanel, listWorkspaceAgents } from './workspace'; export { FileActivitySettings } from './settings'; export { setSettingsState, setPaseo } from '@getpaseo/plugin/client';`, resolveDir: fileURLToPath(new URL("../../client", import.meta.url)), loader: "tsx" },
  bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react/jsx-runtime", "@tanstack/react-query"],
  plugins: [{ name: "native-host", setup(builder) {
    builder.onResolve({ filter: /^(@getpaseo\/plugin\/client(?:\/ui)?|react-native)$/ }, (args) => ({ path: args.path, namespace: "test-host" }));
    builder.onLoad({ filter: /.*/, namespace: "test-host" }, () => ({ loader: "js", contents:
      `import React from 'react'; const component = name => props => React.createElement(name, props, props.children);
       export const Text = component('Text'), View = component('View'), Pressable = component('Pressable'), ScrollView = component('ScrollView');
       export const SettingsAction = component('SettingsAction'), SettingsCard = component('SettingsCard'), SettingsRow = component('SettingsRow'), SettingsSection = component('SettingsSection'), SettingsSelect = component('SettingsSelect'), SettingsSwitch = component('SettingsSwitch');
       export const FlatList = props => React.createElement('FlatList', {data:props.data}, props.ListHeaderComponent, props.data.length ? props.data.map(item => React.createElement(React.Fragment, {key:props.keyExtractor(item)}, props.renderItem({item}))) : props.ListEmptyComponent);
       let state, paseo; export const useSettings = () => state; export const setSettingsState = value => {state = value;};
       export const usePaseo = () => paseo; export const setPaseo = value => {paseo = value;};
       export function useTabState(tab, schema, defaults) { const [value, update] = React.useState(() => {const parsed = schema.safeParse(tab.state); return parsed.success ? parsed.data : defaults;}); return [value, next => {tab.setState(next); update(next);}]; }` }));
  } }],
});
const module = { exports: {} as {
  registerFileActivity: typeof import("../../client/runtime").registerFileActivity;
  ActivityView: typeof import("../../client/panel").ActivityView;
  FileActivityPanel: typeof import("../../client/panel").FileActivityPanel;
  WorkspaceFileActivityPanel: typeof import("../../client/workspace").WorkspaceFileActivityPanel;
  listWorkspaceAgents: typeof import("../../client/workspace").listWorkspaceAgents;
  FileActivitySettings: typeof import("../../client/settings").FileActivitySettings;
  setSettingsState(state: SettingsState<typeof preferencesSchema>): void;
  setPaseo(paseo: PluginClientContext["paseo"]): void;
} };
new Function("require", "module", "exports", compiled.outputFiles[0]!.text)(require, module, module.exports);
export const { registerFileActivity, ActivityView, FileActivityPanel, WorkspaceFileActivityPanel, listWorkspaceAgents, FileActivitySettings, setSettingsState, setPaseo } = module.exports;
export function workspaceProps(): PluginWorkspacePanelProps {
  return { ...panelProps(), context: "workspace", params: {} };
}
export function panelProps(): PluginAgentPanelProps {
  return {
    host: { id: "host", label: "host" }, layout: { compact: false, platform: "web" },
    workspaceId: "w", context: "agent", agentId: "a", params: { agentId: "a" }, revision: 1,
    tab: { state: null, setState() {}, setModified() {} },
    theme: { colors: { surface0: "#101010", surface1: "#202020", surface2: "#303030", border: "#404040", foreground: "#eeeeee", foregroundMuted: "#aaaaaa",
      accent: "#7777ff", accentForeground: "#ffffff", statusSuccess: "#11aa11", statusWarning: "#ffbb00", statusDanger: "#ff1111" } },
  };
}
