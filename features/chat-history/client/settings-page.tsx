import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { preferences, preferencesSchema, type Preferences } from "../shared/settings";

type ReadySettings = Extract<SettingsState<typeof preferencesSchema>, { status: "ready" }>;
interface EditorProps extends PluginSurfaceProps {
  settings: ReadySettings;
  disabled: boolean;
  save(values: Preferences, revision: string): void;
}

function PreferencesEditor({ settings, disabled, save, theme }: EditorProps) {
  // Keep the revision paired with the draft so a remote edit cannot be overwritten silently.
  const [revision] = useState(settings.revision);
  const [defaultExpanded, setDefaultExpanded] = useState(settings.values.defaultExpanded);
  const [previewLength, setPreviewLength] = useState(String(settings.values.previewLength));
  const [pageSize, setPageSize] = useState(String(settings.values.pageSize));
  const [error, setError] = useState("");
  function commit() {
    const integer = (value: string) => /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
    const parsed = preferencesSchema.safeParse({ defaultExpanded, previewLength: integer(previewLength), pageSize: integer(pageSize) });
    if (!parsed.success) {
      setError("预览长度需为 0–20000 的整数，每页条数需为 10–200 的整数。");
      return;
    }
    setError("");
    save(parsed.data, revision);
  }
  return <View style={{ gap: 16 }}>
    <SettingsSection title="历史显示">
      <SettingsCard>
        <SettingsSwitch label="默认展开历史" hint="未手动切换的折叠区跟随此设置；手动展开或收起后保留当前选择。" value={defaultExpanded} onValueChange={setDefaultExpanded} disabled={disabled} />
        <SettingsInput label="单条预览长度" hint="0–20000 字符，默认 1800；填 0 直接显示全文。助手消息的预览也使用 Markdown。" initialValue={previewLength} onChangeText={setPreviewLength} disabled={disabled} />
        <SettingsInput label="每次显示条数" hint="10–200 条，默认 40；包含 Meta、消息和操作。" initialValue={pageSize} onChangeText={setPageSize} disabled={disabled} />
      </SettingsCard>
    </SettingsSection>
    {settings.revision !== revision ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusWarning }}>配置已在其他客户端更新。草稿仍保留；请复制需要的修改后重新读取，避免保存冲突。</Text> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
    <SettingsCard><SettingsAction label="保存历史显示配置" actionLabel={disabled ? "处理中…" : "保存"} onPress={commit} disabled={disabled} /></SettingsCard>
  </View>;
}

export function ChatHistorySettings(props: PluginSurfaceProps) {
  const { theme, layout } = props;
  const settings = useSettings(preferences);
  const [busy, setBusy] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  async function work(action: () => Promise<boolean | void>) {
    if (lock.current || settings.saving) return;
    lock.current = true;
    setBusy(true); setError("");
    try {
      const result = await action();
      if (!mounted.current) return;
      if (result === false) setError("操作未成功，草稿已保留。请检查连接或配置版本冲突后重试。");
      else setEpoch((value) => value + 1);
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const disabled = busy || settings.saving;
  const hint = { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 20 };
  return <View style={{ gap: layout.compact ? 16 : 24, backgroundColor: theme.colors.surface0 }}>
    <Text style={{ color: theme.colors.foreground, fontSize: 22, fontWeight: "600" }}>历史对话展开</Text>
    <Text style={hint}>配置保存在当前宿主，保存后通过 Paseo 推送到显示历史的客户端，无需重载插件。功能开关仍需整体重载。</Text>
    {settings.status === "ready" ? <PreferencesEditor key={epoch} {...props} settings={settings} disabled={disabled}
      save={(values, revision) => { void work(() => settings.save(values, revision)); }} />
      : settings.status === "loading" ? <Text style={hint}>正在读取历史显示配置…</Text>
      : <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>配置读取失败：{settings.error}</Text>}
    <SettingsCard>
      <SettingsAction label="丢弃草稿并重新读取配置" actionLabel="重新读取" disabled={disabled}
        onPress={() => { void work(() => settings.reload()); }} />
      {settings.status === "ready" || settings.status === "invalid" ? <SettingsAction label="恢复默认历史显示配置" actionLabel="恢复默认" disabled={disabled}
        onPress={() => { void work(() => settings.reset()); }} /> : null}
    </SettingsCard>
    {settings.saveError ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>保存未成功：{settings.saveError}</Text> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
  </View>;
}
