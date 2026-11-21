import { useRef, useState } from "react";
import { Text, View } from "react-native";
import { useSettings, type PluginSettingsScreenContribution, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { preferences, type Preferences } from "../shared/settings";

const viewOptions = [
  { label: "编辑", value: "edit" },
  { label: "预览", value: "preview" },
] as const;
const sizeOptions = [
  { label: "小", value: "small" },
  { label: "标准", value: "standard" },
  { label: "大", value: "large" },
] as const;

function samePreferences(left: Preferences, right: Preferences) {
  return left.defaultView === right.defaultView && left.editorSize === right.editorSize && left.showToolbar === right.showToolbar;
}

function NotesSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const [draft, setDraft] = useState<{ values: Preferences; revision: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const disabled = busy || settings.saving;
  const values = draft?.values ?? (settings.status === "ready" ? settings.values : null);
  const stale = settings.status === "ready" && draft !== null && draft.revision !== settings.revision;
  const saveFailed = settings.saveError !== null && !stale && (draft !== null || settings.status === "invalid");

  function update(patch: Partial<Preferences>) {
    if (settings.status !== "ready" || disabled || stale) return;
    setDraft((current) => {
      const next = { ...(current?.values ?? settings.values), ...patch };
      return samePreferences(next, settings.values) ? null : { values: next, revision: current?.revision ?? settings.revision };
    });
  }

  async function run(action: () => Promise<unknown>) {
    if (lock.current || settings.saving) return;
    lock.current = true;
    setBusy(true);
    try { await action(); }
    finally { lock.current = false; setBusy(false); }
  }

  return <View style={{ gap: 12, backgroundColor: theme.colors.surface0 }}>
    {settings.status === "ready" && values ? <>
      <SettingsCard>
        <SettingsSelect label="打开时的视图" value={values.defaultView} options={viewOptions}
          disabled={disabled || stale} onValueChange={(defaultView) => update({ defaultView })} />
        <SettingsSelect label="编辑字号" value={values.editorSize} options={sizeOptions}
          disabled={disabled || stale} onValueChange={(editorSize) => update({ editorSize })} />
        <SettingsSwitch label="显示 Markdown 工具栏" value={values.showToolbar}
          disabled={disabled || stale} onValueChange={(showToolbar) => update({ showToolbar })} />
      </SettingsCard>
      <SettingsCard>
        <SettingsAction label="笔记偏好" hint="保存后，下次打开笔记时生效。" actionLabel={disabled ? "处理中…" : "保存"}
          disabled={disabled || stale || !draft} onPress={() => {
            if (!draft || stale) return;
            void run(async () => { if (await settings.save(draft.values, draft.revision)) setDraft(null); });
          }} />
        {draft && <SettingsAction label="放弃本次修改" actionLabel="放弃" disabled={disabled}
          onPress={() => { setDraft(null); }} />}
      </SettingsCard>
    </> : <SettingsCard>
      <SettingsRow label={settings.status === "loading" ? "正在读取配置…" : "无法读取笔记配置"} />
      {settings.status === "invalid" && <SettingsAction label="配置格式无效" actionLabel="恢复默认"
        disabled={disabled} onPress={() => { void run(async () => { if (await settings.reset()) setDraft(null); }); }} />}
    </SettingsCard>}
    {stale ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusWarning }}>
      其他客户端已更新配置。放弃本次修改后可重新设置。
    </Text> : null}
    {saveFailed ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
      保存失败。可以重试，或重新读取宿主配置。
    </Text> : null}
    {(settings.status === "error" || settings.status === "invalid" || saveFailed) &&
      <SettingsCard><SettingsAction label="宿主配置" actionLabel="重新读取"
        disabled={disabled} onPress={() => { void run(settings.reload); }} /></SettingsCard>}
  </View>;
}

export default {
  id: "conversation-notes-settings", title: "会话笔记", icon: "FileText", Component: NotesSettings,
} satisfies PluginSettingsScreenContribution;
