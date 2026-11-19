import { useState } from "react";
import { Text, View } from "react-native";
import { SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { isObject, stringList, type JsonObject } from "../shared/config";
import { Button, CodeInput } from "./components";
import { Caption, Field, fieldRow, row, type Theme } from "./layout";

export const exposureOptions = ["codemode", "codemode-deferred", "deferred", "direct", "hidden"].map((value) => ({ label: value, value }));
const valueOf = (value: unknown) => typeof value === "string" ? value : "";
const identities = ["openai-completions", "openai-responses", "openai-codex-responses", "anthropic-messages", "google-generative-ai", "google-vertex", "bedrock-converse-stream", "azure-openai-responses"];

export function MapFields({ label, value, onChange, theme, disabled, secret }: { label: string; value: unknown; onChange(next: JsonObject | undefined): void; theme: Theme; disabled: boolean; secret?: boolean }) {
  const pairs = Object.entries(isObject(value) ? value : {});
  const [key, setKey] = useState(""); const [draft, setDraft] = useState("");
  return <View style={{ gap: 7 }}>
    <Caption theme={theme}>{label}{pairs.length ? ` · ${pairs.length}` : ""}</Caption>
    {pairs.map(([name, current]) => <Field key={name} theme={theme} label={name} value={valueOf(current)} secret={secret} disabled={disabled} onChangeText={(text) => onChange({ ...(isObject(value) ? value : {}), [name]: text })}
      action={<Button label={`移除 ${name}`} theme={theme} disabled={disabled} onPress={() => onChange(Object.fromEntries(pairs.filter(([item]) => item !== name)))} />} />)}
    <View style={fieldRow}>
      <View style={{ flex: 1, minWidth: 120 }}><Field label={`${label}名称`} theme={theme} value={key} disabled={disabled} onChangeText={setKey} /></View>
      <View style={{ flex: 2, minWidth: 120 }}><Field label={`${label}值`} theme={theme} value={draft} secret={secret} disabled={disabled} onChangeText={setDraft} /></View>
      <Button label={`添加${label}`} theme={theme} disabled={disabled || !key.trim() || /^(?:__proto__|constructor|prototype)$/.test(key.trim()) || pairs.some(([name]) => name === key.trim())} onPress={() => {
        onChange({ ...Object.fromEntries(pairs), [key.trim()]: draft }); setKey(""); setDraft("");
      }} />
    </View>
  </View>;
}

const thinkingFormats = ["ant-ling", "baseten", "chat-template", "deepseek", "openai", "openrouter", "qwen", "qwen-chat-template", "string-thinking", "together", "zai"];
const choices = (values: readonly string[], current: unknown) => [{ label: "继承", value: "" }, ...[...new Set([...values, ...(typeof current === "string" && current ? [current] : [])])].map((value) => ({ label: value, value }))];
const object = (value: unknown) => isObject(value) ? value : {};
function omitEmpty(value: JsonObject, key: string, next: unknown) {
  const result = { ...value };
  if (next === undefined) delete result[key]; else result[key] = next;
  return Object.keys(result).length ? result : undefined;
}

export function ModelAdvanced({ model, custom, theme, disabled, change, action }: { model: JsonObject; custom?: boolean; theme: Theme; disabled: boolean; change(key: string, value: unknown): void; action?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const compat = object(model.compat), limits = object(model.inputLimits), images = object(limits.images), resize = object(images.resize), levels = object(model.thinkingLevelMap);
  const select = (label: string, value: unknown, options: string[], update: (next: unknown) => void) => <SettingsSelect label={label} value={valueOf(value)} options={choices(options, value)} disabled={disabled} onValueChange={(next) => update(next || undefined)} />;
  const bool = (label: string, key: string) => <SettingsSelect key={key} label={label} value={typeof compat[key] === "boolean" ? String(compat[key]) : ""} options={[{ label: "继承", value: "" }, { label: "启用", value: "true" }, { label: "停用", value: "false" }]} disabled={disabled} onValueChange={(next) => change("compat", omitEmpty(compat, key, next ? next === "true" : undefined))} />;
  return <View style={{ gap: 7 }}><View style={row}>{action}<Button label={open ? "收起高级设置" : "模型高级设置"} theme={theme} onPress={() => setOpen(!open)} /></View>
    {open && <>
      {custom && <><Field label="模型 Base URL" placeholder="继承供应商" value={valueOf(model.baseUrl)} onChangeText={(next) => change("baseUrl", next || undefined)} theme={theme} disabled={disabled} />
        {select("模型 API 协议", model.api, identities, (next) => change("api", next))}</>}
      <MapFields label="模型请求头" value={model.headers} onChange={(next) => change("headers", next)} theme={theme} disabled={disabled} secret />
      <Field label="图片缩放上限（字节）" placeholder="继承" value={typeof resize.maxBytes === "number" ? String(resize.maxBytes) : ""} theme={theme} disabled={disabled} onChangeText={(next) => {
        if (!/^\d*$/.test(next)) return;
        change("inputLimits", omitEmpty(limits, "images", omitEmpty(images, "resize", omitEmpty(resize, "maxBytes", next ? Number(next) : undefined))));
      }} />
      {select("思考协议", compat.thinkingFormat, thinkingFormats, (next) => change("compat", omitEmpty(compat, "thinkingFormat", next)))}
      {bool("支持 Developer 角色", "supportsDeveloperRole")}
      {bool("强制 Anthropic 自适应思考", "forceAdaptiveThinking")}
      <Caption theme={theme}>思考等级映射 · 留空继承，输入 null 禁用该等级。</Caption>
      <View style={row}>{["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((key) => <View key={key} style={{ flex: 1, minWidth: 98 }}>
        <Field label={key} value={levels[key] === null ? "null" : valueOf(levels[key])} theme={theme} disabled={disabled} onChangeText={(next) => change("thinkingLevelMap", omitEmpty(levels, key, next === "null" ? null : next || undefined))} />
      </View>)}</View>
    </>}
  </View>;
}

function ToolRules({ value, tools, theme, disabled, onChange }: { value: unknown; tools: string[]; theme: Theme; disabled: boolean; onChange(value: JsonObject | undefined): void }) {
  const [name, setName] = useState("");
  const rules = isObject(value) ? value : {};
  const validName = (key: string) => !!key && !/^(?:__proto__|constructor|prototype)$|[\x00-\x1f]/.test(key);
  const update = (key: string, mode: string) => {
    const next = { ...rules };
    if (mode === "inherit") delete next[key]; else next[key] = mode;
    onChange(Object.keys(next).length ? next : undefined);
  };
  const options = [{ label: "继承服务器规则", value: "inherit" }, ...exposureOptions];
  return <View style={{ gap: 8 }}>
    <Caption theme={theme}>单个工具的暴露规则</Caption>
    {Object.entries(rules).map(([key, mode]) => <SettingsSelect key={key} label={key} options={options} value={exposureOptions.some((opt) => opt.value === mode) ? String(mode) : "inherit"} onValueChange={(next) => update(key, next)} disabled={disabled} />)}
    {tools.length > 0 && <SettingsSelect label="从探测结果选择工具" options={[{ label: "选择工具…", value: "" }, ...tools.filter((key) => validName(key) && !Object.hasOwn(rules, key)).map((key) => ({ label: key, value: key }))]} value={tools.includes(name) && !Object.hasOwn(rules, name) ? name : ""} onValueChange={setName} disabled={disabled} />}
    <Field label="工具名称" placeholder="填入工具名称以添加规则" value={name} onChangeText={setName} disabled={disabled} theme={theme} />
    {validName(name.trim()) && !Object.hasOwn(rules, name.trim()) && <SettingsSelect label="添加工具规则" options={options} value="inherit" onValueChange={(next) => { if (next !== "inherit") { update(name.trim(), next); setName(""); } }} disabled={disabled} />}
  </View>;
}

export function EntityForm({ kind, name, onName, value, raw, onRaw, onValue, theme, disabled, existing, project, tools = [] }: {
  kind: "provider" | "mcp"; name: string; onName(value: string): void; value: JsonObject | null; raw: string; onRaw(raw: string): void;
  onValue(value: JsonObject): void; theme: Theme; disabled: boolean; existing: boolean; project: boolean; tools?: string[];
}) {
  const [advanced, setAdvanced] = useState(false); const [reveal, setReveal] = useState(false); const [expandedModel, setExpandedModel] = useState<number | null>(null);
  const [oauthOpen, setOauthOpen] = useState(false);
  const entry = value ?? {}; const locked = disabled || value === null;
  const set = (key: string, next: unknown) => onValue({ ...entry, [key]: next });
  const field = (label: string, key: string, secret = false) => <Field label={label} value={valueOf(entry[key])} theme={theme} secret={secret} disabled={locked} onChangeText={(text) => set(key, text || undefined)} />;
  const models = Array.isArray(entry.models) ? entry.models : [];
  const oauth = isObject(entry.oauth) ? entry.oauth : {};
  const setOauth = (key: string, next: string) => {
    const updated = { ...oauth };
    if (next) updated[key] = next; else delete updated[key];
    set("oauth", Object.keys(updated).length ? updated : undefined);
  };
  const modelValue = (index: number) => isObject(models[index]) ? models[index] as JsonObject : {};
  const changeModel = (index: number, key: string, next: unknown) => set("models", models.map((model, i) => i === index ? { ...modelValue(index), [key]: next } : model));
  const api = valueOf(entry.api);
  const transport = typeof entry.command === "string" ? "stdio" : typeof entry.url === "string" || typeof entry.type === "string" ? "http" : project ? "override" : "stdio";
  return <View style={{ gap: 8 }}>
    {!existing && <Field label={kind === "provider" ? "供应商 ID" : "服务器名称"} value={name} onChangeText={onName} theme={theme} disabled={disabled} />}
    {!value && <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>JSON 格式有误，请在原始配置中修复。</Text>}
    {kind === "provider" ? <>
      {field("Base URL", "baseUrl")}
      <Field label="API Key / 环境变量名" value={valueOf(entry.apiKey)} theme={theme} secret={!reveal} disabled={locked} onChangeText={(text) => set("apiKey", text || undefined)}
        action={<Button label={reveal ? "隐藏 API Key" : "显示 API Key"} onPress={() => setReveal(!reveal)} theme={theme} />} />
      <SettingsSelect label="API 协议" value={api} options={[{ label: "继承 Pi 内置协议", value: "" }, ...[...new Set([...identities, ...(api ? [api] : [])])].map((value) => ({ label: value, value }))]} onValueChange={(next) => set("api", next || undefined)} disabled={locked} />
      <MapFields label="请求头" value={entry.headers} onChange={(next) => set("headers", next)} theme={theme} disabled={locked} secret />
      <View style={{ ...row, justifyContent: "space-between" }}><Caption theme={theme}>自定义模型 · {models.length}</Caption><Button label="添加自定义模型" theme={theme} disabled={locked} onPress={() => { set("models", [...models, { id: "" }]); setExpandedModel(models.length); }} /></View>
      {models.map((_, index) => {
        const model = modelValue(index); const opened = expandedModel === index;
        return <View key={index} style={{ gap: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
          <Button label={`${opened ? "收起" : "编辑"} ${valueOf(model.id) || `模型 ${index + 1}`}`} theme={theme} onPress={() => setExpandedModel(opened ? null : index)} />
          {opened && <>
            <Field label={`模型 ${index + 1} · ID`} theme={theme} disabled={locked} value={valueOf(model.id)} onChangeText={(next) => changeModel(index, "id", next)} />
            <Field label="显示名称" theme={theme} disabled={locked} value={valueOf(model.name)} onChangeText={(next) => changeModel(index, "name", next || undefined)} />
            {([["上下文窗口", "contextWindow"], ["最大输出", "maxTokens"]] as const).map(([label, key]) => <Field key={key} label={label} theme={theme} disabled={locked} value={typeof model[key] === "number" ? String(model[key]) : ""} onChangeText={(next) => { if (/^\d*$/.test(next)) changeModel(index, key, next ? Number(next) : undefined); }} />)}
            <SettingsSwitch label="支持思考" value={model.reasoning === true} disabled={locked} onValueChange={(next) => changeModel(index, "reasoning", next)} />
            <SettingsSwitch label="支持图片" value={stringList(model.input).includes("image")} disabled={locked} onValueChange={(next) => changeModel(index, "input", next ? [...new Set(["text", ...stringList(model.input), "image"])] : stringList(model.input).filter((part) => part !== "image"))} />
            <ModelAdvanced key={index} model={model} custom theme={theme} disabled={locked} change={(key, next) => changeModel(index, key, next)} />
            <Button label="移除自定义模型" theme={theme} disabled={locked} onPress={() => { set("models", models.filter((_, i) => i !== index)); setExpandedModel(null); }} />
          </>}
        </View>;
      })}
    </> : <>
      <SettingsSwitch label="启用服务器" value={entry.enabled !== false} onValueChange={(next) => set("enabled", next)} disabled={locked} />
      <SettingsSelect label="传输方式" value={transport} options={[{ label: "stdio · 本地进程", value: "stdio" }, { label: "HTTP · 远程服务", value: "http" }, ...(project ? [{ label: "覆盖全局状态", value: "override" }] : [])]} disabled={locked} onValueChange={(mode) => {
        const next = { ...entry };
        if (mode === transport) return;
        const fields = mode === "stdio" ? ["url", "type", "headers", "oauth", "auth"] : ["command", "args", "cwd", "env"];
        for (const key of fields) delete next[key];
        if (mode === "stdio") onValue({ ...next, command: "", args: [] });
        else if (mode === "http") onValue({ ...next, url: "", type: "streamable-http" });
        else onValue(Object.fromEntries(Object.entries(next).filter(([key]) => ["enabled", "exposure", "toolExposure"].includes(key))));
      }} />
      {transport !== "override" && <>
        {field("描述", "description")}
        <Field label="超时（秒）" theme={theme} disabled={locked} value={typeof entry.timeout === "number" ? String(entry.timeout) : ""} onChangeText={(next) => { if (/^\d*$/.test(next)) set("timeout", next ? Number(next) : undefined); }} />
      </>}
      {transport === "stdio" && <>
        <Field label="命令" theme={theme} disabled={locked} value={valueOf(entry.command)} onChangeText={(next) => set("command", next)} />
        {field("工作目录", "cwd")}
        <View style={{ ...row, justifyContent: "space-between" }}><Caption theme={theme}>命令参数</Caption><Button label="添加参数" theme={theme} disabled={locked} onPress={() => set("args", [...stringList(entry.args), ""])} /></View>
        {stringList(entry.args).map((arg, index, args) => <Field key={index} label={`参数 ${index + 1}`} theme={theme} value={arg} disabled={locked} onChangeText={(next) => set("args", args.map((x, i) => i === index ? next : x))}
          action={<Button label={`移除参数 ${index + 1}`} theme={theme} disabled={locked} onPress={() => set("args", args.filter((_, i) => index !== i))} />} />)}
        <MapFields label="环境变量" value={entry.env} onChange={(next) => set("env", next)} theme={theme} disabled={locked} secret />
      </>}
      {transport === "http" && <>
        <Field label="URL" theme={theme} disabled={locked} value={valueOf(entry.url)} onChangeText={(next) => set("url", next)} />
        <MapFields label="请求头" value={entry.headers} onChange={(next) => set("headers", next)} theme={theme} disabled={locked} secret />
        <View style={{ alignSelf: "flex-start" }}><Button label={oauthOpen ? "收起 OAuth 配置" : "OAuth 客户端配置"} theme={theme} onPress={() => setOauthOpen(!oauthOpen)} /></View>
        {oauthOpen && <>
          <Caption theme={theme}>在宿主的 Pi CLI 中完成登录；此处仅保存客户端配置。</Caption>
          <Field label="Client ID" theme={theme} disabled={locked} value={valueOf(oauth.clientId)} onChangeText={(next) => setOauth("clientId", next)} />
          <Field label="Client Secret" theme={theme} disabled={locked} secret value={valueOf(oauth.clientSecret)} onChangeText={(next) => setOauth("clientSecret", next)} />
          <Field label="客户端名称" theme={theme} disabled={locked} value={valueOf(oauth.clientName)} onChangeText={(next) => setOauth("clientName", next)} />
          <Field label="授权范围（Scope）" theme={theme} disabled={locked} value={valueOf(oauth.scope)} onChangeText={(next) => setOauth("scope", next)} />
          <Field label="回调 URL" placeholder="http://localhost:port/callback" theme={theme} disabled={locked} value={valueOf(oauth.callbackUrl)} onChangeText={(next) => setOauth("callbackUrl", next)} />
          <SettingsSelect label="客户端注册方式" value={valueOf(oauth.clientRegistration)} options={[{ label: "Pi 默认值", value: "" }, ...["auto", "dcr", "cimd"].map((value) => ({ label: value, value }))]} disabled={locked} onValueChange={(next) => setOauth("clientRegistration", next)} />
        </>}
      </>}
      <SettingsSelect label="工具暴露" value={valueOf(entry.exposure) || "inherit"} options={[{ value: "inherit", label: "继承 / 使用 Pi 默认值" }, ...exposureOptions]} disabled={locked} onValueChange={(next) => set("exposure", next === "inherit" ? undefined : next)} />
      <ToolRules value={entry.toolExposure} tools={tools} onChange={(next) => set("toolExposure", next)} theme={theme} disabled={locked} />
    </>}
    <View style={{ alignSelf: "flex-start" }}><Button label={advanced ? "隐藏原始配置" : "编辑原始配置"} theme={theme} onPress={() => setAdvanced(!advanced)} /></View>
    {advanced && <CodeInput text={raw} theme={theme} readOnly={disabled} onChangeText={onRaw} />}
  </View>;
}
