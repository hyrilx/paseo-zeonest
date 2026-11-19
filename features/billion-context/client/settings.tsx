import { useRef, useState } from "react";
import { Text, View } from "react-native";
import { useSettings, type PluginSettingsScreenContribution, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { preferences, preferencesSchema } from "../shared/settings";
import { ServiceControls } from "./service-controls";

type Ready = Extract<SettingsState<typeof preferencesSchema>, { status: "ready" }>;
function Editor({ settings, theme, saved }: { settings: Ready; theme: PluginSurfaceProps["theme"]; saved(): void }) {
  const [revision] = useState(settings.revision);
  const [legacyOrigin] = useState(settings.values.serverOrigin);
  const [biliCommand, setBiliCommand] = useState(settings.values.biliCommand);
  const [browserOrigin, setBrowserOrigin] = useState(settings.values.browserOrigin);
  const [error, setError] = useState("");
  const lock = useRef(false);
  async function save() {
    if (lock.current) return;
    const parsed = preferencesSchema.safeParse({ serverOrigin: legacyOrigin, biliCommand, browserOrigin });
    if (!parsed.success) { setError(parsed.error.issues.map((issue) => issue.message).join("；")); return; }
    lock.current = true; setError("");
    try { if (await settings.save(parsed.data, revision)) saved(); }
    finally { lock.current = false; }
  }
  return <View style={{ gap: 16 }}><SettingsCard>
    <SettingsInput label="Bili 可执行文件" initialValue={biliCommand} onChangeText={setBiliCommand} disabled={settings.saving}
      hint="默认 bili，使用 Paseo daemon 的 PATH。找不到时填写绝对路径，不附加命令参数；需要预先安装 Bili 和 Pi 的 Billion Context 扩展。更换命令后，下次启动或显式重启服务时使用。" />
    <SettingsInput label="客户端访问地址（可选）" initialValue={browserOrigin} onChangeText={setBrowserOrigin} disabled={settings.saving}
      hint="留空使用托管服务地址。可用 http://my-host:{port} 展开为固定服务端口；固定转发端口请填写数字。地址须指向同一实例，本功能不会建立隧道。" />
    <SettingsAction label="保存启动器配置" actionLabel={settings.saving ? "保存中…" : "保存"} disabled={settings.saving} onPress={() => { void save(); }} />
  </SettingsCard>
    {settings.revision !== revision && <Text style={{ color: theme.colors.statusWarning }}>配置已被其他客户端更新，当前草稿仍保留原 revision。请复制草稿后重新读取。</Text>}
    {error ? <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
  </View>;
}
export function DashboardSettings({ theme, layout, host }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const [epoch, setEpoch] = useState(0);
  const [message, setMessage] = useState("");
  return <View style={{ gap: layout.compact ? 16 : 24, backgroundColor: theme.colors.surface0 }}>
    <SettingsSection title="Billion Context"><SettingsCard>
      <SettingsRow label="总览与会话详情入口" hint="启用并整体重载 Zeonest 后，侧边栏显示总览入口。在当前会话的 Command Center 搜索「Billion Context」或「上下文详情」，直接打开会话详情。" />
      <SettingsRow label="独立托管服务" hint="每个 Paseo daemon 共用一个独立 Bili。首次随机分配端口，之后沿用；新打开的 Pi 自动关闭 inline 并附加固定地址。服务不可用时阻止 Pi 启动，不回退到其他实例。" />
    </SettingsCard></SettingsSection>
    <ServiceControls key={host.id} theme={theme} />
    {settings.status === "ready" ? <Editor key={host.id + ":" + epoch} settings={settings} theme={theme} saved={() => { setEpoch((value) => value + 1); setMessage("已保存。访问地址下次打开入口时生效；命令路径下次启动服务时生效。"); }} />
      : <SettingsCard><SettingsRow label={settings.status === "loading" ? "正在读取配置…" : settings.error} />
        {settings.status === "invalid" && <SettingsAction label="恢复启动器默认配置" actionLabel="重置" disabled={settings.saving} onPress={() => { void settings.reset(); }} />}</SettingsCard>}
    <SettingsCard><SettingsAction label="丢弃草稿并重新读取" actionLabel="重新读取" disabled={settings.saving}
      onPress={() => { void settings.reload().then(() => { setEpoch((value) => value + 1); setMessage(""); }); }} /></SettingsCard>
    {settings.saveError ? <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.statusDanger }}>保存失败，草稿已保留：{settings.saveError}</Text> : null}
    {message ? <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foregroundMuted }}>{message}</Text> : null}
    <Text style={{ color: theme.colors.foregroundMuted }}>已运行的 Pi 不会被自动中断或重开。首次切换到托管模式、或强制更换端口后，请在空闲时重新打开旧 Pi。会话仍按 provider session ID 精确查询，不跳转到最近会话。配置页在功能关闭时仍可使用。</Text>
  </View>;
}
export default { id: "billion-context-settings", title: "Billion Context", icon: "ChartPie", Component: DashboardSettings } satisfies PluginSettingsScreenContribution;
