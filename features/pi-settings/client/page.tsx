import { useEffect, useRef, useState } from "react";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal, ScrollView, SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch, TextInput } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { commitChanges, discardChanges, listWorkspaces, prepareChanges, preparePackage, prepareResource, readResource, readSnapshot,
  type ConfigDocument, type DocumentKind, type PackageRequest, type Preview, type Resource, type Scope, type Snapshot } from "../shared/contracts";
import { effectiveMcp, isObject, parseObject, resourceLoading, setModelInvocation, setProperty, stringList, type JsonObject } from "../shared/config";
import { Button, CodeInput, DiffModal, EntityEditor, type EntityEditorState } from "./components";
import { ConfigWarnings } from "./warnings";

type Tab = "models" | "skills" | "plugins" | "mcp" | "preferences";
const tabs: { value: Tab; label: string }[] = [
  { value: "models", label: "模型" }, { value: "skills", label: "技能" }, { value: "plugins", label: "插件" }, { value: "mcp", label: "MCP" }, { value: "preferences", label: "页面设置" },
];
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "操作失败，请检查连接后重试。";
function objectOrEmpty(text: string): JsonObject { try { return parseObject(text); } catch { return {}; } }
interface TextEditor { title: string; text: string; original: string; revision: string; kind?: DocumentKind; resource?: Resource; readOnly?: boolean }
export function PiSettingsPage(props: PluginSurfaceProps) { return <Page key={props.host.id} {...props} />; }
function Page({ theme, layout, host }: PluginSurfaceProps) {
  const rpcRead = useRpc(readSnapshot); const rpcWorkspaces = useRpc(listWorkspaces); const rpcPrepare = useRpc(prepareChanges);
  const rpcPackage = useRpc(preparePackage); const rpcResource = useRpc(readResource); const rpcPrepareResource = useRpc(prepareResource);
  const rpcCommit = useRpc(commitChanges); const rpcDiscard = useRpc(discardChanges);
  const [workspaceId, setWorkspaceId] = useState(""); const scope: Scope = workspaceId ? { workspaceId } : {};
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string; directory: string }[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null); const [drafts, setDrafts] = useState<Partial<Record<DocumentKind, string>>>({});
  const [tab, setTab] = useState<Tab>("models"); const [search, setSearch] = useState(""); const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null); const [preview, setPreview] = useState<Preview | null>(null);
  const [entity, setEntity] = useState<EntityEditorState | null>(null); const [editor, setEditor] = useState<TextEditor | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false); const [deleteEntity, setDeleteEntity] = useState<{ kind: "provider" | "mcp"; name: string } | null>(null);
  const mounted = useRef(true); const generation = useRef(0); const pending = useRef<string | null>(null);
  const c = theme.colors; const muted = { color: c.foregroundMuted, fontSize: 13, lineHeight: 20 };
  const doc = (kind: DocumentKind): ConfigDocument | undefined => snapshot?.documents.find((entry) => entry.kind === kind);
  const text = (kind: DocumentKind) => drafts[kind] ?? doc(kind)?.text ?? "{}\n";
  const dirty = Object.entries(drafts).some(([kind, value]) => value !== doc(kind as DocumentKind)?.text);
  const blocked = busy || loading || preview !== null;
  const readable = (kind: DocumentKind) => doc(kind)?.revision !== "unreadable";
  const settings = objectOrEmpty(text("settings")); const global = objectOrEmpty(snapshot?.globalSettings ?? "{}");
  const saveDraft = (kind: DocumentKind, value: string) => setDrafts((old) => ({ ...old, [kind]: value }));
  async function load(selectedScope: Scope = scope, savedPaths?: readonly string[]) {
    const current = ++generation.current; setLoading(true); setError(null);
    try {
      const state = await rpcRead(selectedScope);
      if (mounted.current && current === generation.current) {
        setSnapshot(state);
        setDrafts((previous) => !savedPaths || state.agentDir !== snapshot?.agentDir ? {} : Object.fromEntries(Object.entries(previous).filter(([kind]) => !savedPaths.includes(doc(kind as DocumentKind)?.path ?? ""))));
      }
    } catch (e) { if (mounted.current && current === generation.current) { setSnapshot(null); setError(errorMessage(e)); } }
    finally { if (mounted.current && current === generation.current) setLoading(false); }
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; if (pending.current) void rpcDiscard({ token: pending.current }).catch(() => {}); };
  }, [rpcDiscard]);
  useEffect(() => { void load(workspaceId ? { workspaceId } : {}); }, [workspaceId, rpcRead]);
  useEffect(() => { let active = true; void rpcWorkspaces({}).then((entries) => { if (active) setWorkspaces(entries); }).catch((e: unknown) => { if (active) setError(`无法列出工作区：${errorMessage(e)}`); }); return () => { active = false; }; }, [rpcWorkspaces]);
  async function apply(plan: Preview, confirmed: boolean) {
    setBusy(true); setError(null);
    try {
      const result = await rpcCommit({ token: plan.token, confirmed });
      if (!mounted.current) return;
      pending.current = null; setPreview(null); setEntity(null); setEditor(null); setDeleteEntity(null); setNotice(result.message); await load(scope, plan.changes.map((change) => change.path));
    } catch (e) { if (mounted.current) { setError(errorMessage(e)); setPreview(plan); } }
    finally { if (mounted.current) setBusy(false); }
  }
  async function prepare(operation: () => Promise<Preview>) {
    if (blocked) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const plan = await operation();
      if (!mounted.current) { await rpcDiscard({ token: plan.token }); return; }
      pending.current = plan.token;
      if (plan.changes.length === 0 && plan.artifacts.length === 0) { await rpcDiscard({ token: plan.token }); pending.current = null; setNotice("没有改动，配置或安装版本已是最新。"); }
      else if (plan.confirmationRequired) setPreview(plan);
      else await apply(plan, false);
    } catch (e) { if (mounted.current) setError(errorMessage(e)); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function cancelPreview() {
    if (!preview || busy) return;
    try { await rpcDiscard({ token: preview.token }); pending.current = null; setPreview(null); setError(null); }
    catch (e) { setError(errorMessage(e)); }
  }
  function saveDocument(kind: DocumentKind, value = text(kind)) {
    const document = doc(kind); if (!document) return;
    if (kind === "preferences" && String(objectOrEmpty(value).agentDir ?? "") !== (snapshot?.preferences.agentDir ?? "") && Object.entries(drafts).some(([key, draft]) => key !== "preferences" && draft !== doc(key as DocumentKind)?.text)) {
      setError("切换 agent 目录前，请先保存或放弃其他分区的草稿。"); return;
    }
    saveDraft(kind, value);
    void prepare(() => rpcPrepare({ ...scope, edits: [{ kind, text: value, revision: document.revision }] }));
  }
  function changeProperty(kind: DocumentKind, path: (string | number)[], value: unknown) {
    try { saveDraft(kind, setProperty(text(kind), path, value)); setError(null); }
    catch (e) { setError(errorMessage(e)); }
  }
  function saveEntity(name: string, value: JsonObject) {
    if (!entity) return;
    const kind = entity.kind === "provider" ? "models" : "mcp"; const key = entity.kind === "provider" ? "providers" : "mcpServers";
    try {
      const document = objectOrEmpty(text(kind));
      if (!entity.existing && isObject(document[key]) && Object.hasOwn(document[key], name)) throw new Error("此名称已存在，请选择其他名称。");
      setEntity({ ...entity, name, value, existing: true });
      saveDocument(kind, setProperty(text(kind), [key, name], value));
    } catch (e) { setError(errorMessage(e)); }
  }
  function removeEntity() {
    if (!deleteEntity) return;
    const kind = deleteEntity.kind === "provider" ? "models" : "mcp"; const key = deleteEntity.kind === "provider" ? "providers" : "mcpServers";
    try { saveDocument(kind, setProperty(text(kind), [key, deleteEntity.name], undefined)); } catch (e) { setError(errorMessage(e)); }
  }
  function packageAction(action: PackageRequest["action"], packageSource: string) {
    const settingsDoc = doc("settings"); const prefsDoc = doc("preferences"); if (!settingsDoc || !prefsDoc) return;
    if (drafts.settings && drafts.settings !== settingsDoc.text) { setError("请先保存或放弃 settings.json 草稿，再进行包操作。"); return; }
    void prepare(() => rpcPackage({ ...scope, action, source: packageSource, revision: settingsDoc.revision, preferencesRevision: prefsDoc.revision }));
  }
  async function openResource(resource: Resource, toggleInvocation?: boolean) {
    if (blocked) return; setBusy(true); setError(null);
    try {
      const content = await rpcResource({ ...scope, id: resource.id }); if (!mounted.current) return;
      if (toggleInvocation !== undefined) {
        setBusy(false);
        const next = setModelInvocation(content.text, toggleInvocation);
        await prepare(() => rpcPrepareResource({ ...scope, id: resource.id, text: next, revision: content.revision }));
      } else setEditor({ title: resource.path, text: content.text, original: content.text, revision: content.revision, resource, readOnly: resource.kind === "extension" });
    } catch (e) { if (mounted.current) setError(errorMessage(e)); }
    finally { if (mounted.current) setBusy(false); }
  }
  function toggleResource(resource: Resource, enabled: boolean) {
    try { saveDocument("settings", resourceLoading(text("settings"), resource, enabled, Boolean(workspaceId))); }
    catch (e) { setError(errorMessage(e)); }
  }
  const scopeHint = workspaceId ? "项目覆盖保存到工作区 .pi；未设置的字段继承全局配置。读取不会授予 Pi 项目信任。" : "全局设置适用于该宿主的所有 Pi 项目。";
  const filter = (value: string) => value.toLowerCase().includes(search.toLowerCase());
  const documentActions = (kind: DocumentKind, label: string) => <SettingsCard>
    <SettingsAction label={label} hint={doc(kind)?.path} actionLabel="查看 / 编辑原始配置" disabled={blocked || !readable(kind) || (kind === "models" && Boolean(workspaceId))} onPress={() => setEditor({ title: doc(kind)!.path, kind, text: text(kind), original: text(kind), revision: doc(kind)!.revision })} />
    {doc(kind)?.error && <SettingsRow label="文件需要处理" error={doc(kind)?.error} hint="不会将无效或不可读文件当成空配置。可读的无效文本可显式修复后审阅 diff。" />}
  </SettingsCard>;
  return <ScrollView contentContainerStyle={{ padding: layout.compact ? 16 : 28, gap: 22, maxWidth: 1180, width: "100%", alignSelf: "center" }} style={{ flex: 1, backgroundColor: c.surface0 }}>
    <View style={{ gap: 8 }}>
      <Text style={{ color: c.foreground, fontSize: 24, fontWeight: "600" }}>Pi 设置</Text>
      <Text style={muted}>管理 {host.label} 上的模型、技能、插件与 MCP。所有改动均先生成预览，默认确认 diff 后才写入。</Text>
      <Text style={muted}>只编辑配置，不启动 Pi 会话、不连接 MCP、不执行配置中的 !command。保存后请在 Pi 中 /reload 或开启新会话。</Text>
    </View>
    <SettingsSection title="配置范围">
      <SettingsCard>
        <SettingsSelect label="全局 / 项目工作区" value={workspaceId} disabled={blocked || dirty}
          options={[{ label: "全局", value: "" }, ...workspaces.map((w) => ({ label: `${w.name} · ${w.directory}`, value: w.id }))]}
          onValueChange={(value) => { setWorkspaceId(value); setSearch(""); setNotice(null); }} />
        <SettingsRow label={scopeHint} hint={snapshot ? `Agent：${snapshot.agentDir}${workspaceId ? `\n工作区：${snapshot.directory}` : ""}` : "正在确定宿主配置目录…"} />
        <SettingsAction label={dirty ? "有未保存的草稿；先保存或放弃后才能切换范围" : "从磁盘重新读取"} hint="不会静默覆盖其他客户端的修改。"
          actionLabel={dirty ? "放弃草稿并刷新" : "刷新"} disabled={blocked} onPress={() => { if (dirty) setDiscardOpen(true); else void load(); }} />
      </SettingsCard>
    </SettingsSection>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{tabs.map((item) => <Button key={item.value} label={item.label} onPress={() => { setTab(item.value); setSearch(""); }} theme={theme} active={tab === item.value} disabled={blocked} />)}</View>
    {loading && <Text style={muted}>正在读取配置与资源…</Text>}
    {busy && <Text style={muted}>正在准备或应用操作；联网包操作最长需要约 3 分钟，请勿重复点击。</Text>}
    {error && <View style={{ gap: 8 }}><Text accessibilityRole="alert" selectable style={{ color: c.statusDanger, lineHeight: 20 }}>{error}</Text><Text style={muted}>错误不会被标为成功；草稿仍保留。若有版本冲突，请取消预览并重新读取。</Text></View>}
    {notice && <Text accessibilityLiveRegion="polite" style={{ color: c.statusSuccess, lineHeight: 20 }}>{notice}</Text>}
    {snapshot && snapshot.warnings.length > 0 && <ConfigWarnings key={`${workspaceId}:${snapshot.agentDir}`} warnings={snapshot.warnings} theme={theme} layout={layout} />}
    {snapshot && !loading && <>
      {tab === "models" && <>
        <SettingsSection title={workspaceId ? "项目模型默认值" : "全局模型默认值"}>
          <SettingsCard>
            <SettingsInput key={`provider-${doc("settings")?.revision}`} label="默认供应商" initialValue={typeof settings.defaultProvider === "string" ? settings.defaultProvider : ""}
              placeholder={workspaceId && typeof global.defaultProvider === "string" ? `继承 ${global.defaultProvider}` : "例如 anthropic"} disabled={blocked || Boolean(doc("settings")?.error)} onChangeText={(value) => changeProperty("settings", ["defaultProvider"], value || undefined)} />
            <SettingsInput key={`model-${doc("settings")?.revision}`} label="默认模型 ID" initialValue={typeof settings.defaultModel === "string" ? settings.defaultModel : ""}
              placeholder={workspaceId && typeof global.defaultModel === "string" ? `继承 ${global.defaultModel}` : "例如 claude-sonnet-4-5"} disabled={blocked || Boolean(doc("settings")?.error)} onChangeText={(value) => changeProperty("settings", ["defaultModel"], value || undefined)} />
            <SettingsSelect label="默认思考等级" hint={workspaceId ? `全局：${String(global.defaultThinkingLevel ?? "medium（Pi 默认）")}` : "实际可用等级由模型能力决定。"} value={typeof settings.defaultThinkingLevel === "string" ? settings.defaultThinkingLevel : "inherit"}
              options={[{ label: workspaceId ? "继承全局" : "使用 Pi 默认值", value: "inherit" }, ...["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => ({ label: value, value }))]}
              onValueChange={(value) => changeProperty("settings", ["defaultThinkingLevel"], value === "inherit" ? undefined : value)} disabled={blocked || Boolean(doc("settings")?.error)} />
            <SettingsInput key={`enabled-${doc("settings")?.revision}`} label="启用模型范围" hint="逗号分隔，支持 provider/model 与 glob；清空表示不覆盖，[] 可在原始配置中显式设置。"
              initialValue={stringList(settings.enabledModels).join(", ")} placeholder={workspaceId ? `继承：${stringList(global.enabledModels).join(", ") || "全部可用模型"}` : "全部可用模型"} onChangeText={(value) => changeProperty("settings", ["enabledModels"], value.trim() ? value.split(",").map((x) => x.trim()).filter(Boolean) : undefined)} disabled={blocked || Boolean(doc("settings")?.error)} />
            <SettingsAction label="保存模型默认值" actionLabel="保存" disabled={blocked || !drafts.settings} onPress={() => saveDocument("settings")} />
          </SettingsCard>
        </SettingsSection>
        <SettingsSection title="自定义供应商与模型">
          <Text style={muted}>{workspaceId ? "Pi 原生只读取全局 models.json。这里仅供查看；切换到全局后可管理供应商。项目可覆盖上方模型默认值。" : "每个供应商可增删模型、修改协议、地址、密钥引用与原生高级字段。API Key 不校验、不执行。"}</Text>
          <View style={{ gap: 10 }}>{Object.entries(isObject(objectOrEmpty(text("models")).providers) ? objectOrEmpty(text("models")).providers as JsonObject : {}).map(([name, entry]) => <SettingsCard key={name}>
            <SettingsRow label={name} hint={isObject(entry) ? `${String(entry.baseUrl ?? "内置端点")} · ${Array.isArray(entry.models) ? entry.models.length : 0} 个自定义模型` : "无效的供应商条目"} />
            <SettingsAction label="供应商配置" actionLabel={workspaceId ? "仅全局可编辑" : "编辑"} disabled={blocked || Boolean(workspaceId)} onPress={() => setEntity({ kind: "provider", name, value: isObject(entry) ? entry : {}, existing: true })} />
            <SettingsAction label="移除此供应商配置（不会删除 auth.json 凭据）" actionLabel="删除" disabled={blocked || Boolean(workspaceId)} onPress={() => setDeleteEntity({ kind: "provider", name })} />
          </SettingsCard>)}</View>
          {!workspaceId && <Button label="添加供应商" theme={theme} disabled={blocked || Boolean(doc("models")?.error)} onPress={() => setEntity({ kind: "provider", name: "", value: { baseUrl: "https://api.example.com/v1", api: "openai-completions", apiKey: "${API_KEY}", models: [{ id: "model-id" }] }, existing: false })} />}
          {documentActions("models", "models.json")}
        </SettingsSection>
        {documentActions("settings", "原生设置（含逐模型思考等级与其他选项）")}
      </>}
      {(tab === "skills" || tab === "plugins") && <>
        <TextInput accessibilityLabel="搜索技能或插件" placeholder="按名称、路径或来源筛选" placeholderTextColor={c.foregroundMuted} value={search} onChangeText={setSearch}
          style={{ color: c.foreground, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border, borderRadius: 7, padding: 12 }} />
        {tab === "plugins" && <SettingsSection title={workspaceId ? "项目插件包" : "全局插件包"}>
          <Text style={muted}>插件包可包含 extensions、skills、prompts 和 themes。安装 / 检查更新先下载到临时目录，应用前统一审阅。卸载只删除 Pi 管理的安装目录和本范围声明。</Text>
          <SettingsCard><SettingsInput label="npm / Git 源" initialValue={source} placeholder="npm:@scope/pi-tools 或 git:github.com/user/repo@tag" disabled={blocked} onChangeText={setSource} />
            <SettingsAction label="安装插件包" hint="下载需要网络；不运行 npm 安装脚本。请只安装你信任的代码。" actionLabel="下载并准备安装" disabled={blocked || !source.trim()} onPress={() => packageAction("install", source.trim())} /></SettingsCard>
          {snapshot.packages.filter((p) => filter(p.source)).map((pkg) => <SettingsCard key={pkg.source}>
            <SettingsRow label={pkg.source} hint={`${pkg.version ? `版本 ${pkg.version} · ` : ""}${pkg.path ?? "尚未安装 / 路径不可用"}`} />
            <SettingsSwitch label="启用此包的全部资源" hint="停用会保存现有筛选，重新启用时恢复；不卸载文件。"
              value={pkg.enabled} disabled={blocked} onValueChange={(enabled) => packageAction(enabled ? "enable" : "disable", pkg.source)} />
            <SettingsAction label="检查并准备更新" hint="已固定版本的 npm 包不会自动升级；修改源版本后可重新安装。" actionLabel="检查 / 更新" disabled={blocked} onPress={() => packageAction("update", pkg.source)} />
            <SettingsAction label="卸载包（保留其他范围配置）" actionLabel="准备卸载" disabled={blocked} onPress={() => packageAction("remove", pkg.source)} />
          </SettingsCard>)}
          {snapshot.packages.length === 0 && <Text style={muted}>此范围尚未配置插件包。项目继承的全局包可在全局范围管理。</Text>}
          <Button label="资源筛选与本地路径引用" theme={theme} disabled={blocked} onPress={() => setEditor({ title: "settings.json · packages / extensions", kind: "settings", text: text("settings"), original: text("settings"), revision: doc("settings")!.revision })} />
          <SettingsCard>{["mcp", "llama.cpp", "codemode", "tool-search"].map((name) => <SettingsSwitch key={name} label={`Pi 内置：${name}`} value={(() => {
              const localRules = stringList(settings.extensions); const inheritedRules = workspaceId ? stringList(global.extensions) : [];
              const rule = [...inheritedRules, ...localRules].filter((value) => value === `+builtin:${name}` || value === `-builtin:${name}`).at(-1);
              return rule !== `-builtin:${name}`;
            })()} disabled={blocked || Boolean(doc("settings")?.error)}
            hint="切换内置扩展；项目显式规则覆盖全局规则。" onValueChange={(enabled) => {
              const rules = stringList(settings.extensions).filter((rule) => rule !== `+builtin:${name}` && rule !== `-builtin:${name}`);
              rules.push(`${enabled ? "+" : "-"}builtin:${name}`); saveDocument("settings", setProperty(text("settings"), ["extensions"], rules));
            }} />)}</SettingsCard>
        </SettingsSection>}
        <SettingsSection title={tab === "skills" ? "已发现的技能" : "独立扩展与包内扩展"}>
          <Text style={muted}>{tab === "skills" ? "发现 Pi 目录、.agents/skills、配置路径和已安装包内技能。作用域开关写入 settings.json，不删除技能。自动调用开关会修改原始 SKILL.md，影响该文件的所有使用者。" : "扩展代码不会在此页面加载。启停是 Pi 资源筛选规则；项目可以覆盖继承的全局规则。"}</Text>
          {snapshot.resources.filter((resource) => resource.kind === (tab === "skills" ? "skill" : "extension") && filter(`${resource.name} ${resource.path} ${resource.packageSource ?? ""}`)).map((resource) => <SettingsCard key={resource.id}>
            <SettingsRow label={resource.name} hint={`${resource.scope === "global" ? "全局" : "项目"}${resource.packageSource ? ` · ${resource.packageSource}` : ""}\n${resource.path}${resource.description ? `\n${resource.description}` : ""}`} />
            <SettingsSwitch label="在当前范围加载此资源" value={resource.enabled} onValueChange={(enabled) => toggleResource(resource, enabled)} disabled={blocked || Boolean(doc("settings")?.error)} />
            {resource.kind === "skill" && <SettingsSwitch label="允许模型自动调用" hint="关闭后仍可通过 /skill:name 手动调用；修改技能文件，不是项目覆盖。" value={resource.modelInvocation} disabled={blocked} onValueChange={(enabled) => { void openResource(resource, enabled); }} />}
            <SettingsAction label={resource.kind === "skill" ? "技能内容" : "扩展源码（只读）"} actionLabel={resource.kind === "skill" ? "查看 / 编辑" : "查看"} disabled={blocked} onPress={() => { void openResource(resource); }} />
          </SettingsCard>)}
          {!snapshot.resources.some((resource) => resource.kind === (tab === "skills" ? "skill" : "extension")) && <Text style={muted}>没有发现资源。可添加本地路径引用，或到插件页安装包含技能 / 扩展的 Pi 包。</Text>}
          {documentActions("settings", tab === "skills" ? "技能路径 / 包资源筛选" : "扩展路径 / 包资源筛选")}
        </SettingsSection>
        {tab === "skills" && <SettingsSection title="安装或更新技能包"><SettingsCard>
          <SettingsInput label="技能包源" placeholder="npm:package 或 git:github.com/user/skills" initialValue={source} disabled={blocked} onChangeText={setSource} />
          <SettingsAction label="通过 Pi 包安装技能" hint="支持包含 skills/ 或 pi.skills 清单的 Pi 包；已安装包在插件页检查更新、卸载与筛选。" actionLabel="下载并准备安装" disabled={blocked || !source.trim()} onPress={() => packageAction("install", source.trim())} />
        </SettingsCard></SettingsSection>}
      </>}
      {tab === "mcp" && <SettingsSection title={workspaceId ? "项目 MCP（含全局继承）" : "全局 MCP"}>
        <Text style={muted}>管理 Pi 原生 mcp.json 的 stdio / HTTP 配置和工具暴露方式。项目同名条目替换全局条目；无传输字段的条目仅覆盖 enabled / exposure / toolExposure。此页面不连接服务器或执行认证流程。</Text>
        {Object.entries(workspaceId ? effectiveMcp(objectOrEmpty(snapshot.globalMcp), objectOrEmpty(text("mcp"))) : effectiveMcp({}, objectOrEmpty(text("mcp")))).map(([name, entry]) => {
          const localServers = objectOrEmpty(text("mcp")).mcpServers; const local = isObject(localServers) && Object.hasOwn(localServers, name);
          return <SettingsCard key={name}>
            <SettingsRow label={name} hint={`${workspaceId && !local ? "继承全局 · " : ""}${isObject(entry) ? String(entry.command ?? entry.url ?? "项目覆盖") : "无效配置"}`} />
            <SettingsSwitch label="启用服务器" value={!isObject(entry) || entry.enabled !== false} disabled={blocked || Boolean(doc("mcp")?.error)} onValueChange={(enabled) => {
              const raw = local && isObject(localServers) && isObject(localServers[name]) ? localServers[name] : {};
              saveDocument("mcp", setProperty(text("mcp"), ["mcpServers", name], { ...raw, enabled }));
            }} />
            <SettingsSelect label="工具暴露" value={isObject(entry) && typeof entry.exposure === "string" ? entry.exposure : "codemode"} options={["codemode", "deferred", "direct", "hidden"].map((value) => ({ value, label: value }))} disabled={blocked || Boolean(doc("mcp")?.error)} onValueChange={(exposure) => {
              const raw = local && isObject(localServers) && isObject(localServers[name]) ? localServers[name] : {}; saveDocument("mcp", setProperty(text("mcp"), ["mcpServers", name], { ...raw, exposure }));
            }} />
            <SettingsAction label="编辑服务器配置" actionLabel={workspaceId && !local ? "创建项目覆盖" : "编辑"} disabled={blocked} onPress={() => setEntity({ kind: "mcp", name, value: local && isObject(localServers) && isObject(localServers[name]) ? localServers[name] : workspaceId ? { enabled: true } : isObject(entry) ? entry : {}, existing: true })} />
            <SettingsAction label={workspaceId ? "删除项目条目后恢复继承全局" : "删除服务器配置（保留认证文件）"} actionLabel="删除" disabled={blocked || !local} onPress={() => setDeleteEntity({ kind: "mcp", name })} />
          </SettingsCard>;
        })}
        <Button label="添加 MCP 服务器" theme={theme} disabled={blocked || Boolean(doc("mcp")?.error)} onPress={() => setEntity({ kind: "mcp", name: "", value: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."], exposure: "codemode" }, existing: false })} />
        {documentActions("mcp", "mcp.json（支持粘贴整个 mcpServers 配置）")}
      </SettingsSection>}
      {tab === "preferences" && <SettingsSection title="页面与安全设置">
        <SettingsCard>
          <SettingsSwitch label="写入前显示 diff 并二次确认" hint="默认开启。关闭后保存、启停、安装与更新会在完成预检后自动应用；仍然检查版本冲突。关闭此开关本身也须按原设置确认。"
            value={objectOrEmpty(text("preferences")).confirmDiff !== false} disabled={blocked || Boolean(doc("preferences")?.error)} onValueChange={(value) => changeProperty("preferences", ["confirmDiff"], value)} />
          <SettingsInput key={`agent-${doc("preferences")?.revision}`} label="Pi agent 目录" hint={`留空自动发现：${snapshot.defaultAgentDir}。支持绝对路径与 ~/；这里操作的是选定宿主，不是客户端本机。`}
            initialValue={snapshot.preferences.agentDir} placeholder={snapshot.defaultAgentDir} onChangeText={(value) => changeProperty("preferences", ["agentDir"], value)} disabled={blocked || Boolean(doc("preferences")?.error)} />
          <SettingsInput key={`executable-${doc("preferences")?.revision}`} label="Pi 可执行文件" hint="默认 pi，必须支持原生 Pi 包命令；仅一个可执行文件路径，不接受 shell 命令或参数。建议 Pi 1.2.0+。"
            initialValue={snapshot.preferences.piExecutable} onChangeText={(value) => changeProperty("preferences", ["piExecutable"], value)} disabled={blocked || Boolean(doc("preferences")?.error)} />
          <SettingsAction label="保存页面设置" actionLabel="保存" disabled={blocked || !drafts.preferences} onPress={() => saveDocument("preferences")} />
        </SettingsCard>
        <Text style={muted}>本页偏好保存在默认 agent 目录的 zeonest-pi-settings.json；不会向 Pi settings.json 注入 UI 字段。目录覆盖只影响这个管理页面，不改变 Paseo provider 启动环境。</Text>
        {documentActions("preferences", "页面偏好原始文件")}
      </SettingsSection>}
    </>}
    {entity && !preview && <EntityEditor initial={entity} theme={theme} busy={busy} onClose={() => setEntity(null)} onSave={saveEntity} />}
    <Modal open={editor !== null && !preview} title={editor?.readOnly ? "查看资源" : "编辑配置"} onOpenChange={(open) => { if (!open && !busy) { if (editor?.text !== editor?.original && !editor?.readOnly) { setError("草稿已保留；使用「放弃编辑」或保存后关闭。"); } else setEditor(null); } }}>
      <Modal.Content>
        <Text selectable style={muted}>{editor?.title}</Text>
        <Text style={muted}>{editor?.resource?.kind === "skill" ? "修改源 SKILL.md，影响该文件的所有使用者。" : "未知字段与注释保留；只会写入这里展示的文件。不要在共享屏幕中暴露凭据。"}</Text>
        {editor && <CodeInput text={editor.text} theme={theme} readOnly={editor.readOnly || busy} onChangeText={(value) => setEditor({ ...editor, text: value })} />}
        {error && <Text style={{ color: c.statusDanger }}>{error}</Text>}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
          <Button label={editor?.readOnly ? "关闭" : "放弃编辑"} theme={theme} disabled={busy} onPress={() => setEditor(null)} />
          {!editor?.readOnly && <Button label="保存并预览改动" theme={theme} disabled={busy || editor?.text === editor?.original} onPress={() => {
            if (!editor) return;
            if (editor.kind) saveDocument(editor.kind, editor.text);
            else if (editor.resource) void prepare(() => rpcPrepareResource({ ...scope, id: editor.resource!.id, text: editor.text, revision: editor.revision }));
          }} />}
        </View>
      </Modal.Content>
    </Modal>
    <Modal open={discardOpen} title="放弃未保存的草稿？" onOpenChange={setDiscardOpen}><Modal.Content>
      <Text style={muted}>只丢弃本页未保存的编辑，不修改磁盘配置。</Text>
      <Button label="放弃草稿并重新读取" theme={theme} onPress={() => { setDiscardOpen(false); setEntity(null); setEditor(null); void load(); }} />
    </Modal.Content></Modal>
    <Modal open={deleteEntity !== null && !preview} title="准备删除配置" onOpenChange={(open) => { if (!open && !busy) setDeleteEntity(null); }}><Modal.Content>
      <Text style={muted}>将删除 {deleteEntity?.name} 的{deleteEntity?.kind === "provider" ? "供应商" : "服务器"}配置。不会删除 auth.json 或 mcp-auth.json；下一步仍按 diff 确认设置处理。</Text>
      <Button label="准备删除" theme={theme} disabled={busy} onPress={removeEntity} />
    </Modal.Content></Modal>
    <DiffModal preview={preview} theme={theme} busy={busy} error={error} onCancel={() => { void cancelPreview(); }} onCommit={() => { if (preview) void apply(preview, true); }} />
  </ScrollView>;
}
