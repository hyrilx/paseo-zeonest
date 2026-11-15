import type { PluginServerContext } from "@getpaseo/plugin/server";
import { featureCatalog } from "../shared/catalog.generated";
import { createLifetime, errorMessage } from "../shared/lifetime";
import { enabledFeatureIds } from "../shared/selection";
import { runtimeRpc } from "../shared/runtime";
import { shellSettings } from "../shared/settings";
import { featureContributions, featureSettingsContributions } from "./features.generated";

export function contributeShell(server: PluginServerContext) {
  const lifetime = createLifetime();
  const settings = server.registerSettings(shellSettings);
  let snapshot: { enabledIds: string[]; error: string | null } = { enabledIds: [], error: null };

  // Settings stay available while the corresponding behavior is disabled.
  for (const contribute of featureSettingsContributions) {
    lifetime.add(contribute(server));
  }

  // Entries must return cleanup synchronously. Defer host-backed reads, not the entry.
  const ready = settings.read().then((state) => {
    if (lifetime.closed) return;
    if (state.status !== "ready") throw new Error(state.error);
    const enabledIds = enabledFeatureIds(featureCatalog, state.values.enabled);
    for (const id of enabledIds) {
      const contribute = featureContributions[id];
      if (contribute) lifetime.add(contribute(server));
    }
    snapshot = { enabledIds, error: null };
  }).catch(async (error: unknown) => {
    snapshot = { enabledIds: [], error: errorMessage(error) };
    console.error("[zeonest] Startup failed; reload the plugin after fixing the error", error);
    try { await lifetime.dispose(); } catch (cleanupError) { console.error("[zeonest] Cleanup failed", cleanupError); }
  });

  server.handle(runtimeRpc, async () => {
    await ready;
    return snapshot;
  });

  return async () => {
    // Mark closed before awaiting the read so delayed startup cannot resurrect features.
    await Promise.all([ready, lifetime.dispose()]);
  };
}
