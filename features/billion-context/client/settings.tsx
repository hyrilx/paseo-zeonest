import { useRef, useState } from "react";
import { Text, View } from "react-native";
import { useSettings, type PluginSettingsScreenContribution, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { preferences, preferencesSchema } from "../shared/settings";

type Ready = Extract<SettingsState<typeof preferencesSchema>, { status: "ready" }>;
function Editor({ settings, theme, saved }: { settings: Ready; theme: PluginSurfaceProps["theme"]; saved(): void }) {
  const [revision] = useState(settings.revision);
  const [serverOrigin, setServerOrigin] = useState(settings.values.serverOrigin);
  const [browserOrigin, setBrowserOrigin] = useState(settings.values.browserOrigin);
  const [error, setError] = useState("");
  const lock = useRef(false);
  async function save() {
    if (lock.current) return;
    const parsed = preferencesSchema.safeParse({ serverOrigin, browserOrigin: browserOrigin.trim() });
    if (!parsed.success) { setError(parsed.error.issues.map((issue) => issue.message).join("；")); return; }
    lock.current = true; setError("");
    try { if (await settings.save(parsed.data, revision)) saved(); }
    finally { lock.current = false; }
  }
  return <View style={{ gap: 16 }}>
    <SettingsCard>
      <SettingsInput label="宿主侧实例地址" initialValue={serverOrigin} onChangeText={setServerOrigin} disabled={settings.saving}
        hint="留空自动发现代理与 inline 实例；填写后固定使用该地址。仅填写 HTTP(S) 源地址，不含 /__bili/ 路径、账号或密钥。" />
      <SettingsInput label="客户端访问地址（可选）" initialValue={browserOrigin} onChangeText={setBrowserOrigin} disabled={settings.saving}
        hint="留空沿用宿主侧地址。可用 http://my-host:{port} 将 {port} 展开为所选实例端口；固定转发端口请直接填写数字。地址须指向同一实例，本功能不会自动转发端口。" />
      <SettingsAction label="保存 dashboard 配置" actionLabel={settings.saving ? "保存中…" : "保存"} disabled={settings.saving} onPress={() => { void save(); }} />
    </SettingsCard>
    {settings.revision !== revision && <Text style={{ color: theme.colors.statusWarning }}>配置已被其他客户端更新，当前草稿仍保留原 revision。请复制草稿后重新读取。</Text>}
    {error ? <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
  </View>;
}
export function DashboardSettings({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const [epoch, setEpoch] = useState(0);
  const [message, setMessage] = useState("");
  return <View style={{ gap: layout.compact ? 16 : 24, backgroundColor: theme.colors.surface0 }}>
    <SettingsSection title="Billion Context"><SettingsCard>
      <SettingsRow label="总览与会话详情入口" hint="启用并整体重载 Zeonest 后，侧边栏显示总览入口，聊天框底部显示「上下文详情」胶囊。SDK 0.15.4 不支持修改原有上下文圆环。" />
      <SettingsRow label="使用已运行的 billion-context dashboard" hint="默认自动读取宿主的实例运行记录与 bili.log 启动日志，验证地址后打开。多个实例需选择；日志关闭或位置自定义时可手动填写地址。不扫描端口、不读取会话文件、不启动服务。" />
    </SettingsCard></SettingsSection>
    {settings.status === "ready" ? <Editor key={epoch} settings={settings} theme={theme} saved={() => { setEpoch((value) => value + 1); setMessage("已保存，下次打开入口时生效。"); }} />
      : <SettingsCard><SettingsRow label={settings.status === "loading" ? "正在读取配置…" : settings.error} />
        {settings.status === "invalid" && <SettingsAction label="恢复自动发现默认配置" actionLabel="重置" disabled={settings.saving} onPress={() => { void settings.reset(); }} />}</SettingsCard>}
    <SettingsCard><SettingsAction label="丢弃草稿并重新读取" actionLabel="重新读取" disabled={settings.saving}
      onPress={() => { void settings.reload().then(() => { setEpoch((value) => value + 1); setMessage(""); }); }} /></SettingsCard>
    {settings.saveError ? <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.statusDanger }}>保存失败，草稿已保留：{settings.saveError}</Text> : null}
    {message ? <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foregroundMuted }}>{message}</Text> : null}
    <Text style={{ color: theme.colors.foregroundMuted }}>会话详情通过 provider session ID 查询 /__bili/plugin/status，不按标题、目录或最近活动猜测。仅将该 ID 发给手动指定或经 manifest 验证的本机候选实例；浏览器页面由 billion-context 自行提供。配置入口在功能关闭时仍可使用。</Text>
  </View>;
}
export default { id: "billion-context-settings", title: "Billion Context", icon: "ChartPie", Component: DashboardSettings } satisfies PluginSettingsScreenContribution;
