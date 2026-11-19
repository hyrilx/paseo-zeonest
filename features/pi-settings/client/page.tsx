import { useEffect, useRef, useState } from "react";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { Pressable, Text, View } from "react-native";
import { commitChanges, discardChanges, inventoryModels, listWorkspaces, packageVersion, prepareChanges, preparePackage, prepareResource, probeMcp, readResource, readSnapshot, searchPackages, startSubscription, subscriptionAction, subscriptionCatalog, testModel,
  type CatalogModel, type DocumentKind, type PackageRequest, type PackageUpdate, type Preview, type Resource, type Scope, type Snapshot, type SubscriptionCatalog } from "../shared/contracts";
import { effectiveMcp, isObject, parseObject, resourceLoading, setModelInvocation, setProperty, sourceOf, stringList, validateConfig, type JsonObject } from "../shared/config";
import { canCheckPackage, mergeMcpImport, toggleSubscriptionModel } from "../shared/management";
import { McpCodeMode } from "./codemode";
import { Button, CodeInput, DiffModal } from "./components";
import { EntityForm } from "./entity";
import { Caption, Field, Heading, ListRow, matches, Pane, row } from "./layout";
import { modelCatalog, ModelDefaults, ModelsInventory, providerEntries } from "./models";
import { matchingResources, PackageDetail, PackageInstall, ReferencePath, ResourceDetail } from "./resources";
import { Subscriptions } from "./subscriptions";
import { ConfigWarnings } from "./warnings";

type Tab = "models" | "skills" | "plugins" | "mcp";
const tabs: { value: Tab; label: string }[] = [
  { value: "models", label: "模型" }, { value: "skills", label: "技能" }, { value: "plugins", label: "插件" }, { value: "mcp", label: "MCP" },
];
const empty: Record<Tab, string> = { models: "defaults", skills: "", plugins: "", mcp: "" };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "操作失败，请检查连接后重试。";
function objectOrNull(text: string): JsonObject | null { try { return parseObject(text); } catch { return null; } }
const objectOrEmpty = (text: string) => objectOrNull(text) ?? {};
const entityKey = (name: string) => `entity:${name}`;
interface TextEditor { title: string; text: string; original: string; kind?: DocumentKind; resource?: Resource; revision: string }
interface EntityDraft { kind: "provider" | "mcp"; name: string; originalName: string | null; raw: string; originalRaw: string }
interface Confirmation { title: string; message: string; label: string; run(): void }
interface McpResult { state: "connected" | "needs-auth" | "failed"; tools: string[] }
interface PackageTarget { source: string; workspaceId?: string }
const packageKey = ({ source, workspaceId }: PackageTarget) => JSON.stringify([workspaceId ?? "", source]);
const checkBadge = (result?: PackageUpdate) => result && ({ current: "已是当前", different: "有版本差异", failed: "检查失败", unavailable: "无法检查" }[result.state]);
const mcpSeed = JSON.stringify({ command: "", args: [] }, null, 2);
function skillTarget(resource: Resource, workspaceId: string): PackageTarget | undefined {
  return resource.packageSource ? { source: resource.packageSource, workspaceId: resource.scope === "project" ? workspaceId || undefined : undefined } : undefined;
}

export function PiSettingsPage(props: PluginSurfaceProps) { return <Page key={props.host.id} {...props} />; }
function Page({ theme, layout, host }: PluginSurfaceProps) {
  const rpcRead = useRpc(readSnapshot); const rpcWorkspaces = useRpc(listWorkspaces); const rpcPrepare = useRpc(prepareChanges);
  const rpcPackage = useRpc(preparePackage); const rpcResource = useRpc(readResource); const rpcPrepareResource = useRpc(prepareResource);
  const rpcCommit = useRpc(commitChanges); const rpcDiscard = useRpc(discardChanges);
  const rpcCatalog = useRpc(inventoryModels); const rpcTest = useRpc(testModel); const rpcProbe = useRpc(probeMcp);
  const rpcSearch = useRpc(searchPackages); const rpcVersion = useRpc(packageVersion);
  const rpcSubscriptions = useRpc(subscriptionCatalog); const rpcStart = useRpc(startSubscription); const rpcAuth = useRpc(subscriptionAction);
  const [workspaceId, setWorkspaceId] = useState(""); const scope: Scope = workspaceId ? { workspaceId } : {}; const project = Boolean(workspaceId);
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string; directory: string }[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<DocumentKind, string>>>({});
  const [tab, setTab] = useState<Tab>("models"); const [selection, setSelection] = useState("defaults"); const [inDetail, setInDetail] = useState(false);
  const [search, setSearch] = useState(""); const [resourceFilter, setResourceFilter] = useState("all");
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null); const [preview, setPreview] = useState<Preview | null>(null);
  const [entity, setEntity] = useState<EntityDraft | null>(null); const [editor, setEditor] = useState<TextEditor | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [resourcePreview, setResourcePreview] = useState<{ id: string; text: string } | null>(null);
  const [inventory, setInventory] = useState<CatalogModel[] | null>(null);
  const [subscriptions, setSubscriptions] = useState<SubscriptionCatalog | null>(null);
  const [addMethod, setAddMethod] = useState<"search" | "local" | "json" | "manual">("search");
  const [authBusy, setAuthBusy] = useState(false);
  const [mcpResults, setMcpResults] = useState<Record<string, McpResult>>({}); const [versions, setVersions] = useState<Record<string, PackageUpdate>>({});
  const [importText, setImportText] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false); const [scopeOpen, setScopeOpen] = useState(false);
  const mounted = useRef(true); const generation = useRef(0); const pending = useRef<string | null>(null); const running = useRef(false);
  const draftRevisions = useRef<Partial<Record<DocumentKind, string>>>({});
  const c = theme.colors;
  const doc = (kind: DocumentKind) => snapshot?.documents.find((entry) => entry.kind === kind);
  const text = (kind: DocumentKind) => drafts[kind] ?? doc(kind)?.text ?? "{}\n";
  const edits = (Object.keys(drafts) as DocumentKind[]).filter((kind) => drafts[kind] !== doc(kind)?.text);
  const entityDirty = !!entity && (entity.originalName === null || entity.raw !== entity.originalRaw);
  const dirty = edits.length > 0 || entityDirty;
  const blocked = busy || loading || preview !== null || authBusy;
  const writable = (kind: DocumentKind) => !!doc(kind) && !doc(kind)?.error && !(project && kind === "models");
  const settings = objectOrEmpty(text("settings")); const global = objectOrEmpty(snapshot?.globalSettings ?? "{}");
  function rememberRevision(kind: DocumentKind) {
    draftRevisions.current[kind] ??= doc(kind)?.revision;
  }
  const saveDraft = (kind: DocumentKind, value: string) => {
    rememberRevision(kind);
    setDrafts((old) => ({ ...old, [kind]: value })); setError(null); setNotice(null);
  };
  function changeDocument(kind: DocumentKind, update: (current: string) => string) {
    try { saveDraft(kind, update(text(kind))); } catch (e) { setError(errorMessage(e)); }
  }
  const changeProperty = (kind: DocumentKind, path: (string | number)[], value: unknown) => changeDocument(kind, (current) => setProperty(current, path, value));
  const begin = () => { running.current = true; setBusy(true); setError(null); setNotice(null); };
  const finish = () => { running.current = false; if (mounted.current) setBusy(false); };
  async function load(selectedScope: Scope = scope, savedPaths?: readonly string[]) {
    const current = ++generation.current; setLoading(true); setError(null);
    try {
      const state = await rpcRead(selectedScope);
      if (mounted.current && current === generation.current) {
        setSnapshot(state);
        const sameAgent = state.agentDir === snapshot?.agentDir;
        if (!savedPaths || !sameAgent) { draftRevisions.current = {}; setDrafts({}); }
        else {
          const savedKinds = snapshot?.documents.filter((item) => savedPaths.includes(item.path)).map((item) => item.kind) ?? [];
          for (const kind of savedKinds) delete draftRevisions.current[kind];
          setDrafts((previous) => Object.fromEntries(Object.entries(previous).filter(([kind]) => !savedKinds.includes(kind as DocumentKind))));
        }
        if (!savedPaths || !sameAgent || savedPaths.some((path) => path === doc("models")?.path || path === doc("preferences")?.path)) { setInventory(null); setSubscriptions(null); }
        if (!savedPaths || !sameAgent || savedPaths.some((path) => path === doc("mcp")?.path || path === doc("preferences")?.path)) setMcpResults({});
        if (!savedPaths || !sameAgent || state.documents.some((entry) => entry.kind === "settings" && savedPaths.includes(entry.path)) || savedPaths.includes(doc("preferences")?.path ?? "")) setVersions({});
        setResourcePreview(null);
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
    begin();
    try {
      const result = await rpcCommit({ token: plan.token, confirmed });
      if (!mounted.current) return;
      pending.current = null; setPreview(null); setEditor(null); setNotice(result.message); await load(scope, plan.changes.map((change) => change.path));
    } catch (e) { if (mounted.current) { setError(errorMessage(e)); setPreview(plan); } }
    finally { finish(); }
  }
  async function prepare(operation: () => Promise<Preview>) {
    if (blocked || running.current) return;
    begin();
    try {
      const plan = await operation();
      if (!mounted.current) { await rpcDiscard({ token: plan.token }); return; }
      pending.current = plan.token;
      if (plan.changes.length === 0 && plan.artifacts.length === 0) { await rpcDiscard({ token: plan.token }); pending.current = null; setNotice("没有需要写入的改动。"); }
      else if (plan.confirmationRequired) setPreview(plan);
      else await apply(plan, false);
    } catch (e) { if (mounted.current) setError(errorMessage(e)); }
    finally { finish(); }
  }
  async function cancelPreview() {
    if (!preview || busy || running.current) return;
    running.current = true; setBusy(true);
    try { await rpcDiscard({ token: preview.token }); pending.current = null; setPreview(null); setError(null); }
    catch (e) { if (mounted.current) setError(errorMessage(e)); }
    finally { finish(); }
  }
  function run<T>(operation: () => Promise<T>, result: (value: T) => void) {
    if (blocked || running.current) return;
    begin();
    void (async () => {
      try { const value = await operation(); if (mounted.current) result(value); }
      catch (e) { if (mounted.current) setError(errorMessage(e)); }
      finally { finish(); }
    })();
  }
  function ask(title: string, message: string, label: string, action: () => void) {
    setConfirmation({ title, message, label, run: () => { setConfirmation(null); action(); } });
  }
  function entityToDocument() {
    if (!entity || !entityDirty) return;
    const kind = entity.kind === "provider" ? "models" : "mcp"; const key = entity.kind === "provider" ? "providers" : "mcpServers";
    const name = entity.name.trim(); const existing = objectOrEmpty(text(kind))[key];
    if (!name || /^(?:__proto__|constructor|prototype)$/.test(name) || /[\x00-\x1f]/.test(name)) throw new Error("请填写有效的名称。");
    if (entity.originalName === null && isObject(existing) && Object.hasOwn(existing, name)) throw new Error("名称已存在，请使用其他名称。");
    const value = setProperty(text(kind), [key, name], parseObject(entity.raw));
    validateConfig(kind, value, project && kind === "mcp");
    return { kind, name, value } as const;
  }
  function stageEntity() {
    if (!entity) return true;
    try { const staged = entityToDocument(); if (staged) saveDraft(staged.kind, staged.value); setEntity(null); return true; }
    catch (e) { setError(errorMessage(e)); return false; }
  }
  function saveAll() {
    try {
      const staged = entityToDocument();
      const values = { ...drafts, ...(staged ? { [staged.kind]: staged.value } : {}) };
      const request = (Object.keys(values) as DocumentKind[]).flatMap((kind) => {
        const document = doc(kind); const value = values[kind];
        if (!document || value === undefined || document.text === value) return [];
        const revision = draftRevisions.current[kind] ?? document.revision;
        if (revision !== document.revision) throw new Error(`草稿所依据的文件已变更：${document.path}。请备份草稿后刷新。`);
        return [{ kind, text: value, revision }];
      });
      if (staged) { rememberRevision(staged.kind); setDrafts(values); setSelection(entityKey(staged.name)); }
      setEntity(null);
      if (request.length) void prepare(() => rpcPrepare({ ...scope, edits: request }));
    } catch (e) { setError(errorMessage(e)); }
  }
  function select(next: string, nextTab = tab) {
    if (next === selection && nextTab === tab) { setInDetail(true); return true; }
    if (!stageEntity()) return false;
    if (tab !== nextTab) { setTab(nextTab); setSearch(""); setResourceFilter("all"); setNotice(null); }
    setSelection(next); setInDetail(true); return true;
  }
  function switchTab(next: Tab) {
    if (tab === next || !stageEntity()) return;
    setTab(next); setSelection(empty[next]); setSearch(""); setResourceFilter("all"); setInDetail(false); setNotice(null);
  }
  function openAdd(method: typeof addMethod) {
    if (select("add")) setAddMethod(method);
  }
  function editEntity(kind: EntityDraft["kind"], name: string | null, value: JsonObject) {
    if (entity && entity.kind === kind && entity.originalName === name) { setInDetail(true); return; }
    if (!select(name === null ? "new" : entityKey(name))) return;
    const raw = JSON.stringify(value, null, 2);
    setEntity({ kind, name: name ?? "", originalName: name, raw, originalRaw: raw });
  }
  function removeEntity(kind: "models" | "mcp", name: string) {
    ask("删除配置？", `将从草稿中移除 ${name}。认证文件会保留。`, "删除条目", () => {
      changeProperty(kind, [kind === "models" ? "providers" : "mcpServers", name], undefined);
      setEntity(null); setSelection(empty[tab]); setInDetail(false);
    });
  }
  function packageAction(action: PackageRequest["action"], source: string) {
    const configuration = doc("settings"); const prefs = doc("preferences"); if (!configuration || !prefs) return;
    if (edits.includes("settings") || edits.includes("preferences")) { setError("请先保存或放弃配置草稿，再操作包。"); return; }
    void prepare(() => rpcPackage({ ...scope, action, source, revision: configuration.revision, preferencesRevision: prefs.revision }));
  }
  function checkPackages(targets: PackageTarget[]) {
    const queue = [...new Map(targets.filter(({ source }) => canCheckPackage(source)).map((item) => [packageKey(item), item])).values()];
    if (!queue.length) return;
    run(async () => {
      const results: Record<string, PackageUpdate> = {};
      let cursor = 0;
      const worker = async () => {
        while (mounted.current && cursor < queue.length) {
          const item = queue[cursor++]!;
          try { results[packageKey(item)] = await rpcVersion(item); }
          catch (e) { results[packageKey(item)] = { state: "failed", installed: null, remote: null, message: errorMessage(e) }; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
      return results;
    }, (results) => {
      setVersions((old) => ({ ...old, ...results }));
      const values = Object.values(results);
      const count = (state: PackageUpdate["state"]) => values.filter((x) => x.state === state).length;
      setNotice(`检查 ${values.length} 个包：${count("different")} 个有差异，${count("current")} 个相同，${count("failed") + count("unavailable")} 个未能比较。`);
    });
  }
  function openResource(resource: Resource, edit = false) {
    run(() => rpcResource({ ...scope, id: resource.id }), (content) => {
      if (edit) setEditor({ ...content, original: content.text, title: resource.path, resource });
      else setResourcePreview({ id: resource.id, text: content.text });
    });
  }
  function changeInvocation(resource: Resource, enabled: boolean) {
    void prepare(async () => {
      const content = await rpcResource({ ...scope, id: resource.id });
      return rpcPrepareResource({ ...scope, id: resource.id, text: setModelInvocation(content.text, enabled), revision: content.revision });
    });
  }
  function toggleResources(resources: Resource[], enabled: boolean) {
    changeDocument("settings", (current) => resources.reduce((acc, resource) => resourceLoading(acc, resource, enabled, project), current));
  }
  function resourceEnabled(resource: Resource) {
    if (!edits.includes("settings")) return resource.enabled;
    const key = resource.kind === "skill" ? "skills" : "extensions";
    let path = resource.path;
    let rules = stringList(settings[key]);
    if (resource.packageSource && resource.packageRoot) {
      const root = resource.packageRoot.replace(/\\/g, "/").replace(/\/$/, "");
      path = path.replace(/\\/g, "/");
      if (!path.startsWith(`${root}/`)) return resource.enabled;
      path = path.slice(root.length + 1);
      const entry = Array.isArray(settings.packages) ? settings.packages.find((entry) => sourceOf(entry) === resource.packageSource || (project && resource.scope === "global" && sourceOf(entry) === resource.packageRoot)) : undefined;
      rules = isObject(entry) ? stringList(entry[key]) : [];
    }
    const rule = rules.findLast((rule) => rule === `+${path}` || rule === `-${path}`);
    return rule ? rule.startsWith("+") : resource.enabled;
  }
  function openSource(kind: DocumentKind) {
    const current = doc(kind); if (!current) return;
    try {
      const staged = entityToDocument();
      if (staged) {
        saveDraft(staged.kind, staged.value);
        setSelection(entityKey(staged.name));
      }
      setEntity(null);
      const draft = staged?.kind === kind ? staged.value : text(kind);
      setEditor({ title: current.path, text: draft, original: draft, revision: current.revision, kind });
    } catch (e) { setError(errorMessage(e)); }
  }
  const sourceButton = (kind: DocumentKind, label: string) => <View style={{ alignSelf: "flex-start" }}><Button label={label} theme={theme} disabled={blocked || !doc(kind) || doc(kind)?.revision === "unreadable" || (project && kind === "models")} onPress={() => openSource(kind)} /></View>;
  const probeInput = (kind: "models" | "mcp") => ({ confirmed: true as const, revision: doc(kind)?.revision ?? "", preferencesRevision: doc("preferences")?.revision ?? "" });
  const canProbe = (kind: "models" | "mcp") => !blocked && !!doc(kind) && !doc(kind)?.error && !doc("preferences")?.error && !edits.includes(kind) && !edits.includes("preferences") && !entityDirty;
  const checkModels = () => ask("读取 Pi 模型目录？", "使用宿主已保存的 Pi 配置与认证。Pi 解析凭据时可能执行配置里的 !command。不会发送模型请求。", "读取目录", () => run(() => rpcCatalog(probeInput("models")), setInventory));
  const checkModel = (model: CatalogModel) => ask("发送模型测试请求？", `Pi 将向 ${model.provider}/${model.id} 发送一条固定测试消息，可能产生费用。不会发送工作区内容或加载扩展。`, "发送测试", () => run(() => rpcTest({ ...probeInput("models"), provider: model.provider, id: model.id }), (value) => setNotice(`模型响应正常 · ${value.elapsedMs} ms`)));
  const mcpRaw = objectOrEmpty(text("mcp")); const localServers = isObject(mcpRaw.mcpServers) ? mcpRaw.mcpServers : {};
  const servers = effectiveMcp(project ? objectOrEmpty(snapshot?.globalMcp ?? "{}") : {}, mcpRaw);
  const providers = providerEntries(objectOrEmpty(text("models")));
  const modelsDocument = objectOrEmpty(text("models"));
  const models = modelCatalog(modelsDocument, inventory ?? subscriptions?.models ?? []);
  const modelPatterns = stringList(settings.enabledModels ?? (project ? global.enabledModels : undefined));
  const readSubscriptions = (refresh?: string) => run(() => rpcSubscriptions({ ...probeInput("models"), refresh, patterns: modelPatterns }), setSubscriptions);
  async function reloadAfterAuth() {
    if (running.current) return;
    begin(); setSubscriptions(null); setInventory(null);
    try {
      // Pi can write a device ID to global settings as part of login.
      const value = await rpcSubscriptions({ ...probeInput("models"), patterns: modelPatterns });
      if (!mounted.current) return;
      await load(scope, []);
      if (mounted.current) setSubscriptions(value);
    } catch (e) { if (mounted.current) setError(errorMessage(e)); }
    finally { finish(); }
  }
  const askSubscriptions = (refresh?: string) => ask(refresh ? "刷新订阅模型？" : "读取订阅目录？", refresh ? "Pi 会连接供应商并更新本机目录，可能刷新 OAuth 凭据。" : "Pi 将读取已保存的认证和本地目录；解析凭据可能运行已配置的 !command。", refresh ? "刷新目录" : "读取目录", () => readSubscriptions(refresh));
  function overrideModel(model: CatalogModel, key: string, value: unknown) {
    const provider = isObject(modelsDocument.providers) ? modelsDocument.providers[model.provider] : undefined;
    const entry = isObject(provider) && isObject(provider.modelOverrides) ? provider.modelOverrides[model.id] : undefined;
    const overrides = isObject(entry) ? { ...entry } : {};
    if (value === undefined) delete overrides[key]; else overrides[key] = value;
    changeProperty("models", ["providers", model.provider, "modelOverrides", model.id], Object.keys(overrides).length ? overrides : undefined);
  }
  const resources = snapshot?.resources ?? []; const packages = snapshot?.packages ?? [];
  const visibleResources = matchingResources(resources, tab === "skills" ? "skill" : "extension", search).filter((resource) => resourceFilter === "all" || (resourceFilter === "enabled") === resourceEnabled(resource));
  const settingsLocked = blocked || !writable("settings");
  const canManagePackages = !settingsLocked && !edits.includes("settings") && !edits.includes("preferences");
  const currentResource = selection.startsWith("resource:") ? resources.find((resource) => `resource:${resource.id}` === selection) : undefined;
  const currentPackage = selection.startsWith("package:") ? packages.find((pkg) => `package:${pkg.source}` === selection) : undefined;
  const name = selection.startsWith("entity:") ? selection.slice(7) : undefined;
  const rr = (id: string, label: string, options: { detail?: string; badge?: string; onPress?(): void } = {}) => <ListRow key={id} theme={theme} label={label} detail={options.detail} badge={options.badge}
    active={selection === id} disabled={blocked} onPress={options.onPress ?? (() => select(id))} />;
  const emptySearch = <Caption theme={theme}>没有匹配的条目。</Caption>;
  let list: React.ReactNode; let tools: React.ReactNode; let detail: React.ReactNode;
  if (tab === "models") {
    const visible = providers.filter(([name]) => matches(search, name));
    const provider = providers.find(([entry]) => entry === name);
    tools = <>
      <Field theme={theme} search label="搜索供应商" placeholder="搜索供应商" value={search} onChangeText={setSearch} />
      {!project && <Button label="添加供应商" theme={theme} disabled={blocked || !writable("models")} onPress={() => editEntity("provider", null, { api: "openai-completions", models: [{ id: "" }] })} />}
    </>;
    list = <>
      {rr("defaults", "默认值与模型范围")}{rr("catalog", "可用模型", { badge: String(models.length) })}{rr("subscriptions", "订阅模型", { badge: subscriptions ? String(subscriptions.providers.filter((item) => item.connected).length) : undefined })}
      <View style={{ padding: 8 }}><Caption theme={theme}>自定义供应商 · {providers.length}</Caption></View>
      {visible.map(([name, entry]) => rr(entityKey(name), name, { detail: isObject(entry) && typeof entry.api === "string" ? entry.api : undefined,
        badge: isObject(entry) && Array.isArray(entry.models) ? `${entry.models.length} 个` : undefined,
        onPress: () => project ? select(entityKey(name)) : editEntity("provider", name, isObject(entry) ? entry : {}) }))}
      {search && !visible.length ? emptySearch : null}
      {entity?.kind === "provider" && entity.originalName === null && rr("new", entity.name || "新供应商", { badge: "草稿" })}
    </>;
    if (selection === "catalog") detail = <ModelsInventory theme={theme} inventory={models} probeCatalog={inventory} project={project} settings={settings} global={global} disabled={settingsLocked} canProbe={canProbe("models")} reload={checkModels} test={checkModel} changeSettings={(change) => changeDocument("settings", change)} />;
    else if (selection === "subscriptions") detail = <Subscriptions theme={theme} catalog={subscriptions} document={modelsDocument} patterns={modelPatterns} blocked={blocked} project={project} canRead={canProbe("models")} canScope={!settingsLocked} canOverride={!project && writable("models") && !blocked}
      load={askSubscriptions} begin={async (provider, action) => (await rpcStart({ ...probeInput("models"), provider, action })).token} interact={(token, request) => rpcAuth({ token, ...request })}
      setAuthBusy={setAuthBusy} complete={() => { void reloadAfterAuth(); }}
      toggle={(ref, enabled) => { if (subscriptions) changeDocument("settings", (current) => setProperty(current, ["enabledModels"], toggleSubscriptionModel(subscriptions, modelPatterns, ref, enabled))); }}
      makeDefault={(model) => changeDocument("settings", (current) => setProperty(setProperty(current, ["defaultProvider"], model.provider), ["defaultModel"], model.id))} changeOverride={overrideModel} />;
    else if (provider || (selection === "new" && entity?.kind === "provider")) {
      const item = entity?.kind === "provider" ? entity : { kind: "provider" as const, name: name!, originalName: name!, raw: JSON.stringify(provider?.[1] ?? {}, null, 2), originalRaw: "" };
      detail = <>
        <Heading title={item.name || "添加供应商"} theme={theme} detail={project ? "在全局范围编辑供应商。" : undefined} action={item.originalName !== null && !project ? <Button label="删除供应商" theme={theme} disabled={blocked || !writable("models")} onPress={() => removeEntity("models", item.name)} /> : undefined} />
        <EntityForm key={selection} {...item} existing={item.originalName !== null} value={objectOrNull(item.raw)} theme={theme} project={project} disabled={blocked || !writable("models")}
          onName={(name) => setEntity({ ...item, name })} onRaw={(raw) => setEntity({ ...item, raw })} onValue={(next) => setEntity({ ...item, raw: JSON.stringify(next, null, 2) })} />
        {sourceButton("models", "打开 models.json")}
      </>;
    } else detail = <ModelDefaults key={doc("settings")?.revision} theme={theme} project={project} disabled={settingsLocked} settings={settings} global={global} update={(key, value) => changeProperty("settings", [key], value)} editSource={sourceButton("settings", "打开 settings.json")} />;
  } else if (tab === "skills" || tab === "plugins") {
    const skills = tab === "skills";
    const filteredPackages = packages.filter((pkg) => matches(search, pkg.source, pkg.version ?? undefined));
    const targets = skills ? visibleResources.flatMap((resource) => {
      const target = skillTarget(resource, workspaceId); return target ? [target] : [];
    }) : packages.map((pkg) => ({ ...scope, source: pkg.source }));
    const eligible = new Set(targets.filter(({ source }) => canCheckPackage(source)).map(packageKey)).size;
    const selectedTarget = currentResource ? skillTarget(currentResource, workspaceId) : undefined;
    const checkableSkill = skills && selectedTarget && canCheckPackage(selectedTarget.source) ? selectedTarget : undefined;
    tools = <>
      <Field theme={theme} search label={skills ? "搜索技能" : "搜索包或扩展"} placeholder={skills ? "搜索技能" : "搜索包或扩展"} value={search} onChangeText={setSearch} />
      <View style={row}>
        <Button label={skills ? "添加技能" : "添加插件"} theme={theme} disabled={blocked} onPress={() => openAdd("search")} />
        <Button label={skills ? "批量操作" : "检查全部插件更新"} theme={theme} disabled={blocked || (skills ? !visibleResources.length : !eligible)} onPress={() => { if (skills) setBulkOpen(true); else checkPackages(targets); }} />
        {!skills && <Button label="Pi 内置扩展" theme={theme} disabled={blocked} onPress={() => select("builtins")} />}
        {sourceButton("settings", "settings.json")}
      </View>
      <SettingsSelect label={skills ? "筛选技能" : "筛选扩展"} value={resourceFilter} options={[{ label: "全部状态", value: "all" }, { label: "已启用", value: "enabled" }, { label: "已停用", value: "disabled" }]} onValueChange={setResourceFilter} disabled={blocked} />
      {skills && <Modal open={bulkOpen} title="批量操作" onOpenChange={setBulkOpen}><Modal.Content>
        <Caption theme={theme}>当前筛选结果：{visibleResources.length} 项技能，{eligible} 个可查更新的来源。</Caption>
        <View style={row}>
          <Button label="检查技能更新" theme={theme} disabled={blocked || !eligible} onPress={() => { setBulkOpen(false); checkPackages(targets); }} />
          <Button label="启用筛选结果" theme={theme} disabled={settingsLocked || visibleResources.every(resourceEnabled)} onPress={() => { setBulkOpen(false); toggleResources(visibleResources.filter((r) => !resourceEnabled(r)), true); }} />
          <Button label="停用筛选结果" theme={theme} disabled={settingsLocked || !visibleResources.some(resourceEnabled)} onPress={() => { setBulkOpen(false); toggleResources(visibleResources.filter(resourceEnabled), false); }} />
        </View>
      </Modal.Content></Modal>}
    </>;
    list = <>
      {!skills && <>
        <View style={{ padding: 8 }}><Caption theme={theme}>当前范围的包 · {filteredPackages.length}</Caption></View>
        {filteredPackages.map((pkg) => rr(`package:${pkg.source}`, pkg.source, { detail: pkg.version ?? undefined, badge: checkBadge(versions[packageKey({ ...scope, source: pkg.source })]) ?? (pkg.enabled ? undefined : "停用") }))}
      </>}
      <View style={{ padding: 8 }}><Caption theme={theme}>{skills ? "技能" : "扩展"} · {visibleResources.length}</Caption></View>
      {visibleResources.map((resource) => {
        const target = skills ? skillTarget(resource, workspaceId) : undefined;
        return rr(`resource:${resource.id}`, resource.name, { detail: resource.packageSource ?? (resource.scope === "global" ? "全局" : "项目"), badge: (target ? checkBadge(versions[packageKey(target)]) : undefined) ?? (resourceEnabled(resource) ? undefined : "停用") });
      })}
      {!visibleResources.length && (skills || !filteredPackages.length) ? emptySearch : null}
    </>;
    if (selection === "add") detail = <>
      <Heading title={skills ? "添加技能" : "添加插件"} theme={theme} />
      <View accessibilityRole="tablist" style={row}>
        <TextTab label="查找或安装包" active={addMethod === "search"} disabled={blocked} theme={theme} onPress={() => setAddMethod("search")} />
        <TextTab label="引用本地路径" active={addMethod === "local"} disabled={blocked} theme={theme} onPress={() => setAddMethod("local")} />
      </View>
      {addMethod === "local" ? <ReferencePath key={tab} theme={theme} kind={skills ? "skills" : "extensions"} current={stringList(settings[skills ? "skills" : "extensions"])} blocked={settingsLocked} onChange={(value) => changeProperty("settings", [skills ? "skills" : "extensions"], value)} /> :
        <PackageInstall theme={theme} blocked={blocked} canAct={canManagePackages} search={(query) => rpcSearch({ query })} install={(source) => packageAction("install", source)} isInstalled={(source) => packages.some((pkg) => pkg.source === source)} />}
    </>;
    else if (!skills && selection === "builtins") detail = <>
      <Heading title="Pi 内置扩展" detail="项目中的显式规则覆盖全局。" theme={theme} />
      {["mcp", "llama.cpp", "codemode", "tool-search"].map((name) => {
        const rules = stringList(settings.extensions); const inherited = project ? stringList(global.extensions) : [];
        const rule = [...inherited, ...rules].filter((value) => value === `+builtin:${name}` || value === `-builtin:${name}`).at(-1);
        return <SettingsSwitch key={name} label={name} value={rule !== `-builtin:${name}`} disabled={settingsLocked} onValueChange={(enabled) => changeProperty("settings", ["extensions"], [...rules.filter((value) => value !== `+builtin:${name}` && value !== `-builtin:${name}`), `${enabled ? "+" : "-"}builtin:${name}`])} />;
      })}
    </>;
    else if (currentResource) detail = <ResourceDetail key={currentResource.id} theme={theme} resource={currentResource} enabled={resourceEnabled(currentResource)} blocked={blocked} canLoad={!settingsLocked} canEdit={!blocked} change={(value) => toggleResources([currentResource], value)} toggleInvocation={(value) => changeInvocation(currentResource, value)} open={() => openResource(currentResource, true)} previewText={() => openResource(currentResource)} preview={resourcePreview?.id === currentResource.id ? resourcePreview : undefined}
      update={checkableSkill ? versions[packageKey(checkableSkill)] : undefined} onCheck={checkableSkill ? () => checkPackages([checkableSkill]) : undefined}
      onUpdate={checkableSkill && checkableSkill.workspaceId === scope.workspaceId && canManagePackages ? () => packageAction("update", checkableSkill.source) : undefined} />;
    else if (currentPackage) detail = <PackageDetail key={currentPackage.source} pkg={currentPackage} theme={theme} settings={settings} resources={resources.filter((resource) => resource.packageSource === currentPackage.source && resource.scope === (project ? "project" : "global"))} blocked={settingsLocked} canAct={canManagePackages} update={versions[packageKey({ ...scope, source: currentPackage.source })]}
      onCheck={() => checkPackages([{ ...scope, source: currentPackage.source }])} onAction={(action) => packageAction(action, currentPackage.source)}
      openResource={(resource) => select(`resource:${resource.id}`, resource.kind === "skill" ? "skills" : "plugins")}
      setFilters={(key, rules) => {
        const current = Array.isArray(settings.packages) ? settings.packages : [];
        const index = current.findIndex((entry) => sourceOf(entry) === currentPackage.source); if (index < 0) return;
        const entry = current[index]; changeProperty("settings", ["packages", index], { ...(isObject(entry) ? entry : { source: currentPackage.source }), [key]: rules });
      }} />;
    else detail = <Caption theme={theme}>{skills ? "选择技能查看详情。" : project ? "选择包或扩展查看详情。全局包请在全局范围管理。" : "选择包或扩展查看详情。"}</Caption>;
  } else {
    const visible = Object.entries(servers).filter(([name, value]) => matches(search, name, isObject(value) ? `${value.command ?? ""} ${value.url ?? ""}` : undefined)
      && (resourceFilter === "all" || (resourceFilter === "disabled") === (isObject(value) && value.enabled === false)));
    const entry = name && Object.hasOwn(servers, name) && isObject(servers[name]) ? servers[name] : undefined;
    const mcpWritable = writable("mcp") && !blocked;
    tools = <>
      <Field theme={theme} search label="搜索服务器" placeholder="搜索服务器" value={search} onChangeText={setSearch} />
      <SettingsSelect label="筛选服务器" value={resourceFilter} options={[{ label: "全部状态", value: "all" }, { label: "已启用", value: "enabled" }, { label: "已停用", value: "disabled" }]} onValueChange={setResourceFilter} disabled={blocked} />
      <View style={row}><Button label="添加 MCP 服务器" theme={theme} disabled={!mcpWritable} onPress={() => { if (selection !== "add") openAdd("manual"); else setInDetail(true); }} />
        <Button label="代码模式" theme={theme} disabled={blocked} onPress={() => select("codemode")} />{sourceButton("mcp", "mcp.json")}</View>
    </>;
    list = <>
      <View style={{ padding: 8 }}><Caption theme={theme}>服务器 · {visible.length}</Caption></View>
      {visible.map(([name, value]) => {
        const entry = isObject(value) ? value : {};
        const state = edits.includes("mcp") ? undefined : Object.hasOwn(mcpResults, name) ? mcpResults[name]?.state : undefined;
        return rr(entityKey(name), name, { detail: `${project && !Object.hasOwn(localServers, name) ? "继承 · " : ""}${entry.url ? "HTTP" : entry.command ? "stdio" : "覆盖"}`,
          badge: entry.enabled === false ? "停用" : state === "connected" ? "已连接" : state === "needs-auth" ? "需认证" : state === "failed" ? "失败" : undefined,
          onPress: () => editEntity("mcp", name, isObject(localServers[name]) && Object.hasOwn(localServers, name) ? localServers[name] : entry.enabled === false ? { enabled: false } : {}) });
      })}
      {!visible.length ? emptySearch : null}
    </>;
    if (selection === "codemode") detail = <McpCodeMode theme={theme} project={project} settings={settings} global={global} mcp={mcpRaw} globalMcp={objectOrEmpty(snapshot?.globalMcp ?? "{}")}
      settingsLocked={settingsLocked} mcpLocked={!mcpWritable} changeSettings={(path, value) => changeProperty("settings", path, value)} changeMcp={(path, value) => changeProperty("mcp", path, value)} />;
    else if (selection === "add") {
      const item: EntityDraft = entity ?? { kind: "mcp", name: "", originalName: null, raw: mcpSeed, originalRaw: mcpSeed };
      detail = <>
        <Heading title="添加 MCP 服务器" theme={theme} />
        <View accessibilityRole="tablist" style={row}>
          <TextTab label="手动配置" active={addMethod === "manual"} disabled={blocked} theme={theme} onPress={() => setAddMethod("manual")} />
          <TextTab label="导入 JSON" active={addMethod === "json"} disabled={blocked} theme={theme} onPress={() => { if (stageEntity()) setAddMethod("json"); }} />
        </View>
        {addMethod === "json" ? <>
          <Caption theme={theme}>合并 mcpServers，不覆盖同名服务器。</Caption>
          <CodeInput label="要导入的 MCP JSON" text={importText} onChangeText={setImportText} theme={theme} readOnly={!mcpWritable} />
          <View style={{ alignSelf: "flex-start" }}><Button label="合并到草稿" theme={theme} disabled={!mcpWritable || !importText.trim()} onPress={() => {
            try { const value = mergeMcpImport(text("mcp"), importText); validateConfig("mcp", value, project); saveDraft("mcp", value); setImportText(""); setNotice("已合并到草稿。保存后生效。"); }
            catch (e) { setError(errorMessage(e)); }
          }} /></View>
        </> : <EntityForm {...item} existing={false} value={objectOrNull(item.raw)} project={project} theme={theme} disabled={!mcpWritable}
          onName={(name) => setEntity({ ...item, name })} onRaw={(raw) => setEntity({ ...item, raw })} onValue={(next) => setEntity({ ...item, raw: JSON.stringify(next, null, 2) })} />}
      </>;
    } else if (entry) {
      const raw = JSON.stringify(name && Object.hasOwn(localServers, name) ? localServers[name] : entry?.enabled === false ? { enabled: false } : {}, null, 2);
      const item = entity?.kind === "mcp" ? entity : { kind: "mcp" as const, name: name!, originalName: name!, raw, originalRaw: raw };
      const probe = name && Object.hasOwn(mcpResults, name) ? mcpResults[name] : undefined;
      const resultIsSaved = edits.includes("mcp") || entityDirty;
      detail = <>
        <Heading title={item.name || "添加 MCP 服务器"} theme={theme} detail={name && project && !Object.hasOwn(localServers, name) ? "修改启用状态或工具规则会创建项目覆盖。" : undefined} action={name && Object.hasOwn(localServers, name) ? <Button label="删除服务器" theme={theme} disabled={!mcpWritable} onPress={() => removeEntity("mcp", name)} /> : undefined} />
        {name && !project && <View style={row}><Button label="测试连接" theme={theme} disabled={!canProbe("mcp") || entry?.enabled === false} onPress={() => ask("测试 MCP 连接？", "Pi 会运行该服务器的 stdio 命令或连接到它的 HTTP 地址，并列出工具。仅使用保存的全局条目，不复用 OAuth 凭据。", "开始测试", () => run(() => rpcProbe({ ...probeInput("mcp"), name }), (value) => setMcpResults((old) => ({ ...old, [name]: value }))))} />
          {probe && <Caption theme={theme}>{resultIsSaved ? "保存前的测试：" : ""}{probe.state === "connected" ? `连接成功 · ${probe.tools.length} 个工具` : probe.state === "needs-auth" ? "需要认证。此测试不复用 OAuth 凭据，请在宿主的 Pi CLI 中登录并验证连接。" : "连接失败。请检查服务地址、命令和凭据。"}</Caption>}
        </View>}
        {probe?.state === "connected" && probe.tools.length > 0 && <Caption theme={theme} selectable>{probe.tools.join(" · ")}</Caption>}
        <EntityForm key={selection} {...item} existing={item.originalName !== null} value={objectOrNull(item.raw)} project={project} theme={theme} disabled={!mcpWritable} tools={probe?.tools}
          onName={(name) => setEntity({ ...item, name })} onRaw={(raw) => setEntity({ ...item, raw })} onValue={(next) => setEntity({ ...item, raw: JSON.stringify(next, null, 2) })} />
      </>;
    } else detail = <Caption theme={theme}>选择服务器查看配置。{project ? "连接测试在全局范围进行。" : "保存配置不会启动服务器。"}</Caption>;
  }
  const relevant = tab === "models" ? ["models", "settings"] as const : tab === "mcp" ? ["mcp", "settings"] as const : ["settings"] as const;
  const invalid = relevant.filter((kind) => doc(kind)?.error);
  return <View style={{ flex: 1, minHeight: 0, backgroundColor: c.surface0 }}>
    <View style={{ paddingHorizontal: layout.compact ? 10 : 16, borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.surface1 }}>
      <View style={{ ...row, justifyContent: "space-between", paddingVertical: 6 }}>
        <View style={{ flex: layout.compact ? undefined : 1, width: layout.compact ? "100%" : undefined, minWidth: 96 }}><Heading theme={theme} title="Pi 设置" detail={layout.compact ? undefined : host.label} /></View>
        <Pressable accessibilityRole="button" accessibilityLabel="全局 / 项目工作区" accessibilityState={{ disabled: blocked || dirty, expanded: scopeOpen }} disabled={blocked || dirty}
          onPress={() => setScopeOpen(true)} style={{ flex: layout.compact ? 1 : undefined, minWidth: layout.compact ? 140 : 235, maxWidth: layout.compact ? undefined : 535, flexShrink: 1, minHeight: 34, paddingHorizontal: 8, paddingVertical: 5, borderWidth: 1, borderColor: c.border, borderRadius: 5, justifyContent: "center", opacity: blocked || dirty ? 0.6 : 1 }}>
          <Text style={{ color: c.foreground, fontSize: 13 }}>{workspaceId ? `项目 · ${workspaces.find((w) => w.id === workspaceId)?.name ?? workspaceId}` : "全局范围"} ▾</Text>
        </Pressable>
        <Modal open={scopeOpen} title="全局 / 项目工作区" onOpenChange={setScopeOpen}><Modal.Content>
          {[{ id: "", name: "全局范围", directory: "" }, ...workspaces].map((workspace) => <Pressable key={workspace.id} accessibilityRole="button" accessibilityLabel={workspace.name} accessibilityState={{ selected: workspace.id === workspaceId }}
            onPress={() => { setScopeOpen(false); if (workspace.id === workspaceId) return; setEntity(null); setWorkspaceId(workspace.id); setSelection(empty[tab]); setInDetail(false); setSearch(""); setResourceFilter("all"); setImportText(""); setNotice(null); }}
            style={{ paddingHorizontal: 8, paddingVertical: 6, borderRadius: 5, backgroundColor: workspace.id === workspaceId ? c.surface2 : undefined }}>
            <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "500" }}>{workspace.name}</Text>
            {workspace.directory ? <Caption theme={theme}>{workspace.directory}</Caption> : null}
          </Pressable>)}
        </Modal.Content></Modal>
        <Button label="刷新" theme={theme} disabled={blocked} onPress={() => {
          if (dirty) ask("放弃未保存的草稿？", "此操作仅丢弃本页草稿，然后重新读取配置。", "放弃草稿并重新读取", () => { setEntity(null); setSelection(empty[tab]); setInDetail(false); void load(); });
          else void load();
        }} />
      </View>
      <View style={{ ...row, gap: 4 }}>{tabs.map((item) => <TextTab key={item.value} label={item.label} active={tab === item.value} disabled={blocked} theme={theme} onPress={() => switchTab(item.value)} />)}</View>
    </View>
    {snapshot && snapshot.warnings.length > 0 && <ConfigWarnings key={`${workspaceId}:${snapshot.agentDir}`} warnings={snapshot.warnings} theme={theme} layout={layout} />}
    {error && <Text accessibilityRole="alert" selectable style={{ color: c.statusDanger, paddingHorizontal: 12, paddingVertical: 8 }}>{error}</Text>}
    {invalid.map((kind) => <View key={kind} style={{ ...row, paddingHorizontal: 12, paddingVertical: 5 }}><View style={{ flex: 1, minWidth: 120 }}><Caption theme={theme}>{doc(kind)?.error}</Caption></View>{sourceButton(kind, "修复原始配置")}</View>)}
    {snapshot ? <Pane theme={theme} compact={layout.compact} inDetail={inDetail} onBack={() => { if (!blocked && stageEntity()) setInDetail(false); }} tools={tools} list={list} detail={detail} revision={`${tab}:${selection}`} /> :
      <View style={{ flex: 1, padding: 16 }}><Caption theme={theme}>{loading ? "正在读取配置…" : "无法读取配置。请刷新重试。"}</Caption></View>}
    <View style={{ ...row, justifyContent: "space-between", paddingHorizontal: layout.compact ? 10 : 16, paddingVertical: 8, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.surface1 }}>
      <View style={{ flex: 1, minWidth: 112 }}><Text accessibilityLiveRegion="polite" numberOfLines={2} style={{ fontSize: 12, color: notice ? c.statusSuccess : c.foregroundMuted }}>{busy ? "正在处理…" : notice ?? (dirty ? "有未保存的草稿" : project ? snapshot?.directory ?? "项目范围" : "全局范围")}</Text></View>
      {entityDirty && <Button label="撤销条目编辑" theme={theme} disabled={blocked} onPress={() => { setEntity(null); setError(null); if (selection === "new") { setSelection(empty[tab]); setInDetail(false); } }} />}
      <Button label="保存" theme={theme} disabled={blocked || !dirty} onPress={saveAll} primary />
    </View>
    <Modal open={editor !== null && !preview} title={editor?.resource ? "编辑技能" : "编辑原始配置"} onOpenChange={(open) => { if (!open && !busy && editor?.text === editor?.original) setEditor(null); }}>
      <Modal.Content>
        <Caption theme={theme} selectable>{editor?.title}</Caption>
        <Caption theme={theme}>{editor?.resource ? "保存会修改技能源文件。" : "原始配置可能含凭据；不要共享屏幕。"}</Caption>
        {editor && <CodeInput text={editor.text} theme={theme} readOnly={busy} onChangeText={(text) => setEditor({ ...editor, text })} />}
        {error && <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>{error}</Text>}
        <View style={row}>
          <Button label="放弃编辑" theme={theme} disabled={busy} onPress={() => setEditor(null)} />
          <Button label={editor?.resource ? "保存技能" : "加入草稿"} theme={theme} disabled={busy || editor?.text === editor?.original} primary onPress={() => {
            if (!editor) return;
            if (editor.kind) { saveDraft(editor.kind, editor.text); setEditor(null); }
            else if (editor.resource) void prepare(() => rpcPrepareResource({ ...scope, id: editor.resource!.id, text: editor.text, revision: editor.revision }));
          }} />
        </View>
      </Modal.Content>
    </Modal>
    <Modal open={confirmation !== null} title={confirmation?.title ?? "确认操作"} onOpenChange={(open) => { if (!open) setConfirmation(null); }}>
      <Modal.Content><Caption theme={theme}>{confirmation?.message}</Caption><View style={row}>
        <Button label="取消" theme={theme} onPress={() => setConfirmation(null)} />
        {confirmation && <Button label={confirmation.label} theme={theme} onPress={confirmation.run} primary />}
      </View></Modal.Content>
    </Modal>
    <DiffModal preview={preview} theme={theme} busy={busy} error={error} onCancel={() => { void cancelPreview(); }} onCommit={() => { if (preview && !running.current) void apply(preview, true); }} />
  </View>;
}

function TextTab({ label, active, disabled, theme, onPress }: { label: string; active: boolean; disabled: boolean; theme: PluginSurfaceProps["theme"]; onPress(): void }) {
  const c = theme.colors;
  return <Pressable accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected: active, disabled }} disabled={disabled} onPress={onPress} style={{ minHeight: 36, justifyContent: "center", paddingHorizontal: 10, borderBottomWidth: 2, borderBottomColor: active ? c.accent : "transparent" }}>
    <Text style={{ color: active ? c.foreground : c.foregroundMuted, fontSize: 13, fontWeight: active ? "600" : "400" }}>{label}</Text>
  </Pressable>;
}
