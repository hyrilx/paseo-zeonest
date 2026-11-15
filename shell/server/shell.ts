import type { PluginServerContext, PluginServerContribution } from "@getpaseo/plugin/server";
import type { FeatureMetadata } from "../shared/catalog";
import { createLifetime, errorMessage } from "../shared/lifetime";
import { enabledFeatureIds } from "../shared/selection";
import { runtimeRpc } from "../shared/runtime";
import { reloadRpc } from "../shared/reload";
import { createPluginReloader } from "./reload";
import { shellSettings } from "../shared/settings";

export function contributeShell(
  server: PluginServerContext,
  featureCatalog: readonly FeatureMetadata[],
  featureContributions: Readonly<Record<string, PluginServerContribution>>,
  featureSettingsContributions: readonly PluginServerContribution[],
  featureRpcContributions: readonly PluginServerContribution[] = [],
) {
  const lifetime = createLifetime();
  const reloader = createPluginReloader();
  server.handle(reloadRpc, () => reloader.reload());
  const settings = server.registerSettings(shellSettings);
  let snapshot: { enabledIds: string[]; error: string | null } = { enabledIds: [], error: null };

  // The host snapshots RPC names when this synchronous entry returns.
  // Declarations stay present; each feature guards its own disabled behavior.
  try {
    for (const contribute of [...featureSettingsContributions, ...featureRpcContributions]) {
      lifetime.add(contribute(server));
    }
  } catch (error) {
    reloader.dispose();
    void lifetime.dispose().catch((cleanupError) => console.error("[zeonest] Cleanup failed", cleanupError));
    throw error;
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
    reloader.dispose();
    await Promise.all([ready, lifetime.dispose()]);
  };
}
