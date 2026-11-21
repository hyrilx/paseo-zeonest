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
    useEffect(() => {
      mounted.current = true;
      return () => { mounted.current = false; };
    }, []);
    async function reloadPlugin() {
      if (reloading.current || lifetime.closed) return;
      reloading.current = true;
      setReloadState({ status: "running", message: "正在请求宿主重新加载，配置页可能暂时关闭。" });
      try {
        const result = await client.rpc(reloadRpc, {});
        if (!mounted.current || lifetime.closed) return;
        setReloadState(result.error
          ? { status: "error", message: result.error }
          : { status: "unknown", message: "CLI 命令已结束。请重新打开 Zeonest 配置页，确认本次运行状态；加载错误请查看 Paseo 插件日志。" });
      } catch (error) {
        if (!mounted.current || lifetime.closed) return;
        setReloadState({ status: "unknown", message: `重载结果尚未确认：${errorMessage(error)}。自重载会中断连接，请查看 Paseo 插件状态；确认未完成后再重试。` });
      } finally {
        reloading.current = false;
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
