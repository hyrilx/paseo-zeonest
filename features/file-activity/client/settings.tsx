import { useRef, useState } from "react";
import { Text, View } from "react-native";
import { useSettings, type PluginSettingsScreenContribution, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { preferences, preferencesSchema } from "../shared/settings";

type Ready = Extract<SettingsState<typeof preferencesSchema>, { status: "ready" }>;
function Editor({ settings, theme, saved }: { settings: Ready; theme: PluginSurfaceProps["theme"]; saved(): void }) {
  const [revision] = useState(settings.revision);
  const [draft, setDraft] = useState(settings.values);
  const lock = useRef(false);
  const [saving, setSaving] = useState(false);
  const disabled = saving || settings.saving;
  async function save() {
    if (lock.current) return;
    lock.current = true; setSaving(true);
    try { if (await settings.save(draft, revision)) saved(); }
    finally { lock.current = false; setSaving(false); }
  }
  return <View style={{ gap: 12 }}>
    <SettingsSection title="默认显示"><SettingsCard>
      <SettingsSelect label="查看范围" value={draft.defaultMode} disabled={disabled}
        options={[{ label: "跟随最新轮", value: "latest" }, { label: "手动选轮", value: "manual" }, { label: "全会话", value: "all" }]}
        onValueChange={(defaultMode) => setDraft({ ...draft, defaultMode })} />
      <SettingsSelect label="排序" value={draft.defaultSort} disabled={disabled}
        options={[{ label: "时间", value: "time" }, { label: "类别", value: "kind" }, { label: "路径", value: "path" }]}
        onValueChange={(defaultSort) => setDraft({ ...draft, defaultSort })} />
      <SettingsSwitch label="降序" value={draft.descending} disabled={disabled} onValueChange={(descending) => setDraft({ ...draft, descending })} />
      <SettingsSwitch label="显示进行中、失败及取消的请求" value={draft.includeUnsuccessful} disabled={disabled}
        onValueChange={(includeUnsuccessful) => setDraft({ ...draft, includeUnsuccessful })} />
    </SettingsCard></SettingsSection>
    <SettingsSection title="历史与正文"><SettingsCard>
      <SettingsSelect label="历史记录上限" hint="包含用户消息及其他时间线条目；超过上限时展示最近记录并标记为部分历史。" value={String(draft.maxEntries)} disabled={disabled}
        options={[{ label: "1000 条", value: "1000" }, { label: "5000 条", value: "5000" }, { label: "20000 条", value: "20000" }]}
        onValueChange={(value) => { const parsed = preferencesSchema.shape.maxEntries.safeParse(Number(value)); if (parsed.success) setDraft({ ...draft, maxEntries: parsed.data }); }} />
      <SettingsSelect label="每次展开的正文行数" hint="长文件可以继续逐批展开，不会在此处截掉历史正文。" value={String(draft.previewLines)} disabled={disabled}
        options={[{ label: "100 行", value: "100" }, { label: "300 行", value: "300" }, { label: "1000 行", value: "1000" }]}
        onValueChange={(value) => { const parsed = preferencesSchema.shape.previewLines.safeParse(Number(value)); if (parsed.success) setDraft({ ...draft, previewLines: parsed.data }); }} />
    </SettingsCard></SettingsSection>
    {settings.revision !== revision ? <Text style={{ color: theme.colors.statusWarning }}>配置已被其他客户端更新，草稿已保留。请重新读取后再修改。</Text> : null}
    <SettingsCard>
      <SettingsAction label="恢复默认值（保存后生效）" actionLabel="使用默认值" disabled={disabled} onPress={() => setDraft(preferencesSchema.parse({}))} />
      <SettingsAction label="保存文件活动配置" actionLabel={disabled ? "保存中…" : "保存"} disabled={disabled} onPress={() => { void save(); }} />
    </SettingsCard>
  </View>;
}
export function FileActivitySettings({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const [epoch, setEpoch] = useState(0);
  const [message, setMessage] = useState("");
  return <View style={{ gap: layout.compact ? 12 : 20, backgroundColor: theme.colors.surface0 }}>
    <SettingsSection title="文件活动"><SettingsCard>
      <SettingsRow label="在工作区侧边栏的「+」中打开「文件活动」并选择会话" hint="当前会话的 Command Center 也可执行「查看当前会话文件活动」。新面板使用这里的默认显示；已有面板按会话保留模式、筛选及排序。历史上限与正文行数在面板重新打开后生效。功能默认关闭，启用后需整体重载 Zeonest。" />
    </SettingsCard></SettingsSection>
    {settings.status === "ready" ? <Editor key={epoch} settings={settings} theme={theme} saved={() => { setEpoch((value) => value + 1); setMessage("已保存。重新打开面板可应用配置。"); }} />
      : <SettingsCard><SettingsRow label={settings.status === "loading" ? "正在读取配置…" : settings.error} />
        {settings.status === "invalid" ? <SettingsAction label="恢复默认配置" actionLabel="重置配置" disabled={settings.saving} onPress={() => { void settings.reset().then((ok) => { if (ok) setEpoch((value) => value + 1); }); }} /> : null}</SettingsCard>}
    <SettingsCard><SettingsAction label="丢弃草稿并重新读取" actionLabel="重新读取" disabled={settings.saving}
      onPress={() => { void settings.reload().then(() => { setEpoch((value) => value + 1); setMessage(""); }); }} /></SettingsCard>
    {settings.saveError ? <Text style={{ color: theme.colors.statusDanger }}>保存失败，草稿已保留：{settings.saveError}</Text> : null}
    {message ? <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foregroundMuted }}>{message}</Text> : null}
    <SettingsSection title="记录范围"><SettingsCard>
      <SettingsRow label="只分析所选会话的原生工具记录" hint="不读取磁盘、不保存聊天正文、不监控其他进程。任意 shell 命令和未识别的工具不会被推测为文件活动。写入未标明新增或覆盖时归入修改，详情注明不确定性。" />
      <SettingsRow label="跟随最新轮与滚动跟随不同" hint="当前 SDK 0.15.4 未向插件导出桌面时间线的阅读位置与消息定位接口。本版支持手动选轮、最新轮和全会话查看，未提供随对话滚动联动或反向定位消息。" />
    </SettingsCard></SettingsSection>
  </View>;
}
export default { id: "file-activity-settings", title: "文件活动", icon: "Files", Component: FileActivitySettings } satisfies PluginSettingsScreenContribution;
