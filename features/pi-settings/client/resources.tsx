import { useState } from "react";
import { View } from "react-native";
import { SettingsSwitch } from "@getpaseo/plugin/client/ui";
import type { PackageRequest, PackageUpdate, RegistryPackage, Resource, Snapshot } from "../shared/contracts";
import { isObject, resourceTypes, sourceOf, stringList, type JsonObject } from "../shared/config";
import { canCheckPackage, npmName } from "../shared/management";
import { Button, CodeInput } from "./components";
import { Caption, Field, Heading, ListRow, matches, row, type Theme } from "./layout";

function UpdateStatus({ result, theme }: { result: PackageUpdate; theme: Theme }) {
  const short = (value: string | null) => value?.match(/^[a-f0-9]{40}$/) ? value.slice(0, 8) : value ?? "未知";
  return <Caption theme={theme}>{result.message ?? (result.state === "current" ? `已与远端一致 · ${short(result.installed)}` : `已安装 ${short(result.installed)} → 远端 ${short(result.remote)}`)}</Caption>;
}

export function ResourceDetail({ resource, theme, enabled, change, toggleInvocation, blocked, canEdit, canLoad, preview, open, previewText, update, onCheck, onUpdate }: {
  resource: Resource; theme: Theme; enabled: boolean; change(value: boolean): void; toggleInvocation(value: boolean): void;
  blocked: boolean; canEdit: boolean; canLoad: boolean; preview?: { text: string }; open(): void; previewText: () => void;
  update?: PackageUpdate; onCheck?(): void; onUpdate?(): void;
}) {
  return <>
    <Heading title={resource.name} theme={theme} detail={resource.path} />
    <Caption theme={theme} selectable>{resource.scope === "project" ? "项目" : "全局"}{resource.packageSource ? ` · ${resource.packageSource}` : " · 本地文件"}</Caption>
    {resource.description ? <Caption theme={theme} selectable>{resource.description}</Caption> : null}
    <SettingsSwitch label="在当前范围加载" disabled={!canLoad} value={enabled} onValueChange={change} />
    {resource.kind === "skill" && <SettingsSwitch label="允许模型自动调用" hint="更改源文件，影响该技能的所有使用者。" value={resource.modelInvocation} disabled={!canEdit} onValueChange={toggleInvocation} />}
    <View style={row}>
      <Button label={preview ? "重新读取内容" : "预览内容"} theme={theme} disabled={blocked} onPress={previewText} />
      {resource.kind === "skill" && <Button label="编辑技能" theme={theme} disabled={blocked} onPress={open} />}
      {onCheck && <Button label="检查更新" theme={theme} disabled={blocked} onPress={onCheck} />}
      {onUpdate && update?.state === "different" && <Button label="准备更新来源包" theme={theme} disabled={blocked} onPress={onUpdate} />}
    </View>
    {update && <UpdateStatus result={update} theme={theme} />}
    {preview && <CodeInput label="资源内容" text={preview.text} onChangeText={() => {}} theme={theme} readOnly />}
  </>;
}

export function PackageDetail({ pkg, theme, settings, resources, blocked, canAct, update, onCheck, onAction, openResource, setFilters }: {
  pkg: Snapshot["packages"][number]; theme: Theme; settings: JsonObject; resources: Resource[]; blocked: boolean; canAct: boolean; update?: PackageUpdate;
  onCheck(): void; onAction(action: PackageRequest["action"]): void; openResource(resource: Resource): void; setFilters(key: string, rules: string[] | undefined): void;
}) {
  const name = npmName(pkg.source);
  const [filtersOpen, showFilters] = useState(false);
  const [filterDraft, editFilters] = useState<Partial<Record<typeof resourceTypes[number], string>>>({});
  const configured = Array.isArray(settings.packages) ? settings.packages.find((entry) => sourceOf(entry) === pkg.source) : undefined;
  return <>
    <Heading theme={theme} title={pkg.source} detail={pkg.path ?? "已声明，未找到安装目录"} />
    {update ? <UpdateStatus result={update} theme={theme} /> : <Caption theme={theme}>已安装：{pkg.version ?? "未知"}</Caption>}
    <SettingsSwitch label="启用此包" hint="停用保留文件和筛选规则。" value={pkg.enabled} disabled={!canAct} onValueChange={(value) => onAction(value ? "enable" : "disable")} />
    <View style={row}>
      {canCheckPackage(pkg.source) && <Button label="检查版本" theme={theme} disabled={blocked} onPress={onCheck} />}
      {/^(npm:|git:|https:\/\/)/.test(pkg.source) && <Button label="准备更新" theme={theme} disabled={!canAct} onPress={() => onAction("update")} />}
      {/^(npm:|git:|https:\/\/)/.test(pkg.source) && <Button label="准备卸载" theme={theme} disabled={!canAct} onPress={() => onAction("remove")} />}
    </View>
    {!name && pkg.source.startsWith("npm:") && <Caption theme={theme}>固定版本不会自动升级；可在安装页指定新版本。</Caption>}
    {!/^(npm:|git:|https:\/\/)/.test(pkg.source) && <Caption theme={theme}>本地包可在 settings.json 中移除引用，文件不会被删除。</Caption>}
    <Heading theme={theme} title="已发现的资源" detail={`${resources.length} 项技能或扩展`} />
    {resources.map((resource) => <ListRow key={resource.id} theme={theme} label={resource.name} detail={resource.kind === "skill" ? "技能" : "扩展"} badge={resource.enabled ? "启用" : "停用"} onPress={() => openResource(resource)} />)}
    <View style={{ alignSelf: "flex-start" }}><Button label={filtersOpen ? "收起资源筛选" : "编辑资源筛选"} theme={theme} onPress={() => { if (!filtersOpen) editFilters({}); showFilters(!filtersOpen); }} /></View>
    {filtersOpen && <>
      <Caption theme={theme}>以逗号分隔 Pi 匹配规则。留空恢复默认加载，填写 [] 排除此类资源。</Caption>
      {resourceTypes.map((key) => <Field key={key} label={key} theme={theme} disabled={blocked || !pkg.enabled} value={filterDraft[key] ?? (isObject(configured) && Array.isArray(configured[key]) ? stringList(configured[key]).join(", ") || "[]" : "")} onChangeText={(value) => {
        editFilters((previous) => ({ ...previous, [key]: value }));
        setFilters(key, !value.trim() ? undefined : value.trim() === "[]" ? [] : value.split(",").map((part) => part.trim()).filter(Boolean));
      }} />)}
    </>}
  </>;
}

export function PackageInstall({ theme, blocked, canAct, search, install, isInstalled }: {
  theme: Theme; blocked: boolean; canAct: boolean; search(value: string): Promise<RegistryPackage[]>; install(source: string): void; isInstalled(source: string): boolean;
}) {
  const [query, setQuery] = useState(""); const [source, setSource] = useState("");
  const [results, setResults] = useState<RegistryPackage[] | null>(null);
  const [searching, setSearching] = useState(false); const [error, setError] = useState<string>();
  const look = async () => {
    if (searching || blocked || query.length > 100) return;
    setSearching(true); setError(undefined); setResults(null);
    try { setResults(await search(query)); }
    catch (e) { setError(e instanceof Error ? e.message : "搜索失败。"); }
    finally { setSearching(false); }
  };
  return <>
    <Heading theme={theme} title="安装 Pi 包" detail="一个 Pi 包可包含技能、扩展、提示词和主题。" />
    <Field label="搜索 npm 上的 Pi 包" placeholder="按包名或关键词搜索" theme={theme} value={query} onChangeText={setQuery} onSubmit={() => { void look(); }}
      action={<Button label={searching ? "搜索中…" : "搜索 npm"} theme={theme} disabled={searching || blocked || query.length > 100} onPress={() => { void look(); }} />} />
    {error && <Caption theme={theme}>{error}</Caption>}
    {results?.length === 0 && <Caption theme={theme}>没有匹配的包。</Caption>}
    {results?.map((pkg) => <View key={pkg.name} style={{ ...row, borderBottomWidth: 1, borderBottomColor: theme.colors.border, paddingBottom: 7 }}>
      <View style={{ flex: 1, minWidth: 130 }}><Caption theme={theme} selectable>{pkg.name} · {pkg.version}</Caption>{pkg.description ? <Caption theme={theme}>{pkg.description}</Caption> : null}</View>
      <Button label={isInstalled(`npm:${pkg.name}`) ? "已配置" : `准备安装 ${pkg.name}`} theme={theme} disabled={!canAct || isInstalled(`npm:${pkg.name}`)} onPress={() => install(`npm:${pkg.name}`)} />
    </View>)}
    <Field label="npm / Git 源" placeholder="npm:@scope/pi-tools 或 git:github.com/user/repo@tag" theme={theme} value={source} onChangeText={setSource} disabled={blocked}
      action={<Button label="下载并准备安装" theme={theme} disabled={!canAct || !source.trim()} onPress={() => install(source.trim())} />} />
    <Caption theme={theme}>暂存不会执行 npm 安装脚本。安装的扩展会在 Pi 加载时运行，只安装信任的代码。</Caption>
  </>;
}

export function ReferencePath({ theme, blocked, kind, current, onChange }: { theme: Theme; blocked: boolean; kind: "skills" | "extensions"; current: string[]; onChange(value: string[]): void }) {
  const [path, setPath] = useState("");
  const value = path.trim(); const valid = !!value && !/^[+!\-]|[\n\r\x00]/.test(value) && !current.includes(value);
  const refs = current.filter((item) => !/^[+!\-]/.test(item));
  const label = kind === "skills" ? "技能" : "扩展";
  return <>
    <Heading theme={theme} title={`本地${label}引用`} detail="使用宿主路径；相对路径以当前配置的 .pi 目录为基准。" />
    <Field label={`${label}路径`} placeholder={kind === "skills" ? "~/skills/my-skill/SKILL.md" : "./extensions/my-extension.ts"} theme={theme} value={path} onChangeText={setPath} disabled={blocked}
      action={<Button label="添加路径引用" theme={theme} disabled={blocked || !valid} onPress={() => { onChange([...current, value]); setPath(""); }} />} />
    {refs.map((item, index) => <View key={`${item}:${index}`} style={row}><View style={{ flex: 1, minWidth: 120 }}><Caption theme={theme} selectable>{item}</Caption></View><Button label={`移除引用 ${item}`} theme={theme} disabled={blocked} onPress={() => onChange(current.filter((entry) => entry !== item))} /></View>)}
  </>;
}

export const matchingResources = (resources: Resource[], kind: Resource["kind"], query: string) => resources.filter((resource) => resource.kind === kind && matches(query, resource.name, resource.path, resource.packageSource, resource.description));
