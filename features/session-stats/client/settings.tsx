import { useRef, useState } from "react";
import { Text, View } from "react-native";
import { useSettings, type PluginSettingsScreenContribution, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { metricOptions, preferences, preferencesSchema } from "../shared/settings";

type Ready = Extract<SettingsState<typeof preferencesSchema>, { status: "ready" }>;
function Editor({ settings, theme, saved }: { settings: Ready; theme: PluginSurfaceProps["theme"]; saved(): void }) {
  const [revision] = useState(settings.revision);
  const [draft, setDraft] = useState(settings.values);
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const disabled = saving || settings.saving;
  async function save() {
    if (lock.current) return;
    lock.current = true; setSaving(true);
    try { if (await settings.save(draft, revision)) saved(); }
    finally { lock.current = false; setSaving(false); }
  }
  return <View style={{ gap: 16 }}>
    <SettingsSection title="弹窗显示"><SettingsCard>
      <SettingsSwitch label="轮数与步数" value={draft.showCounts} disabled={disabled} onValueChange={(showCounts) => setDraft((value) => ({ ...value, showCounts }))} />
      {metricOptions.map(({ id, label }) => <SettingsSwitch key={id} label={label} value={draft.visibleMetrics.includes(id)} disabled={disabled}
        onValueChange={(visible) => setDraft((value) => ({ ...value, visibleMetrics: metricOptions.filter((metric) => metric.id === id ? visible : value.visibleMetrics.includes(metric.id)).map((metric) => metric.id) }))} />)}
      <SettingsSelect label="没有样本的指标" value={draft.missingValues} options={[{ label: "隐藏", value: "hide" }, { label: "显示「未采集」", value: "label" }]}
        disabled={disabled} onValueChange={(missingValues) => setDraft((value) => ({ ...value, missingValues }))} />
    </SettingsCard></SettingsSection>
    <SettingsSection title="即时速度"><SettingsCard>
      <SettingsSelect label="采样窗口" hint="短窗口响应更快，长窗口更平稳；只影响胶囊，不改变输出平均速度。" value={String(draft.instantWindowSeconds)}
        options={[{ label: "1 秒", value: "1" }, { label: "3 秒", value: "3" }, { label: "5 秒", value: "5" }]} disabled={disabled}
        onValueChange={(seconds) => { const parsed = preferencesSchema.shape.instantWindowSeconds.safeParse(Number(seconds)); if (parsed.success) setDraft((value) => ({ ...value, instantWindowSeconds: parsed.data })); }} />
      <SettingsRow label="空闲时保留统计入口" hint="没有即时速度样本、执行工具或轮次结束时，胶囊显示「会话统计」。已知的零值正常显示。" />
    </SettingsCard></SettingsSection>
    {settings.revision !== revision ? <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.statusWarning }}>配置已被其他客户端更新。当前草稿已保留；请重新读取后再修改。</Text> : null}
    <SettingsCard>
      <SettingsAction label="恢复默认显示与采样窗口（保存后生效）" actionLabel="使用默认值" disabled={disabled} onPress={() => setDraft(preferencesSchema.parse({}))} />
      <SettingsAction label="保存会话统计配置" actionLabel={disabled ? "保存中…" : "保存"} disabled={disabled} onPress={() => { void save(); }} />
    </SettingsCard>
  </View>;
}

export function SessionStatsSettings({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const [epoch, setEpoch] = useState(0);
  const [message, setMessage] = useState("");
  return <View style={{ gap: layout.compact ? 16 : 24, backgroundColor: theme.colors.surface0 }}>
    <SettingsSection title="会话统计"><SettingsCard>
      <SettingsRow label="显示设置保存后约 2 秒内生效" hint="配置保存在当前宿主，所有已连接客户端共用。功能关闭时也可配置；功能开关仍需整体重载 Zeonest。" />
    </SettingsCard></SettingsSection>
    {settings.status === "ready" ? <Editor key={epoch} settings={settings} theme={theme} saved={() => { setEpoch((value) => value + 1); setMessage("已保存，约 2 秒内生效。"); }} />
      : <SettingsCard><SettingsRow label={settings.status === "loading" ? "正在读取配置…" : settings.error} />
        {settings.status === "invalid" ? <SettingsAction label="恢复默认显示与采样窗口" actionLabel="重置配置" disabled={settings.saving}
          onPress={() => { void settings.reset().then((saved) => { if (saved) { setEpoch((value) => value + 1); setMessage("已恢复默认配置。"); } }); }} /> : null}</SettingsCard>}
    <SettingsCard><SettingsAction label="丢弃草稿并重新读取" actionLabel="重新读取" disabled={settings.saving}
      onPress={() => { void settings.reload().then(() => { setEpoch((value) => value + 1); setMessage(""); }); }} /></SettingsCard>
    {settings.saveError ? <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.statusDanger }}>保存失败，草稿已保留：{settings.saveError}</Text> : null}
    {message ? <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foregroundMuted }}>{message}</Text> : null}
    <SettingsSection title="统计口径"><SettingsCard>
      <SettingsRow label="轮数、步数与工具次数" hint="轮数按用户消息去重；步数按工具批次前后的连续模型输出段计，纯工具请求也计一步，并非供应商 API 请求数。工具次数按 callId 去重，包含失败与取消。计数回填宿主可访问的完整历史；缺页或事件缺序号时标注「部分」。" />
      <SettingsRow label="模型与工具的总用时" hint="模型用时为观测轮次中扣除工具执行和权限等待的墙钟时间。工具用时逐调用累加；并行工具分别计时，合计可以超过会话墙钟时间。轮次结束时结算尚未结束的调用。" />
      <SettingsRow label="首 token 平均用时" hint="从轮次开始或工具、权限等待结束，到首个文本或推理片段的时间，按可测模型段取算术平均。" />
      <SettingsRow label="输出平均速度" hint="可测输出段的总估算 token ÷ 总解码时长，按时间加权。解码时间为首块至末块；包含首块 token，只有一个文本块的段不计入速度样本。即时窗口不影响此平均值。" />
    </SettingsCard></SettingsSection>
    <SettingsSection title="数据范围"><SettingsCard>
      <SettingsRow label="≈ 表示客户端观测或估算" hint="Paseo SDK 0.15.4 未提供逐模型请求的精确耗时与逐块 token。中日韩字符约 1 token，其余约 4 字符/token；文本与推理计入，工具参数不计入。数值包含传输和调度影响。" />
      <SettingsRow label="性能样本从本次连接开始" hint="只统计观察到起点的模型段与工具调用，不从历史时间戳恢复用时。重连、历史替换或插件重载会重新观测；缺少样本不会显示为零。" />
      <SettingsRow label="统计不持久化" hint="不保存聊天文本或统计结果，不注入 Pi 扩展，不读取供应商会话文件或凭据，不连接第三方服务。仅显示配置由 Paseo 原生设置持久化；配置读取失败时保留上次有效值，首次失败暂用默认值。" />
    </SettingsCard></SettingsSection>
  </View>;
}

export default { id: "session-stats-settings", title: "会话统计", icon: "Gauge", Component: SessionStatsSettings } satisfies PluginSettingsScreenContribution;
