import type { PluginSurfaceProps, PluginSettingsScreenContribution, SettingsState } from "@getpaseo/plugin/client";
import { Icon, SettingsAction, SettingsCard, SettingsSection, TextInput } from "@getpaseo/plugin/client/ui";
import { ActivityIndicator, Pressable, Switch, Text, View } from "react-native";
import type { FeatureMetadata } from "../shared/catalog";
import { pendingFeatureIds } from "../shared/selection";
import type { shellSettings } from "../shared/settings";
import type { RuntimeState } from "./runtime-store";

export interface ReloadState {
  status: "idle" | "running" | "error";
  message: string | null;
}

interface BannerState {
  kind: "ready" | "warning" | "loading" | "error";
  label: string;
  hint: string;
  accentButton: boolean;
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
  const loadingStatus = settings.status === "loading" || runtime.status === "loading";
  const toggleDisabled = settings.status !== "ready" || settings.saving || reloading;
  const reloadDisabled = settings.saving || reloading || loadingStatus;
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
  const banner = resolveBannerState({ reloading, loadingStatus, reloadState, runtime, pendingCount: pending.length });

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

      <SettingsCard testID="zeonest-status-banner">
        <View style={{
          flexDirection: "row", alignItems: "center", gap: 10,
          paddingHorizontal: 14, paddingVertical: 10, minHeight: 58,
        }}>
          <View testID="zeonest-status-icon" style={{
            width: 24, height: 24, alignItems: "center", justifyContent: "center", flexShrink: 0,
          }}>
            {banner.kind === "loading" ? (
              <ActivityIndicator size="small" color={reloading ? colors.accent : colors.foregroundMuted} />
            ) : (
              <Icon
                name={banner.kind === "ready" ? "CircleCheck" : banner.kind === "warning" ? "TriangleAlert" : "CircleAlert"}
                size={18}
                color={banner.kind === "ready" ? colors.statusSuccess : banner.kind === "warning" ? colors.statusWarning : colors.statusDanger}
              />
            )}
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }} accessibilityLiveRegion="polite">
            <Text
              numberOfLines={banner.kind === "error" ? undefined : 1}
              style={{
                color: banner.kind === "error" ? colors.statusDanger : colors.foreground,
                fontSize: 14, fontWeight: "600", lineHeight: 20,
              }}
            >
              {banner.label}
            </Text>
            <Text
              accessibilityRole={banner.kind === "error" ? "alert" : undefined}
              numberOfLines={banner.kind === "error" ? undefined : 1}
              style={{
                color: banner.kind === "error" ? colors.statusDanger : colors.foregroundMuted,
                fontSize: 12, lineHeight: 17,
              }}
            >
              {banner.hint}
            </Text>
          </View>
          <Pressable
            testID="zeonest-reload-button"
            accessibilityRole="button"
            accessibilityLabel={reloading ? "正在重新加载" : "重新加载"}
            accessibilityState={{ disabled: reloadDisabled, busy: reloading }}
            disabled={reloadDisabled}
            hitSlop={4}
            onPress={() => { if (!reloadDisabled) reloadPlugin(); }}
            style={({ pressed }) => ({
              flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
              minHeight: layout.compact ? 40 : 36, paddingHorizontal: 12, borderRadius: 8, flexShrink: 0,
              borderWidth: 1,
              borderColor: banner.accentButton ? colors.accent : colors.border,
              backgroundColor: banner.accentButton
                ? colors.accent
                : pressed ? colors.surface2 : colors.surface0,
              opacity: reloadDisabled ? 0.5 : pressed ? 0.85 : 1,
            })}
          >
            <Icon
              name="RefreshCw"
              size={14}
              color={banner.accentButton ? colors.accentForeground : colors.foregroundMuted}
            />
            <Text style={{
              color: banner.accentButton ? colors.accentForeground : colors.foreground,
              fontSize: 13, fontWeight: "500", lineHeight: 18,
            }}>
              重新加载
            </Text>
          </Pressable>
        </View>
      </SettingsCard>

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

function resolveBannerState({ reloading, loadingStatus, reloadState, runtime, pendingCount }: {
  reloading: boolean;
  loadingStatus: boolean;
  reloadState: ReloadState;
  runtime: RuntimeState;
  pendingCount: number;
}): BannerState {
  if (reloading) {
    return { kind: "loading", label: "正在重新加载", hint: "完成后页面将自动刷新", accentButton: false };
  }
  if (reloadState.status === "error") {
    return { kind: "error", label: "重新加载失败", hint: reloadState.message ?? "请检查插件状态后重试。", accentButton: false };
  }
  if (runtime.status === "error") {
    return { kind: "error", label: "插件启动失败", hint: `启动失败：${runtime.error}。请查看插件日志，修复后重新加载。`, accentButton: false };
  }
  if (loadingStatus) {
    return { kind: "loading", label: "正在读取运行状态", hint: "正在同步开关与本次运行状态", accentButton: false };
  }
  if (pendingCount > 0) {
    return { kind: "warning", label: `${pendingCount} 项开关待生效`, hint: "点击重新加载后生效", accentButton: true };
  }
  return { kind: "ready", label: "运行正常", hint: "当前开关配置已生效", accentButton: false };
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
