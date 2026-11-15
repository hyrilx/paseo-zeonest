import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Modal, SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch, TextInput } from "@getpaseo/plugin/client/ui";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { Preview } from "../shared/contracts";
import { isObject, parseObject, type JsonObject } from "../shared/config";

type Theme = PluginSurfaceProps["theme"];
function Field({ label, hint, value, onChangeText, disabled, secureTextEntry, theme }: { label: string; hint?: string; value: string; onChangeText(value: string): void; disabled?: boolean; secureTextEntry?: boolean; theme: Theme }) {
  return <SettingsRow label={label} hint={hint}><TextInput accessibilityLabel={label} value={value} onChangeText={onChangeText} editable={!disabled} secureTextEntry={secureTextEntry} autoCapitalize="none" autoCorrect={false}
    style={{ color: theme.colors.foreground, backgroundColor: theme.colors.surface1, padding: 10, borderRadius: 5, minWidth: 140, flexShrink: 1 }} /></SettingsRow>;
}
export function Button({ label, onPress, disabled, theme, active = false }: { label: string; onPress(): void; disabled?: boolean; theme: Theme; active?: boolean }) {
  const c = theme.colors;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, selected: active }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => ({ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 7, borderWidth: 1, borderColor: active ? c.accent : c.border,
      backgroundColor: active || pressed ? c.surface2 : c.surface1, opacity: disabled ? 0.5 : 1 })}>
    <Text style={{ color: active ? c.accent : c.foreground, fontSize: 13, fontWeight: "500" }}>{label}</Text>
  </Pressable>;
}
export function CodeInput({ text, onChangeText, theme, readOnly = false, label = "JSON / 文本配置" }: { text: string; onChangeText(text: string): void; theme: Theme; readOnly?: boolean; label?: string }) {
  return <TextInput accessibilityLabel={label} multiline value={text} onChangeText={onChangeText} editable={!readOnly} autoCapitalize="none" autoCorrect={false} spellCheck={false}
    textAlignVertical="top" style={{ color: theme.colors.foreground, backgroundColor: theme.colors.surface1, borderWidth: 1, borderColor: theme.colors.border,
      borderRadius: 7, padding: 12, fontFamily: "monospace", fontSize: 13, lineHeight: 20, minHeight: 220 }} />;
}
export function DiffModal({ preview, onCancel, onCommit, busy, theme, error }: { preview: Preview | null; onCancel(): void; onCommit(): void; busy: boolean; theme: Theme; error: string | null }) {
  const [reveal, setReveal] = useState(true);
  useEffect(() => { setReveal(true); }, [preview?.token]);
  const c = theme.colors;
  const hasChanges = preview && (preview.changes.length > 0 || preview.artifacts.length > 0);
  return <Modal open={preview !== null} title="确认配置改动" onOpenChange={(open) => { if (!open && !busy) { setReveal(false); onCancel(); } }}>
    <Modal.Content>
      <Text style={{ color: c.foreground, fontSize: 16, fontWeight: "600" }}>{preview?.title}</Text>
      <Text style={{ color: c.foregroundMuted, lineHeight: 20 }}>尚未写入。请核对文件路径、删除项和新增项。预览 20 分钟后过期；确认时会再次校验配置版本。</Text>
      {preview?.warnings.map((warning) => <Text key={warning} style={{ color: c.statusWarning, lineHeight: 20 }}>{warning}</Text>)}
      {!hasChanges && <Text style={{ color: c.foregroundMuted }}>没有需要应用的改动，当前配置 / 已安装版本已是最新。</Text>}
      {preview?.artifacts.map((artifact) => <View key={artifact.path} style={{ gap: 4 }}>
        <Text selectable style={{ color: c.foreground, fontWeight: "500" }}>{artifact.path}</Text>
        <Text style={{ color: c.foregroundMuted }}>安装目录：新增 {artifact.added} / 删除 {artifact.removed} / 修改 {artifact.changed} 项</Text>
      </View>)}
      {preview?.changes.length ? <SettingsCard><SettingsAction label="diff 可能包含 API Key、请求头或技能内容" hint="只在私密环境中展开；不会写入普通日志。"
        actionLabel={reveal ? "隐藏 diff" : "展开完整 diff"} onPress={() => setReveal(!reveal)} /></SettingsCard> : null}
      {preview?.changes.map((change) => <View key={change.path} style={{ gap: 8 }}>
        <Text selectable style={{ color: c.foreground, fontWeight: "600" }}>{change.path}</Text>
        <Text style={{ color: c.foregroundMuted }}>+{change.additions} / -{change.deletions}</Text>
        {reveal && <View style={{ padding: 10, borderRadius: 6, backgroundColor: c.surface1 }}>
          {change.diff.split("\n").map((line, index) => <Text key={index} selectable style={{ fontFamily: "monospace", fontSize: 12, lineHeight: 18,
            color: line.startsWith("+") && !line.startsWith("+++") ? c.statusSuccess : line.startsWith("-") && !line.startsWith("---") ? c.statusDanger : c.foregroundMuted }}>{line || " "}</Text>)}
        </View>}
      </View>)}
      {error && <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>{error}</Text>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        <Button label="取消，不写入" onPress={() => { setReveal(false); onCancel(); }} disabled={busy} theme={theme} />
        <Button label={busy ? "正在应用…" : "确认应用"} onPress={onCommit} disabled={busy || !hasChanges} theme={theme} active />
      </View>
    </Modal.Content>
  </Modal>;
}
export interface EntityEditorState { kind: "provider" | "mcp"; name: string; value: JsonObject; existing: boolean }
export function EntityEditor({ initial, theme, busy, onClose, onSave }: { initial: EntityEditorState; theme: Theme; busy: boolean; onClose(): void; onSave(name: string, value: JsonObject): void }) {
  const [name, setName] = useState(initial.name);
  const [text, setText] = useState(JSON.stringify(initial.value, null, 2));
  const [error, setError] = useState<string | null>(null);
  let entry: JsonObject = {}; try { entry = parseObject(text); } catch { /* Keep the exact invalid draft editable. */ }
  const change = (key: string, value: unknown) => { try { const current = parseObject(text); setText(JSON.stringify({ ...current, [key]: value }, null, 2)); setError(null); } catch { setError("请先修复下面 JSON 的语法。"); } };
  const models = Array.isArray(entry.models) ? entry.models.filter(isObject) : [];
  const changeModel = (index: number, key: string, value: unknown) => change("models", models.map((model, i) => i === index ? { ...model, [key]: value } : model));
  const c = theme.colors;
  return <Modal open title={initial.kind === "provider" ? "模型供应商" : "MCP 服务器"} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <Modal.Content>
      <SettingsCard>
        <SettingsInput label={initial.kind === "provider" ? "供应商 ID" : "服务器名称"} hint="保存后不能在此重命名；如需重命名请删除并新建。" initialValue={name} disabled={initial.existing || busy} onChangeText={setName} />
        {initial.kind === "provider" ? <>
          <Field theme={theme} label="Base URL" value={typeof entry.baseUrl === "string" ? entry.baseUrl : ""} onChangeText={(value) => change("baseUrl", value)} disabled={busy} />
          <Field theme={theme} label="API Key / 环境变量引用" hint="推荐使用 ${NAME}；此页面不执行 !command。" value={typeof entry.apiKey === "string" ? entry.apiKey : ""} onChangeText={(value) => change("apiKey", value)} secureTextEntry disabled={busy} />
          <SettingsSelect label="API 协议" value={typeof entry.api === "string" ? entry.api : "openai-completions"}
            options={["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"].map((value) => ({ label: value, value }))}
            onValueChange={(value) => change("api", value)} disabled={busy} />
        </> : <>
          <SettingsSelect label="传输方式" value={entry.command ? "stdio" : entry.url ? "http" : "override"}
            options={[{ label: "stdio 本地进程", value: "stdio" }, { label: "HTTP 远程服务", value: "http" }, { label: "仅覆盖全局状态（项目）", value: "override" }]}
            disabled={busy} onValueChange={(mode) => {
              const next = { ...entry }; for (const key of ["command", "args", "url", "type"]) delete next[key];
              if (mode === "stdio") Object.assign(next, { command: "npx", args: [] });
              if (mode === "http") next.url = "https://example.com/mcp";
              setText(JSON.stringify(next, null, 2));
            }} />
          <Field theme={theme} label="Command（stdio）" hint="一个可执行文件；参数写入下面 JSON 的 args 数组。HTTP 连接请删除 command 并填写 url。"
            value={typeof entry.command === "string" ? entry.command : ""} onChangeText={(value) => change("command", value || undefined)} disabled={busy} />
          <Field theme={theme} label="URL（HTTP）" value={typeof entry.url === "string" ? entry.url : ""} onChangeText={(value) => change("url", value || undefined)} disabled={busy} />
          <SettingsSelect label="工具暴露方式" value={typeof entry.exposure === "string" ? entry.exposure : "codemode"}
            options={["codemode", "deferred", "direct", "hidden"].map((value) => ({ label: value, value }))} onValueChange={(value) => change("exposure", value)} disabled={busy} />
        </>}
      </SettingsCard>
      {initial.kind === "provider" && <SettingsSection title="自定义模型">
        {models.map((model, index) => <SettingsCard key={index}>
          <Field theme={theme} label={`模型 ${index + 1} · ID`} value={typeof model.id === "string" ? model.id : ""} disabled={busy} onChangeText={(value) => changeModel(index, "id", value)} />
          <Field theme={theme} label="显示名称" value={typeof model.name === "string" ? model.name : ""} disabled={busy} onChangeText={(value) => changeModel(index, "name", value || undefined)} />
          <Field theme={theme} label="上下文窗口（token）" value={typeof model.contextWindow === "number" ? String(model.contextWindow) : ""} disabled={busy} onChangeText={(value) => { if (/^\d*$/.test(value)) changeModel(index, "contextWindow", value ? Number(value) : undefined); }} />
          <Field theme={theme} label="最大输出（token）" value={typeof model.maxTokens === "number" ? String(model.maxTokens) : ""} disabled={busy} onChangeText={(value) => { if (/^\d*$/.test(value)) changeModel(index, "maxTokens", value ? Number(value) : undefined); }} />
          <SettingsSwitch label="支持思考" value={model.reasoning === true} disabled={busy} onValueChange={(value) => changeModel(index, "reasoning", value)} />
          <SettingsAction label="从此供应商移除模型" actionLabel="移除" disabled={busy} onPress={() => change("models", models.filter((_, i) => i !== index))} />
        </SettingsCard>)}
        <Button label="添加自定义模型" theme={theme} disabled={busy} onPress={() => change("models", [...models, { id: "", name: "" }])} />
      </SettingsSection>}
      <Text style={{ color: c.foregroundMuted, lineHeight: 20 }}>{initial.kind === "provider"
        ? "完整供应商配置：在 models 数组中增删模型；支持 modelOverrides、上下文窗口、费用、headers 和 compat 等 Pi 原生字段。未知字段会保留。"
        : "完整服务器配置：支持 args、env、headers、oauth、timeout、toolExposure 和 enabled。粘贴单个服务器对象，不要包含 mcpServers 外层。保存不会连接服务器或执行命令。"}</Text>
      <CodeInput text={text} onChangeText={setText} theme={theme} readOnly={busy} />
      {error && <Text style={{ color: c.statusDanger }}>{error}</Text>}
      <Button label="保存并预览改动" theme={theme} disabled={busy} onPress={() => {
        try { if (!name.trim()) throw new Error("名称不能为空。"); const value = parseObject(text); if (!isObject(value)) return; onSave(name.trim(), value); }
        catch (e) { setError(e instanceof Error ? e.message : "无效配置"); }
      }} />
    </Modal.Content>
  </Modal>;
}
