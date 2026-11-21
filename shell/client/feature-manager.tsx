import type { PluginSurfaceProps, PluginSettingsScreenContribution, SettingsState } from "@getpaseo/plugin/client";
import { Icon, SettingsAction, SettingsCard, SettingsSection, TextInput } from "@getpaseo/plugin/client/ui";
import { Pressable, Switch, Text, View } from "react-native";
import type { FeatureMetadata } from "../shared/catalog";
import { pendingFeatureIds } from "../shared/selection";
import type { shellSettings } from "../shared/settings";
import type { RuntimeState } from "./runtime-store";

export interface ReloadState {
  status: "idle" | "running" | "error" | "unknown";
  message: string | null;
}

interface Props extends PluginSurfaceProps {
  settings: SettingsState<typeof shellSettings.schema>;
  reloadState: ReloadState;
  reloadPlugin(): void;
  runtime: RuntimeState;
  featureCatalog: readonly FeatureMetadata[];
  featureSettingsScreens: Readonly<Record<string, PluginSettingsScreenContribution>>;
  openSettings(id: string): void;
  width: number;
  query: string;
  setQuery(query: string): void;
}

const CARD_GAP = 12;
const MIN_CARD_WIDTH = 280;
const inline = { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 } as const;

export function FeatureManager({
  theme, layout, settings, runtime, openSettings, featureCatalog, featureSettingsScreens, reloadState, reloadPlugin, width, query, setQuery,
}: Props) {
  const colors = theme.colors;
  const reloading = reloadState.status === "running";
  const toggleDisabled = settings.status !== "ready" || settings.saving || reloading;
  const pending = settings.status === "ready" && runtime.status === "ready"
    ? pendingFeatureIds(featureCatalog, settings.values.enabled, runtime.enabledIds) : [];
  const pendingIds = new Set(pending);
  const runningIds = new Set(runtime.enabledIds);
  const needle = query.trim().toLowerCase();
  const visible = needle ? featureCatalog.filter((feature) =>
    [feature.name, feature.description, feature.author, ...feature.tags].some((value) => value.toLowerCase().includes(needle)),
  ) : featureCatalog;
  const twoColumns = !layout.compact && width >= MIN_CARD_WIDTH * 2 + CARD_GAP;
  const muted = { color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 };

  return (
    <View style={{ gap: 12, backgroundColor: colors.surface0 }}>
      <View style={twoColumns ? inline : { gap: 8 }}>
        <View style={{ flexShrink: 1, gap: 3 }}>
          <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 20, fontWeight: "600" }}>功能集</Text>
          <Text style={muted} accessibilityLiveRegion="polite">
            {needle ? `${visible.length} / ${featureCatalog.length} 项功能` : `${featureCatalog.length} 项功能`}
            {runtime.status === "ready" && ` · ${visible.filter(({ id }) => runningIds.has(id)).length} 项运行中`}
          </Text>
        </View>
        {featureCatalog.length > 0 && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderColor: colors.border,
            borderRadius: 8, backgroundColor: colors.surface1, paddingHorizontal: 10, width: twoColumns ? 252 : "100%" }}>
            <Icon name="Search" size={16} color={colors.foregroundMuted} />
            <TextInput accessibilityLabel="搜索功能" placeholder="搜索名称、说明、标签、作者" placeholderTextColor={colors.foregroundMuted}
              value={query} onChangeText={setQuery} autoCorrect={false} autoCapitalize="none" returnKeyType="search"
              style={{ flex: 1, minWidth: 0, minHeight: 42, color: colors.foreground, fontSize: 14 }} />
          </View>
        )}
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
        <Text accessibilityRole="alert" style={{ ...muted, color: colors.statusDanger }}>
          启动失败：{runtime.error}。请查看插件日志，修复后从 Paseo 插件菜单重新加载。
        </Text>
      )}
      {(pending.length > 0 || reloading || reloadState.status === "error") && (
        <SettingsCard>
          <SettingsAction label={pending.length ? `${pending.length} 项开关已保存，等待生效` : "应用已保存的开关"}
            hint="重新加载 Zeonest 后，变更将在所有连接的客户端生效。"
            actionLabel={reloading ? "正在重新加载…" : "重新加载"}
            disabled={settings.saving || reloading}
            onPress={() => { if (!settings.saving && !reloading) reloadPlugin(); }} />
        </SettingsCard>
      )}
      {reloadState.message && <Text accessibilityLiveRegion="polite" style={{ ...muted,
        color: reloadState.status === "error" ? colors.statusDanger : colors.statusWarning,
      }}>{reloadState.message}</Text>}

      {visible.length === 0 ? (
        <SettingsCard>
          <Text style={{ ...muted, padding: 12 }}>
            {featureCatalog.length ? "没有匹配的功能，试试其他关键词。" : "尚未集成子功能。"}
          </Text>
        </SettingsCard>
      ) : (
        <View testID="zeonest-feature-grid" style={{ flexDirection: "row", flexWrap: "wrap", gap: CARD_GAP }}>
          {visible.map((feature) => {
            const screen = featureSettingsScreens[feature.id];
            return renderFeatureCard({
              feature, colors, width: twoColumns ? (width - CARD_GAP) / 2 : "100%",
              running: runtime.status === "ready" ? runningIds.has(feature.id) : undefined,
              pending: pendingIds.has(feature.id),
              enabled: settings.status === "ready" && settings.values.enabled[feature.id] === true,
              disabled: toggleDisabled,
              openSettings: screen ? () => openSettings(screen.id) : undefined,
              setEnabled: (value) => {
                if (settings.status !== "ready" || toggleDisabled) return;
                void settings.save({
                  ...settings.values, enabled: { ...settings.values.enabled, [feature.id]: value },
                }, settings.revision);
              },
            });
          })}
        </View>
      )}
    </View>
  );
}

function renderFeatureCard({ feature, colors, width, running, pending, enabled, disabled, setEnabled, openSettings }: {
  feature: FeatureMetadata;
  colors: PluginSurfaceProps["theme"]["colors"];
  width: number | "100%";
  running: boolean | undefined;
  pending: boolean;
  enabled: boolean;
  disabled: boolean;
  setEnabled(value: boolean): void;
  openSettings: (() => void) | undefined;
}) {
  const status = running === undefined ? "状态未确认" : pending
    ? (running ? "运行中 · 待关闭" : "未启用 · 待启用") : running ? "运行中" : "未启用";
  const statusColor = pending ? colors.statusWarning : running ? colors.statusSuccess : colors.foregroundMuted;
  return (
    <View key={feature.id} testID={`zeonest-feature-${feature.id}`} style={{
      width, borderWidth: 1, borderColor: colors.border,
      backgroundColor: colors.surface1, borderRadius: 10, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 4,
    }}>
      <View style={inline}>
        <Text accessibilityRole="header" style={{ flexShrink: 1, color: colors.foreground, fontSize: 15, fontWeight: "600" }}>
          {feature.name}
        </Text>
        <Switch accessibilityLabel={`启用${feature.name}`} value={enabled} disabled={disabled}
          trackColor={{ false: colors.border, true: colors.accent }} ios_backgroundColor={colors.surface2} hitSlop={6}
          onValueChange={setEnabled} />
      </View>
      <View style={{ flexGrow: 1, gap: 5, paddingVertical: 5 }}>
        <Text style={{ color: colors.foreground, fontSize: 13, lineHeight: 19 }}>{feature.description}</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 19 }}>
          {[`v${feature.version}`, feature.author, feature.tags.join("、")].filter(Boolean).join(" · ")}
        </Text>
      </View>
      <View style={{ ...inline, minHeight: openSettings || width !== "100%" ? 44 : 28, borderTopWidth: 1, borderTopColor: colors.border }}>
        <Text style={{ flexShrink: 1, color: statusColor, fontSize: 12, lineHeight: 18 }}>{status}</Text>
        {openSettings && <Pressable accessibilityRole="button" accessibilityLabel={`${feature.name}：打开配置`}
          onPress={openSettings} style={({ pressed }) => ({
            minHeight: 44, borderRadius: 6, paddingHorizontal: 5, flexDirection: "row", alignItems: "center", gap: 3,
            backgroundColor: pressed ? colors.surface2 : "transparent",
          })}>
          <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "500" }}>配置</Text>
          <Icon name="ChevronRight" size={14} color={colors.foregroundMuted} />
        </Pressable>}
      </View>
    </View>
  );
}
