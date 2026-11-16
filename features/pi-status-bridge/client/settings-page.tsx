import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { preferences, preferencesSchema, type Preferences } from "../shared/settings";
import { errorMessage } from "../shared/text";

type ReadySettings = Extract<SettingsState<typeof preferencesSchema>, { status: "ready" }>;
interface EditorProps extends PluginSurfaceProps { settings: ReadySettings; saved(): void }
function PreferencesEditor({ settings, saved, theme }: EditorProps) {
  // Draft and revision are captured together. Remote updates must not overwrite unsaved input.
  const [baseRevision] = useState(settings.revision);
  const [hiddenKeys, setHiddenKeys] = useState(settings.values.hiddenKeys.join(", "));
  const [pinnedKeys, setPinnedKeys] = useState(settings.values.pinnedKeys.join(", "));
  const nextId = useRef(settings.values.actions.length);
  const [actions, setActions] = useState(() => settings.values.actions.map((action, index) => ({ ...action, id: index })));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  async function save() {
    if (lock.current) return;
    setError("");
    const parsed = preferencesSchema.safeParse({ hiddenKeys: hiddenKeys.split(/[,，\n]/).map((key) => key.trim()).filter(Boolean),
      pinnedKeys: pinnedKeys.split(/[,，\n]/).map((key) => key.trim()).filter(Boolean),
      actions: actions.map(({ key, command }) => ({ key: key.trim(), command: command.trim() })) });
    if (!parsed.success) { setError(parsed.error.issues.map((issue) => issue.message).join("；")); return; }
    lock.current = true; setSaving(true);
    try { if (await settings.save(parsed.data, baseRevision)) saved(); }
    finally { lock.current = false; setSaving(false); }
  }
  const disabled = saving || settings.saving;
  function update(id: number, patch: Partial<Preferences["actions"][number]>) { setActions((values) => values.map((value) => value.id === id ? { ...value, ...patch } : value)); }
  return <View style={{ gap: 16 }}>
    <SettingsSection title="显示">
      <SettingsCard>
        <SettingsInput label="隐藏的状态 key" hint="用逗号分隔，精确匹配；不影响 Pi 本身。可在 Pi 状态弹层的条目标题查看 key。" initialValue={hiddenKeys} onChangeText={setHiddenKeys} disabled={disabled} />
        <SettingsInput label="单独常驻的状态 key" hint="用逗号分隔；这些状态单独显示正文胶囊，其余收进 Pi 状态汇总。对本宿主所有 Pi 会话生效，同时隐藏时以隐藏为准。" initialValue={pinnedKeys} onChangeText={setPinnedKeys} disabled={disabled} />
      </SettingsCard>
    </SettingsSection>
    <SettingsSection title="Pi 展开命令">
      <SettingsCard><SettingsRow label="只映射可信插件提供的 /命令" hint="例如状态 key my-status 对应 /my-status details。参数固定，不从状态文本插值，也不通过 shell 执行。不要映射提示词模板或技能；命令本身可能修改会话或调用模型。Pi 的终端自定义组件无法桥接。" /></SettingsCard>
      {actions.map((action) => <SettingsCard key={action.id}>
        <SettingsInput label={`状态 key ${action.id + 1}`} initialValue={action.key} disabled={disabled} onChangeText={(key) => update(action.id, { key })} />
        <SettingsInput label={`展开命令 ${action.id + 1}`} placeholder="/my-status details" initialValue={action.command} disabled={disabled} onChangeText={(command) => update(action.id, { command })} />
        <SettingsAction label={`删除映射 ${action.id + 1}`} actionLabel="删除" disabled={disabled} onPress={() => setActions((values) => values.filter((value) => value.id !== action.id))} />
      </SettingsCard>)}
      <SettingsCard><SettingsAction label="新增展开映射" actionLabel="添加" disabled={disabled || actions.length >= 128}
        onPress={() => setActions((values) => [...values, { id: nextId.current++, key: "", command: "" }])} /></SettingsCard>
    </SettingsSection>
    {settings.revision !== baseRevision && <Text style={{ color: theme.colors.statusWarning }}>宿主配置已更新。当前草稿仍使用原 revision，保存可能冲突；请复制草稿后重新读取，不会自动覆盖。</Text>}
    {error ? <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
    <SettingsCard><SettingsAction label="保存状态桥接配置" actionLabel={disabled ? "保存中…" : "保存"} disabled={disabled} onPress={() => { void save(); }} /></SettingsCard>
  </View>;
}

export function StatusBridgeSettings(props: PluginSurfaceProps) {
  const { theme, layout } = props;
  const settings = useSettings(preferences);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  async function work(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); setMessage("");
    try { await action(); } catch (failure) { if (mounted.current) setError(errorMessage(failure)); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  const hint = { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 20 };
  return <View style={{ gap: layout.compact ? 16 : 24, backgroundColor: theme.colors.surface0 }}>
    <Text style={{ color: theme.colors.foreground, fontSize: 22, fontWeight: "600" }}>Pi 状态桥接</Text>
    <Text style={hint}>每个 Pi 会话默认只显示一个「Pi 状态」胶囊，入口显示数量和桥接异常。点击后逐项查看全文、复制或执行已配置的展开命令。需要随时查看的 key 可设为单独常驻。设置保存后约 1 秒内生效；功能开关仍需整体重载 Zeonest。</Text>
    <SettingsSection title="自动接入">
      <SettingsCard>
        <SettingsRow label="会话 hook 注入预加载观察器"
          hint="开启功能并整体重载 Zeonest 后，在新打开的交互式 Pi 会话中自动接入。无需包装器、额外 Pi 扩展或修改 provider 启动命令。宿主使用 Node.js 22+；原有 NODE_OPTIONS 会保留。" />
        <SettingsRow label="已有会话需空闲后手动重新打开"
          hint="运行中的进程不会补注入。每次重载插件后，请在 agent 空闲时手动重新打开会话，或新建 Pi agent。不会自动中断轮次，也不会从历史恢复状态。" />
        <SettingsRow label="汇总入口不拼接状态正文" hint="条目按首次出现的顺序原位更新，保留换行。弹层沿用 Paseo 原生背景和滚动；单独常驻胶囊的可见宽度由 Paseo 布局决定。" />
      </SettingsCard>
    </SettingsSection>
    {settings.status === "ready" ? <PreferencesEditor key={epoch} {...props} settings={settings} saved={() => { setEpoch((value) => value + 1); setMessage("配置已保存，将在下一次状态轮询时生效。"); }} />
      : settings.status === "loading" ? <Text style={hint}>正在读取显示与命令设置…</Text>
      : <SettingsCard><SettingsAction label={settings.error} actionLabel="重新读取" disabled={busy} onPress={() => { void settings.reload(); }} />
          {settings.status === "invalid" && <SettingsAction label="显式恢复默认显示与空命令映射" actionLabel="重置配置" disabled={settings.saving} onPress={() => { void settings.reset(); }} />}</SettingsCard>}
    <SettingsCard><SettingsAction label="丢弃草稿并重新读取配置" actionLabel="重新读取" disabled={busy || settings.saving}
      onPress={() => { void work(async () => { await settings.reload(); if (mounted.current) setEpoch((value) => value + 1); }); }} /></SettingsCard>
    {settings.saveError ? <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.statusDanger }}>保存未成功：{settings.saveError}。草稿已保留，请检查 revision 冲突或连接错误。</Text> : null}
    {error ? <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
    {message ? <Text accessibilityLiveRegion="polite" style={hint}>{message}</Text> : null}
    <Text style={hint}>状态仅保存在插件进程内存，经本机带会话令牌的回环 HTTP 通道转发，再由 Paseo RPC 交给已授权客户端；不写入聊天历史，不向外部服务发送。最多 128 项、单项 65,536 字符，超限会明确告警；全文不静默截断。观察器仅从本功能 bundle 自动写入宿主私有目录，不安装依赖，不修改 daemon 配置。</Text>
  </View>;
}
