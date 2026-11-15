import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSyncExternalStore } from "react";
import { createLifetime, errorMessage } from "../shared/lifetime";
import { runtimeRpc } from "../shared/runtime";
import { featureContributions, featureSettingsScreens } from "./features.generated";
import { FeatureManager } from "./feature-manager";
import { createRuntimeStore } from "./runtime-store";

export function contributeShell(client: PluginClientContext) {
  const lifetime = createLifetime();
  const store = createRuntimeStore();

  function Settings(props: PluginSurfaceProps) {
    const runtime = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    return <FeatureManager {...props} runtime={runtime}
      openSettings={(id) => client.openSettings(id)} />;
  }

  lifetime.add(client.addSettingsScreen({
    id: "zeonest-features", title: "功能集", icon: "Blocks", Component: Settings,
  }));
  for (const screen of Object.values(featureSettingsScreens)) {
    lifetime.add(client.addSettingsScreen(screen));
  }
  lifetime.add(client.addCommandCenterItem({
    id: "zeonest-settings", title: "Zeonest：管理功能集", icon: "Blocks",
    context: "global",
    onSelect: ({ openSettings }) => openSettings("zeonest-features"),
  }));

  const ready = client.rpc(runtimeRpc, {}).then((snapshot) => {
    if (lifetime.closed) return;
    if (snapshot.error) throw new Error(snapshot.error);
    for (const id of snapshot.enabledIds) {
      const contribute = featureContributions[id];
      if (contribute) lifetime.add(contribute(client));
    }
    store.set({ status: "ready", ...snapshot });
  }).catch((error: unknown) => {
    if (lifetime.closed) return;
    console.error("[zeonest] Client startup failed; reload the plugin", error);
    store.set({ status: "error", enabledIds: [], error: errorMessage(error) });
  });

  return async () => {
    await Promise.all([ready, lifetime.dispose()]);
  };
}
