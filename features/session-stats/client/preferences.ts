import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { preferences, preferencesSchema, type Preferences } from "../shared/settings";

export function createPreferencesStore() {
  let snapshot = { values: preferencesSchema.parse({}), error: "" };
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set(values: Preferences, error = "") {
      if (JSON.stringify(snapshot) === JSON.stringify({ values, error })) return;
      snapshot = { values, error };
      for (const listener of listeners) listener();
    },
  };
}
export type PreferencesStore = ReturnType<typeof createPreferencesStore>;

// One native settings read per client every two seconds, shared by all its pills.
export function observePreferences(client: PluginClientContext, changed: () => void) {
  const source = createPreferencesStore();
  const read = settingsRpc(preferences.id).read;
  let stopped = false;
  let reading = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function refresh() {
    if (stopped || reading) return;
    clearTimeout(timer);
    reading = true;
    try {
      const state = await client.rpc(read, {});
      if (stopped) return;
      if (state.status !== "ready") throw new Error(state.error);
      source.set(preferencesSchema.parse(state.values));
    } catch {
      if (!stopped) source.set(source.get().values, "配置读取失败");
    } finally {
      reading = false;
      if (!stopped) { changed(); timer = setTimeout(() => { void refresh(); }, 2000); }
    }
  }
  void refresh();
  return { source, refresh, stop() { stopped = true; clearTimeout(timer); } };
}
