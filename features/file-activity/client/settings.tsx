import { useRef, useState } from "react";
import { Text, View } from "react-native";
import { useSettings, type PluginSettingsScreenContribution, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { preferences, preferencesSchema } from "../shared/settings";

type Ready = Extract<SettingsState<typeof preferencesSchema>, { status: "ready" }>;
function Editor({ settings, theme, compact, saved }: { settings: Ready; theme: PluginSurfaceProps["theme"]; compact: boolean; saved(): void }) {
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
    <View style={{ flexDirection: compact ? "column" : "row", gap: 12, alignItems: "stretch" }}>
    <View style={{ flex: 1 }}><SettingsSection title="默认显示"><SettingsCard>
      <SettingsSelect label="查看范围" value={draft.defaultMode} disabled={disabled}
        options={[{ label: "跟随最新轮", value: "latest" }, { label: "手动选轮", value: "manual" }, { label: "全会话", value: "all" }]}
        onValueChange={(defaultMode) => setDraft({ ...draft, defaultMode })} />
      <SettingsSelect label="排序" value={draft.defaultSort} disabled={disabled}
        options={[{ label: "时间", value: "time" }, { label: "类别", value: "kind" }, { label: "路径", value: "path" }]}
        onValueChange={(defaultSort) => setDraft({ ...draft, defaultSort })} />
      <SettingsSwitch label="降序" value={draft.descending} disabled={disabled} onValueChange={(descending) => setDraft({ ...draft, descending })} />
      <SettingsSwitch label="包含未完成请求" value={draft.includeUnsuccessful} disabled={disabled}
        onValueChange={(includeUnsuccessful) => setDraft({ ...draft, includeUnsuccessful })} />
    </SettingsCard></SettingsSection></View>
    <View style={{ flex: 1 }}><SettingsSection title="历史与正文"><SettingsCard>
      <SettingsSelect label="历史记录上限" hint="计入所有时间线条目，超出时保留最近记录。" value={String(draft.maxEntries)} disabled={disabled}
        options={[{ label: "1000 条", value: "1000" }, { label: "5000 条", value: "5000" }, { label: "20000 条", value: "20000" }]}
        onValueChange={(value) => { const parsed = preferencesSchema.shape.maxEntries.safeParse(Number(value)); if (parsed.success) setDraft({ ...draft, maxEntries: parsed.data }); }} />
      <SettingsSelect label="每次展开的正文行数" hint="长正文可继续分批展开。" value={String(draft.previewLines)} disabled={disabled}
        options={[{ label: "100 行", value: "100" }, { label: "300 行", value: "300" }, { label: "1000 行", value: "1000" }]}
        onValueChange={(value) => { const parsed = preferencesSchema.shape.previewLines.safeParse(Number(value)); if (parsed.success) setDraft({ ...draft, previewLines: parsed.data }); }} />
    </SettingsCard></SettingsSection></View>
    </View>
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
  const [showDetails, setShowDetails] = useState(false);
  return <View style={{ gap: 12, backgroundColor: theme.colors.surface0 }}>
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>新面板使用以下默认值，已有面板保留各会话的显示设置。历史与正文限制在重新打开后生效。</Text>
    {settings.status === "ready" ? <Editor key={epoch} settings={settings} theme={theme} compact={layout.compact} saved={() => { setEpoch((value) => value + 1); setMessage("已保存。重新打开面板可应用配置。"); }} />
      : <SettingsCard><SettingsRow label={settings.status === "loading" ? "正在读取配置…" : settings.error} />
        {settings.status === "invalid" ? <SettingsAction label="恢复默认配置" actionLabel="重置配置" disabled={settings.saving} onPress={() => { void settings.reset().then((ok) => { if (ok) setEpoch((value) => value + 1); }); }} /> : null}</SettingsCard>}
    <SettingsCard><SettingsAction label="丢弃草稿并重新读取" actionLabel="重新读取" disabled={settings.saving}
      onPress={() => { void settings.reload().then(() => { setEpoch((value) => value + 1); setMessage(""); }); }} /></SettingsCard>
    {settings.saveError ? <Text style={{ color: theme.colors.statusDanger }}>保存失败，草稿已保留：{settings.saveError}</Text> : null}
    {message ? <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foregroundMuted }}>{message}</Text> : null}
    <SettingsCard><SettingsAction label="打开方式与记录范围" actionLabel={showDetails ? "收起" : "查看"} onPress={() => setShowDetails((value) => !value)} />
      {showDetails ? <>
        <SettingsRow label="工作区侧边栏「+」→ 文件活动" hint="当前会话的 Command Center 可执行「查看当前会话文件活动」。功能默认关闭，启用后需整体重载 Zeonest。" />
        <SettingsRow label="仅分析所选会话的工具记录" hint="不读取磁盘、不保存聊天正文。未识别的 shell 命令不计入；写入未区分新增或覆盖时按修改记录。未完成包括进行中、失败和取消的请求。" />
        <SettingsRow label="最新轮跟随新消息" hint="SDK 0.15.4 未提供随对话滚动联动或反向定位消息的接口。" />
      </> : null}
    </SettingsCard>
  </View>;
}
export default { id: "file-activity-settings", title: "文件活动", icon: "Files", Component: FileActivitySettings } satisfies PluginSettingsScreenContribution;
