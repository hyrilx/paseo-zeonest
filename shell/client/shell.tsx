import { useSettings, type PluginClientContext, type PluginClientContribution, type PluginSettingsScreenContribution, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { createLifetime, errorMessage } from "../shared/lifetime";
import { runtimeRpc } from "../shared/runtime";
import { reloadRpc } from "../shared/reload";
import { shellSettings } from "../shared/settings";
import type { FeatureMetadata } from "../shared/catalog";
import { FeatureManager, type ReloadState } from "./feature-manager";
import { createRuntimeStore } from "./runtime-store";
import { useSettingsViewport } from "./settings-viewport";

const RELOAD_REFRESH_TIMEOUT_MS = 30_000;

export function contributeShell(
  client: PluginClientContext,
  featureCatalog: readonly FeatureMetadata[],
  featureContributions: Readonly<Record<string, PluginClientContribution>>,
  featureSettingsScreens: Readonly<Record<string, PluginSettingsScreenContribution>>,
) {
  const lifetime = createLifetime();
  const store = createRuntimeStore();

  function Settings(props: PluginSurfaceProps) {
    // Keep the saved switches (and any in-flight save) while visiting child settings.
    const settings = useSettings(shellSettings);
    const runtime = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const [reloadState, setReloadState] = useState<ReloadState>({ status: "idle", message: null });
    const [settingsId, setSettingsId] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const viewport = useSettingsViewport(props.layout.platform, settingsId);
    const reloading = useRef(false);
    const mounted = useRef(false);
    const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    function clearRefreshTimer() {
      if (refreshTimer.current !== undefined) {
        clearTimeout(refreshTimer.current);
        refreshTimer.current = undefined;
      }
    }
    useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
        clearRefreshTimer();
      };
    }, []);
    function awaitPageRefresh(reason?: string) {
      clearRefreshTimer();
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = undefined;
        if (!mounted.current || lifetime.closed) return;
        reloading.current = false;
        setReloadState({
          status: "error",
          message: reason
            ? `等待页面刷新超时（${reason}），请检查插件状态后重试。`
            : "等待页面刷新超时，请检查插件状态后重试。",
        });
      }, RELOAD_REFRESH_TIMEOUT_MS);
    }
    async function reloadPlugin() {
      if (reloading.current || lifetime.closed) return;
      reloading.current = true;
      clearRefreshTimer();
      setReloadState({ status: "running", message: null });
      try {
        const result = await client.rpc(reloadRpc, {});
        if (!mounted.current || lifetime.closed) return;
        if (result.error) {
          reloading.current = false;
          setReloadState({ status: "error", message: result.error });
        } else {
          awaitPageRefresh();
        }
      } catch (error) {
        if (!mounted.current || lifetime.closed) return;
        awaitPageRefresh(errorMessage(error));
      }
    }
    const screen = Object.values(featureSettingsScreens).find((screen) => screen.id === settingsId);
    if (screen) {
      const Component = screen.Component;
      const colors = props.theme.colors;
      return viewport.render(
        <View style={{ gap: 12, backgroundColor: colors.surface0 }}>
          <View style={{ alignItems: "flex-start", gap: 4 }}>
            <Pressable accessibilityRole="button" accessibilityLabel="返回功能集" onPress={() => setSettingsId(null)} style={({ pressed }) => ({
              flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44, paddingRight: 8,
              borderRadius: 6, backgroundColor: pressed ? colors.surface2 : "transparent",
            })}>
              <Icon name="ArrowLeft" size={16} color={colors.foregroundMuted} />
              <Text style={{ color: colors.foreground, fontSize: 14 }}>返回功能集</Text>
            </Pressable>
            <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 20, fontWeight: "600" }}>{screen.title}</Text>
          </View>
          <Component key={screen.id} {...props} />
        </View>,
      );
    }
    return viewport.render(<FeatureManager {...props} settings={settings} runtime={runtime} featureCatalog={featureCatalog} featureSettingsScreens={featureSettingsScreens}
      reloadState={reloadState} reloadPlugin={() => { void reloadPlugin(); }}
      width={viewport.width} query={query} setQuery={setQuery}
      openSettings={(id) => { viewport.rememberListOffset(); setSettingsId(id); }} />);
  }

  lifetime.add(client.addSettingsScreen({
    id: "zeonest-features", title: "功能集", icon: "Blocks", Component: Settings,
  }));
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
