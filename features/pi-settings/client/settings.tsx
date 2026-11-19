import { useEffect, useRef, useState } from "react";
import type { PluginSettingsScreenContribution, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { commitChanges, discardChanges, prepareChanges, readPreferences, type ConfigDocument, type Preview } from "../shared/contracts";
import { parseObject, setProperty } from "../shared/config";
import { Button, CodeInput, DiffModal } from "./components";
import { Caption, Field, Heading, row } from "./layout";

export function PiPluginPreferences(props: PluginSurfaceProps) { return <Preferences key={props.host.id} {...props} />; }
function Preferences({ theme }: PluginSurfaceProps) {
  const read = useRpc(readPreferences); const prepare = useRpc(prepareChanges); const commit = useRpc(commitChanges); const discard = useRpc(discardChanges);
  const [doc, setDoc] = useState<ConfigDocument>(); const [defaultDir, setDefaultDir] = useState(""); const [text, setText] = useState("");
  const [busy, setBusy] = useState(false); const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState(""); const [raw, setRaw] = useState(false);
  const alive = useRef(false); const pending = useRef<string | null>(null); const running = useRef(false);
  const message = (e: unknown) => e instanceof Error ? e.message : "操作失败，请重试。";
  async function load() {
    try { const result = await read({}); if (alive.current) { setDoc(result.document); setText(result.document.text); setDefaultDir(result.defaultAgentDir); setRaw(!!result.document.error); } }
    catch (e) { if (alive.current) setError(message(e)); }
  }
  useEffect(() => {
    alive.current = true; void load();
    return () => { alive.current = false; if (pending.current) void discard({ token: pending.current }).catch(() => {}); };
  }, [read, discard]);
  let data;
  try { data = parseObject(text); } catch { data = {}; }
  const locked = !doc || doc.revision === "unreadable" || busy || !!preview;
  function field(key: string, value: unknown) { setText((current) => setProperty(current, [key], value)); setNotice(""); }
  async function apply(plan: Preview, confirmed: boolean) {
    const result = await commit({ token: plan.token, confirmed });
    pending.current = null;
    if (alive.current) { setPreview(null); setNotice(result.message); await load(); }
  }
  async function run(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(true); setError(null);
    try { await action(); } catch (e) { if (alive.current) setError(message(e)); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  }
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 10 }}>
    <Heading title="Pi 设置插件" theme={theme} detail="只影响 Zeonest 如何读取和修改 Pi 配置。" />
    {doc && <>
      {doc.error && <Caption theme={theme}>{doc.error}</Caption>}
      {raw ? <CodeInput label="插件偏好 JSON" theme={theme} text={text} onChangeText={setText} readOnly={locked} /> : <>
        <Field label="Pi agent 目录" theme={theme} value={typeof data.agentDir === "string" ? data.agentDir : ""} placeholder={defaultDir} disabled={locked} onChangeText={(value) => field("agentDir", value)} />
        <Field label="Pi 可执行文件" theme={theme} value={typeof data.piExecutable === "string" ? data.piExecutable : "pi"} disabled={locked} onChangeText={(value) => field("piExecutable", value)} />
        <SettingsSwitch label="写入前审阅 diff" hint="关闭后，预检通过的改动直接应用；版本冲突仍会阻止写入。" value={data.confirmDiff !== false} disabled={locked} onValueChange={(value) => field("confirmDiff", value)} />
      </>}
      <View style={row}>
        {!doc.error && <Button label={raw ? "使用表单" : "编辑原始偏好"} theme={theme} disabled={locked} onPress={() => {
          if (raw) { try { parseObject(text); } catch (e) { setError(message(e)); return; } } setRaw(!raw);
        }} />}
        <Button label="保存偏好" theme={theme} disabled={locked || text === doc.text} primary onPress={() => { void run(async () => {
          const plan = await prepare({ edits: [{ kind: "preferences", revision: doc.revision, text }] });
          if (!alive.current) { await discard({ token: plan.token }); return; }
          pending.current = plan.token; setPreview(plan);
          if (plan.changes.length === 0) { await discard({ token: plan.token }); pending.current = null; setPreview(null); setNotice("没有需要写入的改动。"); }
          else if (!plan.confirmationRequired) await apply(plan, false);
        }); }} />
      </View>
    </>}
    {error && <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{error}</Text>}
    {!doc && !error && <Caption theme={theme}>正在读取插件偏好…</Caption>}
    {notice && <Caption theme={theme}>{notice}</Caption>}
    <DiffModal preview={preview} theme={theme} busy={busy} error={error} onCancel={() => { if (preview) void run(async () => { await discard({ token: preview.token }); pending.current = null; setPreview(null); }); }} onCommit={() => { if (preview) void run(() => apply(preview, true)); }} />
  </ScrollView>;
}
export default { id: "pi-settings-settings", title: "Pi 设置插件", icon: "Settings2", Component: PiPluginPreferences } satisfies PluginSettingsScreenContribution;
