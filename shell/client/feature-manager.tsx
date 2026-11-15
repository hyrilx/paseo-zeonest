import { useSettings, type PluginSurfaceProps, type PluginSettingsScreenContribution } from "@getpaseo/plugin/client";
import {
  SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import type { FeatureMetadata } from "../shared/catalog";
import { pendingFeatureIds } from "../shared/selection";
import { shellSettings } from "../shared/settings";
import type { RuntimeState } from "./runtime-store";

export interface ReloadState {
  status: "idle" | "running" | "error" | "unknown";
  message: string | null;
}

interface Props extends PluginSurfaceProps {
  reloadState: ReloadState;
  reloadPlugin(): void;
  runtime: RuntimeState;
  featureCatalog: readonly FeatureMetadata[];
  featureSettingsScreens: Readonly<Record<string, PluginSettingsScreenContribution>>;
  openSettings(id: string): void;
}

export function FeatureManager({ theme, layout, runtime, openSettings, featureCatalog, featureSettingsScreens, reloadState, reloadPlugin }: Props) {
  const settings = useSettings(shellSettings);
  const colors = theme.colors;
  const reloading = reloadState.status === "running";
  const pending = settings.status === "ready" && runtime.status === "ready"
    ? pendingFeatureIds(featureCatalog, settings.values.enabled, runtime.enabledIds) : [];
  const muted = { color: colors.foregroundMuted, fontSize: 13, lineHeight: 20 };
  const error = { color: colors.statusDanger, fontSize: 13, lineHeight: 20 };

  return (
    <View style={{ gap: layout.compact ? 16 : 24, backgroundColor: colors.surface0 }}>
      <View style={{ gap: 8 }}>
        <Text style={{ color: colors.foreground, fontSize: 22, fontWeight: "600" }}>功能集</Text>
        <Text style={muted}>查阅、开关和配置随 Zeonest 一起分发的子功能。</Text>
        <Text style={muted}>开关保存后，点击下方「重新加载插件」，所有连接的客户端将统一应用。子功能自己的设置以各自页面说明为准。</Text>
      </View>

      {settings.status === "loading" && <Text style={muted}>正在读取已保存的开关…</Text>}
      {(settings.status === "error" || settings.status === "invalid") && (
        <SettingsSection title="无法读取开关">
          <SettingsCard>
            <SettingsAction label={settings.error} actionLabel="重新读取"
              onPress={() => { void settings.reload(); }} />
            {settings.status === "invalid" && <SettingsAction label="恢复所有子功能为关闭"
              hint="仅重置壳的开关，不改动子功能配置。" actionLabel="重置开关"
              disabled={settings.saving || reloading} onPress={() => { if (!reloading) void settings.reset(); }} />}
          </SettingsCard>
        </SettingsSection>
      )}
      {settings.saveError && (
        <SettingsCard><SettingsAction label={settings.saveError}
          hint="保存未成功。重新读取后再操作，避免覆盖其他客户端的修改。"
          actionLabel="重新读取" onPress={() => { void settings.reload(); }} /></SettingsCard>
      )}
      {runtime.status === "loading" && <Text style={muted}>正在读取本次运行状态…</Text>}
      {runtime.status === "error" && (
        <Text style={error}>启动失败：{runtime.error}。本次运行状态不可确认，请查看插件日志，修复后重新加载插件。</Text>
      )}
      {pending.length > 0 && (
        <Text style={{ ...muted, color: colors.statusWarning }}>
          {pending.length} 项开关已保存，等待重新加载插件生效。
        </Text>
      )}

      <SettingsSection title="插件操作">
        <SettingsCard>
          <SettingsAction label="重新加载插件" actionLabel={reloading ? "正在重新加载…" : "重新加载"}
            hint="重新加载整个 Zeonest，应用已保存的开关；所有连接客户端都会更新。需要宿主可执行 paseo CLI。"
            disabled={settings.saving || reloading}
            onPress={() => { if (!settings.saving && !reloading) reloadPlugin(); }} />
        </SettingsCard>
        {reloadState.message && <Text style={{ ...muted,
          color: reloadState.status === "error" ? colors.statusDanger : colors.statusWarning,
        }}>{reloadState.message}</Text>}
      </SettingsSection>

      {featureCatalog.length === 0 ? (
        <SettingsSection title="尚未集成子功能">
          <SettingsCard><SettingsRow label="当前容器为空"
            hint="新增子功能并重新构建后，名称、描述、版本、标签、作者和配置入口会出现在这里。" /></SettingsCard>
        </SettingsSection>
      ) : featureCatalog.map((feature) => {
        const enabled = settings.status === "ready" && settings.values.enabled[feature.id] === true;
        const running = runtime.enabledIds.includes(feature.id);
        const screen = featureSettingsScreens[feature.id];
        return (
          <SettingsSection key={feature.id} title={feature.name}>
            <SettingsCard>
              <SettingsRow label={feature.name} hint={feature.description}>
                <View style={{ gap: 4, flexShrink: 1 }}>
                  <Text style={muted}>版本 {feature.version} / 作者 {feature.author}</Text>
                  <Text style={muted}>标签：{feature.tags.length ? feature.tags.join("、") : "无"}</Text>
                  <Text style={muted}>
                    {runtime.status === "ready" ? (running ? "本次运行：已启用" : "本次运行：未启用") : "本次运行：未确认"}
                  </Text>
                </View>
              </SettingsRow>
              <SettingsSwitch label="启用子功能" hint="开关保存后重新加载插件生效。"
                value={enabled} disabled={settings.status !== "ready" || settings.saving || reloading}
                onValueChange={(value) => {
                  if (settings.status !== "ready" || settings.saving || reloading) return;
                  void settings.save({
                    ...settings.values, enabled: { ...settings.values.enabled, [feature.id]: value },
                  }, settings.revision);
                }} />
              {screen
                ? <SettingsAction label="子功能配置" actionLabel="打开配置"
                    onPress={() => openSettings(screen.id)} />
                : <SettingsRow label="无需配置" hint="此子功能未提供配置页面。" />}
            </SettingsCard>
          </SettingsSection>
        );
      })}
    </View>
  );
}
