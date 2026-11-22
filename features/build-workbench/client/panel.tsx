import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon, Loading } from "@getpaseo/plugin/client/ui";
import { formatArguments, parseArguments } from "../shared/arguments";
import * as rpc from "../shared/contracts";
import type { Candidate, Command, Configuration, Run, Saved, Target } from "../shared/contracts";
import { Badge, Button, Caption, Choice, Code, CommandPreview, Field, Heading, Notice, PaneHead, Region, Tab, Tabs, errorMessage, styles } from "./panel-ui.tsx";
import type { Colors } from "./panel-ui.tsx";
import { ResizeHandle, RunDock } from "./run-dock.tsx";
import type { DetailTab } from "./run-dock.tsx";
import { defaultTool, limitDock, ProbeCompletions } from "./workbench-state";
import { useDiscovery } from "./use-discovery";

type Plan = { command: Command; fingerprint: string };
type ToolList = { candidates: Candidate[]; requirement: string; issues: string[]; selected?: string };
type Area = "targets" | "config" | "tools";
const areas = { targets: "目标", config: "配置", tools: "工具链" };
const family: Record<rpc.Adapter, string> = { npm: "npm", pnpm: "pnpm", cargo: "Cargo", cmake: "CMake", tauri: "Tauri", gradle: "Gradle", xcode: "Xcode" };
const projectLabel = (target: rpc.TargetKey) => `${family[target.adapter]} · ${target.project === "." ? "根目录" : target.project}`;
const examples: Record<rpc.Adapter, string[]> = {
  npm: ["--mode staging"], pnpm: ["--mode staging"], cargo: ["--release", "--all-features", "--profile dev"],
  cmake: ["--parallel 4", "--config Release"], tauri: ["--release", "-- --locked"],
  gradle: ["--stacktrace", "--parallel --max-workers 4", "--refresh-dependencies"], xcode: ["-configuration Release", "-showBuildTimingSummary"],
};
function optionInput(text: string) {
  try {
    const argv = parseArguments(text);
    if (!rpc.config.shape.options.safeParse(argv).success) return { error: "最多 64 个选项，每项不超过 4096 字符，且不能包含控制字符。" };
    return { argv };
  } catch (error) { return { error: errorMessage(error) }; }
}
const blank = { options: "", artifacts: "", name: "", named: "", tool: undefined as string | undefined, optionsTouched: false };

export function BuildPanel(props: PluginWorkspacePanelProps) {
  return <Workbench key={JSON.stringify([props.host.id, props.workspaceId])} {...props} />;
}

function Workbench({ workspaceId, layout, theme: { colors } }: PluginWorkspacePanelProps) {
  const getTools = useRpc(rpc.tools);
  const verify = useRpc(rpc.verify);
  const selectTool = useRpc(rpc.selectTool);
  const getPreview = useRpc(rpc.preview);
  const save = useRpc(rpc.save);
  const remove = useRpc(rpc.remove);
  const start = useRpc(rpc.start);
  const list = useRpc(rpc.list);
  const retry = useRpc(rpc.retry);
  const stop = useRpc(rpc.stop);
  const discovery = useDiscovery(workspaceId);
  const { refresh } = discovery;
  const [updates, updateRuns] = useState(0);
  const [runs, setRuns] = useState<Run[]>([]);
  const completions = useRef(new ProbeCompletions());
  const [runId, setRunId] = useState("");
  const [detailTab, setDetailTab] = useState<DetailTab>("output");
  const [connection, setConnection] = useState("");
  const [selection, select] = useState("");
  const [search, setSearch] = useState("");
  const [onlyNew, showOnlyNew] = useState(false);
  const [nav, setNav] = useState<"targets" | "saved">("targets");
  const [area, setArea] = useState<Area>("targets");
  const [draft, setDraft] = useState(blank);
  const [expanded, setExpanded] = useState(false);
  const [toolRevision, reloadTools] = useState(0);
  const [automaticTool, setAutomaticTool] = useState<{ selection: string; id: string }>();
  const [available, setAvailable] = useState<{ key: string; value?: ToolList; error?: string }>();
  const [checkError, setCheckError] = useState("");
  const [preview, setPreview] = useState<{ key: string; plan?: Plan; error?: string; field?: "options" | "artifacts" }>();
  const [confirmation, setConfirmation] = useState<{ key?: string; plan: Plan; id?: string }>();
  const [actionError, setActionError] = useState("");
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [{ width, height }, setSize] = useState({ width: 0, height: 0 });
  const [dockHeight, setDockHeight] = useState<number>();
  const compact = layout.compact || (width > 0 && width <= 880);
  const tight = width > 0 && width <= 530;
  const navWidth = compact ? Math.max(108, Math.min(170, Math.round(width * 0.34))) : Math.max(214, Math.min(336, Math.round(width * 0.23)));
  const toolsWidth = Math.max(246, Math.min(390, Math.round(width * 0.26)));
  const upperAndDock = Math.max(0, height - 58 - (compact ? 37 : 0));
  const minDock = Math.min(104, Math.floor(upperAndDock * 0.45));
  const maxDock = Math.max(minDock, Math.min(Math.floor(upperAndDock * 0.62), upperAndDock - 156));
  const dock = limitDock(dockHeight ?? (height <= 550 ? 104 : limitDock(Math.round(height * 0.23), 125, 242)), minDock, maxDock);
  const selected = discovery.result?.targets.find((item) => rpc.targetId(item) === selection);
  const toolsKey = JSON.stringify([selection, discovery.revision, toolRevision]);
  const currentTools = available?.key === toolsKey && selected ? available : undefined;
  const tools = currentTools?.value;
  const tool = draft.tool ?? (automaticTool?.selection === selection ? automaticTool.id : tools ? defaultTool(tools.candidates, tools.selected) : "");
  const actual = tools?.candidates.find((item) => item.id === tool);
  const suggestedOptions = actual?.probeOptions?.length ? formatArguments(actual.probeOptions) : "";
  const options = draft.optionsTouched ? draft.options : suggestedOptions;
  const parsed = useMemo(() => optionInput(options), [options]);
  const artifacts = useMemo(() => draft.artifacts.split("\n").map((line) => line.trim()).filter(Boolean), [draft.artifacts]);
  const artifactError = !rpc.config.shape.artifacts.safeParse(artifacts).success ? "最多 8 条产物路径，每条不超过 1024 字符。" : undefined;
  const configuration = useMemo<Configuration | undefined>(() => selected && actual && parsed.argv && !artifactError
    ? { target: { adapter: selected.adapter, project: selected.project, name: selected.name }, tool, options: parsed.argv, artifacts } : undefined,
    [selected, actual, parsed, artifactError, tool, artifacts]);
  const planKey = configuration && JSON.stringify([toolsKey, configuration]);
  const currentPreview = preview?.key === planKey ? preview : undefined;
  const plan = currentPreview?.plan;
  const pathError = artifactError ?? (currentPreview?.field === "artifacts" ? currentPreview.error : undefined);
  const previewError = currentPreview?.field ? undefined : currentPreview?.error;
  const confirm = confirmation && (confirmation.id ? confirmation.id === runId : confirmation.key === planKey && !!planKey) ? confirmation : undefined;
  const current = runs.find((row) => row.id === runId);
  const action = !busy && !connection;
  const blocked = busy ? "正在提交操作" : connection ? "无法读取运行状态" : discovery.busy ? "正在刷新目标"
    : !selected ? (selection ? "原目标已失效，请重新选择" : "请先选择目标") : selected.blocked
      || (currentTools?.error ? "无法读取工具链，请重试" : !tools ? "正在查找工具链" : undefined)
      || (!actual ? (tool ? "所选工具已失效，请重新选择" : "请选择可用的工具") : undefined)
      || (actual?.gradleRuntime?.status === "incompatible" ? "所选 Java 不兼容" : undefined)
      || (parsed.error || artifactError || currentPreview?.field ? "请修正配置中的字段错误" : undefined)
      || (!actual?.version ? "请先检查所选工具" : undefined)
      || (previewError ? "命令预览失败" : undefined) || (!plan ? "正在准备命令预览" : "");

  useEffect(() => { if (pathError) setExpanded(true); }, [pathError]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const rows = await list({ workspaceId });
        if (cancelled) return;
        setRuns(rows); setConnection("");
        const probes = completions.current.observe(rows);
        if (probes.length) refresh(probes);
      } catch (error) { if (!cancelled) setConnection(errorMessage(error)); }
      if (!cancelled) timer = setTimeout(poll, 1200);
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [list, workspaceId, updates, refresh]);
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    getTools({ workspaceId, target: selected }).then((value) => {
      if (cancelled) return;
      setAvailable({ key: toolsKey, value });
      const id = defaultTool(value.candidates, value.selected);
      if (id) setAutomaticTool((old) => old?.selection === selection ? old : { selection, id });
    }, (error) => { if (!cancelled) setAvailable({ key: toolsKey, error: errorMessage(error) }); });
    return () => { cancelled = true; };
  }, [selected, selection, getTools, workspaceId, toolsKey]);
  useEffect(() => {
    if (!configuration || !planKey || actual?.gradleRuntime?.status === "incompatible") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void getPreview({ workspaceId, configuration }).then((result) => {
        if (!cancelled) setPreview(result.kind === "invalid" ? { key: planKey, error: result.message, field: result.field } : { key: planKey, plan: result });
      }, (error) => { if (!cancelled) setPreview({ key: planKey, error: errorMessage(error) }); });
    }, 220);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [configuration, planKey, actual?.gradleRuntime?.status, getPreview, workspaceId]);

  function perform(task: () => Promise<void>, onError = (message: string) => { setActionError(message); setArea("config"); }) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true); setActionError("");
    void task().catch((error) => onError(errorMessage(error))).finally(() => { lock.current = false; setBusy(false); });
  }
  function submitted(run: Run) {
    completions.current.watch(run);
    setRuns((rows) => [run, ...rows.filter((row) => row.id !== run.id)]);
    setConfirmation(undefined); setRunId(run.id); setDetailTab("output"); updateRuns((x) => x + 1);
  }
  async function submit(next: Plan, id?: string) {
    const result = id ? await retry({ workspaceId, id, fingerprint: next.fingerprint })
      : configuration && await start({ workspaceId, configuration, fingerprint: next.fingerprint });
    if (!result) return;
    if (result.kind === "changed") { setConfirmation({ key: planKey, plan: result, id }); return; }
    submitted(result.run);
  }
  function changeDraft(update: Partial<typeof blank>) {
    if (lock.current) return;
    setDraft((old) => ({ ...old, ...update })); setConfirmation(undefined); setActionError("");
  }
  function openTarget(target: Target | Saved["target"], saved?: Saved) {
    if (lock.current) return;
    if (!saved && selection === rpc.targetId(target)) { setArea("config"); return; }
    if (selection !== rpc.targetId(target)) setAutomaticTool(undefined);
    select(rpc.targetId(target)); setCheckError(""); setActionError(""); setConfirmation(undefined);
    setDraft(saved ? { tool: saved.tool, options: formatArguments(saved.options), artifacts: saved.artifacts.join("\n"), name: saved.name, named: saved.name, optionsTouched: true } : blank);
    setExpanded(false);
    if (saved) setSearch("");
    if (saved || !("operation" in target) || target.operation !== "probe") showOnlyNew(false);
    setArea("config");
  }
  function checkTool() {
    if (!selected || !actual) return;
    setCheckError("");
    perform(async () => {
      try { await verify({ workspaceId, configuration: { target: selected, tool, options: [], artifacts: [] } }); }
      finally { reloadTools((n) => n + 1); }
    }, setCheckError);
  }
  function retryRun() {
    if (!current) return;
    perform(async () => {
      const result = await retry({ workspaceId, id: current.id, previewOnly: current.configuration.target.adapter === "gradle" });
      if (result.kind === "started") submitted(result.run);
      else { setConfirmation({ id: current.id, plan: result }); setArea("config"); }
    });
  }
  const all = discovery.result?.targets ?? [];
  const view = useMemo(() => {
    const ids = new Set(discovery.feedback?.added);
    const stacks = new Set<rpc.Adapter>();
    const buildProjects = new Set(all.filter((item) => !item.operation).map(projectLabel));
    const groups = new Map<string, Target[]>();
    const viewingNew = onlyNew && all.some((target) => ids.has(rpc.targetId(target)));
    const query = search.trim().toLowerCase();
    for (const target of all) {
      stacks.add(target.adapter);
      const group = projectLabel(target);
      if (viewingNew && !ids.has(rpc.targetId(target))) continue;
      if (!`${group} ${target.name} ${target.source}`.toLowerCase().includes(query)) continue;
      const rows = groups.get(group) ?? [];
      rows.push(target);
      groups.set(group, rows);
    }
    return { ids, stacks: [...stacks].map((stack) => family[stack]), buildProjects, groups, viewingNew };
  }, [all, search, onlyNew, discovery.feedback]);
  const suggestions = !selected ? [] : selected.operation && selected.adapter === "cmake" ? ['-DCMAKE_BUILD_TYPE=Release', '-G "Unix Makefiles"']
    : selected.operation && selected.adapter === "xcode" ? ["-verbose"]
      : selected.operation && selected.adapter === "gradle" ? ["--offline", "--workbench-task-filter=:模块:", "--workbench-task-filter=assembleDebug"] : examples[selected.adapter];
  const setOptions = (value: string) => changeDraft({ options: value, optionsTouched: true });
  const nameError = draft.name.trim().length > 64 ? "配置名称最多 64 个字符。" : undefined;
  const refreshLabel = discovery.busy ? "正在刷新目标" : discovery.failure ? "重试刷新" : "刷新目标";
  const inspectTools = !!selected && !selected.blocked && (!actual?.version || actual.gradleRuntime?.status === "incompatible" || !!currentTools?.error);
  const newAvailable = !discovery.busy && !discovery.failure && !view.viewingNew && all.some((target) => view.ids.has(rpc.targetId(target)));
  const showNew = () => { setSearch(""); showOnlyNew(true); setNav("targets"); setArea("targets"); };
  const showTargets = () => { setNav("targets"); setArea("targets"); };
  const primaryShowsNew = newAvailable && !!selected?.operation && !blocked && !confirm;
  const status = blocked || (confirm ? "请核对并确认命令" : discovery.feedback && selected?.operation ? "目标已刷新" : "可运行");
  const statusTone = blocked || confirm ? colors.statusWarning : colors.statusSuccess;
  const stack = selected ? family[selected.adapter] : view.stacks.join(" / ") || "构建工作台";
  const savedDraft = discovery.saved.some((row) => row.name === draft.name.trim() && configuration && rpc.targetId(row.target) === selection &&
    row.tool === configuration.tool && formatArguments(row.options) === formatArguments(configuration.options) && row.artifacts.join("\n") === artifacts.join("\n"));

  return <View style={[local.root, { backgroundColor: colors.surface0 }]} onLayout={({ nativeEvent: { layout: size } }) => setSize((old) => old.width === size.width && old.height === size.height ? old : { width: size.width, height: size.height })}>
    <View style={[local.toolbar, tight && local.toolbarTight, { borderColor: colors.border, backgroundColor: colors.surface1 }]}>
      <View style={[styles.inline, local.breadcrumb]}>
        <Text numberOfLines={1} style={[styles.label, local.stack, { color: colors.foregroundMuted }]}>{stack}</Text>
        {selected ? <>
          <Icon name="ChevronRight" size={13} color={colors.foregroundMuted} />
          <Text numberOfLines={1} style={[styles.mono, local.breadcrumbName, { color: colors.foreground }]}>{selected.name}</Text>
        </> : null}
      </View>
      <View style={styles.inline}>
        <Icon name={blocked || confirm ? "TriangleAlert" : "Check"} size={14} color={statusTone} />
        <Text selectable accessibilityLiveRegion="polite" style={[styles.wrapText, local.status, tight && local.statusTight, { color: statusTone }]}>{status}</Text>
      </View>
      <Button colors={colors} label={primaryShowsNew ? "查看新目标" : selected?.operation ? "执行探测" : selected?.adapter === "gradle" ? "预览并构建" : "构建目标"}
        icon={tight ? undefined : primaryShowsNew ? "ChevronRight" : "Play"} primary disabled={!!blocked || !!confirm} onPress={() => {
          if (primaryShowsNew) { showNew(); return; }
          if (!plan) return;
          if (selected?.adapter === "gradle" && !selected.operation) { setConfirmation({ key: planKey, plan }); setArea("config"); }
          else perform(() => submit(plan));
        }} />
    </View>
    {compact ? <PaneHead colors={colors} bar><Tabs fill label="工作区分区">
      {(Object.keys(areas) as Area[]).map((key) => <Tab key={key} fill colors={colors} label={areas[key]} active={area === key} onPress={() => setArea(key)} />)}
    </Tabs></PaneHead> : null}
    <View style={local.upper}>
      <View style={[styles.pane, !compact && [styles.frame, { flexBasis: navWidth, flexGrow: 0, flexShrink: 0 }], { borderColor: colors.border, backgroundColor: colors.surface1 }, compact && area !== "targets" && local.hidden]}>
        <PaneHead colors={colors}>
          <Tabs label="构建导航">
            <Tab colors={colors} label="目标" count={all.length} active={nav === "targets"} onPress={() => setNav("targets")} />
            <Tab colors={colors} label="已保存" active={nav === "saved"} onPress={() => setNav("saved")} />
          </Tabs>
          {nav === "targets" ? <Button colors={colors} icon={discovery.failure ? "RotateCcw" : "RefreshCw"} iconOnly label={refreshLabel} disabled={discovery.busy} onPress={() => refresh()} /> : null}
        </PaneHead>
        {nav === "targets" ? <>
          <View style={local.search}><Field colors={colors} label="搜索任务或路径" hideLabel icon="Search" value={search} set={setSearch} placeholder="搜索任务或路径" /></View>
          <Region key={view.viewingNew ? "new" : "all"} label="目标列表" content={local.navContent}>
            {discovery.busy && !discovery.result ? <Loading /> : null}
            {discovery.failure ? <Notice colors={colors} tone="warning" title="目标刷新失败">{discovery.result ? "保留上次结果。\n" : ""}{discovery.failure}</Notice> : null}
            {view.viewingNew ? <View style={styles.actions}><Button colors={colors} small label="显示全部目标" onPress={() => showOnlyNew(false)} /></View> : null}
            {view.groups.size === 0 && discovery.result ? <Caption colors={colors}>没有匹配的目标。</Caption> : null}
            {[...view.groups].map(([group, rows]) => <View key={group} style={local.group}>
              <Text style={[styles.wrapText, local.groupLabel, { color: colors.foregroundMuted }]}>{group}</Text>
              {rows.map((target) => {
                const id = rpc.targetId(target);
                return <Choice key={id} colors={colors} label={target.name} active={id === selection} disabled={busy} onPress={() => openTarget(target)}>
                  <Icon name={target.operation ? "FlaskConical" : "Box"} size={14} color={colors.accent} />
                  <View style={local.rowBody}>
                    <Text style={[styles.wrapText, styles.mono, local.rowTitle, { color: colors.foreground }]}>{target.name}</Text>
                    <Caption colors={colors}>{target.source}</Caption>
                  </View>
                  {view.ids.has(id) ? <Badge colors={colors} tone="success" top>新</Badge> : null}
                </Choice>;
              })}
            </View>)}
            {!view.viewingNew && !search.trim() && selected?.operation && !view.buildProjects.has(projectLabel(selected))
              ? <View style={[local.navHint, { backgroundColor: colors.surface2, borderColor: colors.border }]}><Caption colors={colors}>先执行探测，构建目标会显示在这里。</Caption></View> : null}
            {discovery.result?.notices.map((msg, i) => <Caption key={i} colors={colors} tone="warning">{msg}</Caption>)}
          </Region>
        </> : <Region label="已保存配置列表" content={local.navContent}>
          {discovery.saved.length ? discovery.saved.map((item) => <Choice key={item.name} colors={colors} active={draft.named === item.name} disabled={busy} onPress={() => openTarget(item.target, item)}>
            <Icon name="Save" size={14} color={colors.accent} />
            <View style={local.rowBody}>
              <Text style={[styles.wrapText, styles.label, local.rowTitle, { color: colors.foreground }]}>{item.name}</Text>
              <Caption colors={colors}>{projectLabel(item.target)} · {item.target.name}</Caption>
            </View>
          </Choice>) : <Caption colors={colors}>没有保存的配置。在运行配置中填入名称即可保存。</Caption>}
        </Region>}
      </View>
      <View style={[styles.pane, compact && area !== "config" && local.hidden]}>
        <PaneHead colors={colors}><Heading colors={colors}>运行配置</Heading><Caption colors={colors}>{selected ? savedDraft ? "已保存配置" : "临时配置" : ""}</Caption></PaneHead>
        <Region label="运行配置" content={[local.editor, tight && local.editorTight]}>
          {discovery.failure ? <Notice colors={colors} tone="warning" title="目标刷新失败" action={<Button colors={colors} small label="查看刷新问题" onPress={showTargets} />}>
            {discovery.result ? "保留上次结果，可在目标栏重试。" : "可在目标栏重试。"}
          </Notice> : null}
          {actionError ? <Notice colors={colors} tone="danger" title="操作未提交">{actionError}</Notice> : null}
          {!confirm && !actionError && selected ? inspectTools && !discovery.busy ?
            <Notice colors={colors} tone="warning" title={actual?.gradleRuntime?.status === "incompatible" ? "所选 Java 不兼容" : actual ? "需要检查工具链" : "工具链未就绪"}
              action={compact ? <Button colors={colors} small label="查看工具" onPress={() => setArea("tools")} /> : undefined}>
              {currentTools?.error ?? (actual?.gradleRuntime?.status === "incompatible" ? actual.gradleRuntime.reason : actual && !actual.version ? "检查通过后即可运行当前目标。" : blocked)}
            </Notice> : selected.blocked || previewError ? <Notice colors={colors} tone="warning" title={selected.blocked ? "当前目标不可运行" : "命令预览失败"}>
              {selected.blocked ?? previewError}
            </Notice> : discovery.feedback && !discovery.failure ?
              <Notice colors={colors} tone="success" title="探测完成，目标已刷新"
                action={newAvailable && !primaryShowsNew ? <Button colors={colors} small label="查看新目标" onPress={showNew} /> : undefined}>
                {discovery.feedback.added.length ? `已发现 ${discovery.feedback.added.length} 个新目标。` : "目标列表没有新增。"}{discovery.feedback.limited ? " 结果已截断。" : ""}
              </Notice> : plan ? <Notice colors={colors} tone={selected.operation ? undefined : "success"} title={selected.operation ? "可以执行探测" : "工具链已就绪"}>
                {selected.operation ? "探测会执行项目配置，可能下载依赖，不会开始构建。" : selected.adapter === "gradle" ? "构建前需核对命令和所选工具。" : "核对命令后，即可构建当前目标。"}
              </Notice> : null : null}
          {confirm ? <View style={[styles.tile, { borderColor: colors.accent }]}>
            <Heading colors={colors}>{(confirm.id ? current?.configuration.target.adapter : selected?.adapter) === "gradle" ? "确认 Gradle 任务" : "命令或工具链已变化"}</Heading>
            <Caption colors={colors}>请核对命令、工作目录和工具版本后再运行。</Caption>
            {confirm.id && current ? <><Caption colors={colors}>原运行</Caption><CommandPreview colors={colors} plan={current.command} /></> : null}
            <CommandPreview colors={colors} plan={confirm.plan.command} />
            <View style={styles.actions}>
              {confirm.id && current && !confirm.plan.command.tool.version ? <Button colors={colors} label="重新检查原配置的工具" disabled={!action} onPress={() => perform(async () => {
                await verify({ workspaceId, configuration: current.configuration });
                const result = await retry({ workspaceId, id: current.id, previewOnly: true });
                if (result.kind === "changed") setConfirmation({ ...confirm, plan: result });
                reloadTools((n) => n + 1);
              })} /> : null}
              <Button colors={colors} label="取消确认" onPress={() => setConfirmation(undefined)} />
              <Button colors={colors} label="确认运行" primary disabled={!action || !confirm.plan.command.tool.version || (!confirm.id && !!blocked)} onPress={() => perform(() => submit(confirm.plan, confirm.id))} />
            </View>
          </View> : null}
          {selected ? <>
            <View style={local.targetHeading}>
              <Icon name={selected.operation ? "FlaskConical" : "Box"} size={15} color={colors.accent} />
              <View style={local.rowBody}>
                <Text accessibilityRole="header" selectable style={[styles.wrapText, styles.mono, local.targetName, { color: colors.foreground }]}>{selected.name}</Text>
                <Caption colors={colors}>{selected.source} · {projectLabel(selected)}</Caption>
              </View>
              <Badge colors={colors}>{selected.operation ? "探测" : "构建"}</Badge>
            </View>
            <Field colors={colors} sideLabel mono label="命令选项" placeholder="留空使用项目默认值" value={options} set={setOptions}
              error={parsed.error ?? (currentPreview?.field === "options" ? currentPreview.error : undefined)}
              hint={suggestedOptions && options === suggestedOptions ? "已带入匹配的探测选项，可编辑。" : selected.operation ? "只应用于本次探测。" : "只应用于当前目标。"}
              maxLength={65536} action={suggestions.length ? <Button colors={colors} label="填入示例" disabled={busy} onPress={() => setOptions(suggestions[(suggestions.indexOf(options) + 1) % suggestions.length]!)} /> : undefined} />
            {suggestedOptions && options !== suggestedOptions ? <View style={[styles.actions, local.fieldInset]}>
              <Button colors={colors} small label="带入探测选项" onPress={() => setOptions(suggestedOptions)} />
            </View> : null}
            <Field colors={colors} sideLabel label="配置名称" placeholder="如：本地 Release" value={draft.name} set={(value) => changeDraft({ name: value })} error={nameError} action={
              <Button colors={colors} icon={tight ? undefined : "Save"} label="保存" disabled={!action || !plan || !configuration || !draft.name.trim() || !!nameError} onPress={() => perform(async () => {
                if (!configuration) return;
                const name = draft.name.trim();
                discovery.replaceSaved(await save({ workspaceId, configuration: { ...configuration, name } }));
                setDraft((old) => ({ ...old, named: name, name }));
              })} />
            } />
            <View style={[local.expander, { borderColor: colors.border, backgroundColor: colors.surface1 }]}>
              <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded((open) => !open)} style={local.expanderHead}>
                <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={14} color={colors.foregroundMuted} />
                <Text style={[styles.label, { color: colors.foreground }]}>附加产物路径</Text>
                <Caption colors={colors}>{artifacts.length ? `可选 · ${artifacts.length} 条` : "可选"}</Caption>
              </Pressable>
              {expanded ? <View style={local.expanderBody}><Field colors={colors} label="每行一个工作区相对路径" placeholder="dist" multiline mono
                value={draft.artifacts} set={(value) => changeDraft({ artifacts: value })} error={pathError} maxLength={8200} /></View> : null}
            </View>
            {plan ? <CommandPreview plan={plan.command} colors={colors} /> : <View style={[styles.preview, { borderColor: colors.border, backgroundColor: colors.surface1 }]}>
              <View style={[styles.previewHead, { borderColor: colors.border }]}><Heading colors={colors}>命令预览</Heading></View>
              <View style={styles.previewBody}><Caption colors={colors}>配置和工具可用后显示命令。</Caption></View>
            </View>}
          </> : <Caption colors={colors}>{selection ? "原目标已失效。重新选择前，当前草稿仍保留。" : "从目标列表选择要配置的构建或探测。"}</Caption>}
          {draft.named ? <View style={styles.actions}><Button colors={colors} small label="删除已保存配置" disabled={!action} onPress={() => perform(async () => {
            discovery.replaceSaved(await remove({ workspaceId, name: draft.named })); setDraft((old) => ({ ...old, named: "" }));
          })} /></View> : null}
        </Region>
      </View>
      <View style={[styles.pane, !compact && { flexBasis: toolsWidth, flexGrow: 0, flexShrink: 0, borderLeftWidth: 1 }, { borderColor: colors.border, backgroundColor: colors.surface1 }, compact && area !== "tools" && local.hidden]}>
        <PaneHead colors={colors}>
          <View style={styles.inline}><Icon name="Wrench" size={14} color={colors.foreground} /><Heading colors={colors}>工具链</Heading></View>
          <View style={styles.inline}>
            <Caption colors={colors}>{tools ? `${tools.candidates.length} 个候选` : ""}</Caption>
            <Button colors={colors} icon="RefreshCw" iconOnly label="刷新工具链" disabled={!selected || busy} onPress={() => { setCheckError(""); reloadTools((n) => n + 1); }} />
          </View>
        </PaneHead>
        <Region label="工作区工具链">
          <Heading colors={colors}>{tools?.requirement ?? (selected ? "正在读取工作区工具链" : "先选择目标")}</Heading>
          {tools?.issues.map((issue, i) => <Caption key={i} colors={colors} tone="warning">{issue}</Caption>)}
          {currentTools?.error ? <Caption colors={colors} tone="danger">{currentTools.error}</Caption> : null}
          <View style={[local.toolActions, { borderColor: colors.border }]}>
            <Button colors={colors} icon="Check" label="检查所选工具" disabled={!action || !actual || actual.gradleRuntime?.status === "incompatible"} onPress={checkTool} />
            <View style={local.rowBody}><Caption colors={colors} tone={checkError ? "danger" : actual?.gradleRuntime?.status === "incompatible" ? "warning" : actual?.version ? "success" : undefined}>
              {checkError || (tool && tools && !actual ? "所选工具已失效，请选择替代工具。" :
                actual?.gradleRuntime?.status === "incompatible" ? "请选择兼容的工具。" : actual?.version ? "所选工具检查通过。" : actual ? "所选工具尚未检查。" : "尚未选择工具。")}
            </Caption></View>
          </View>
          {tools?.candidates.map((candidate) => <ToolCard key={candidate.id} colors={colors} candidate={candidate} active={candidate.id === tool} disabled={busy} choose={() => {
            if (!selected || candidate.id === tool) return;
            setCheckError("");
            perform(async () => {
              await selectTool({ workspaceId, target: selected, tool: candidate.id });
              setDraft((old) => ({ ...old, tool: candidate.id })); setConfirmation(undefined);
            }, setCheckError);
          }} />)}
        </Region>
      </View>
    </View>
    <ResizeHandle colors={colors} height={dock} min={minDock} max={maxDock} set={setDockHeight} />
    <RunDock colors={colors} workspaceId={workspaceId} height={dock} navWidth={navWidth} tight={tight} runs={runs} id={runId} tab={detailTab} setTab={setDetailTab}
      update={updates} connection={connection} busy={!action} select={(id) => { if (!lock.current) { setRunId(id); setConfirmation(undefined); } }} retry={retryRun}
      stop={() => perform(async () => { await stop({ workspaceId, id: runId }); updateRuns((x) => x + 1); })} />
  </View>;
}

function ToolCard({ colors, candidate, active, disabled, choose }: { colors: Colors; candidate: Candidate; active: boolean; disabled: boolean; choose(): void }) {
  const runtime = candidate.gradleRuntime;
  const [name, ...qualifiers] = candidate.label.split(" · ");
  // Tool labels include executable directories; display those once via the complete paths below.
  const context = qualifiers.filter((item) => !item.split(" → ").every((dir) => dir.startsWith("/") &&
    candidate.paths.some((path) => path === dir || path.startsWith(`${dir}/`)))).join(" · ");
  return <Choice colors={colors} label={candidate.label} card active={active} disabled={disabled} onPress={choose}>
    <View style={local.rowBody}>
      <Text style={[styles.wrapText, styles.label, local.rowTitle, { color: colors.foreground }]}>{name}</Text>
      {context ? <Caption colors={colors}>{context}</Caption> : null}
      <Caption colors={colors}>{candidate.version ?? (runtime ? "启动 Java 未检查" : "版本未检查")}</Caption>
      <Code colors={colors} muted>{candidate.paths.join("\n")}</Code>
      {runtime ? <Caption colors={colors} tone={runtime.status === "compatible" ? "success" : "warning"}>{runtime.reason}</Caption> : null}
    </View>
    {runtime?.status === "incompatible" ? <Badge colors={colors} tone="danger" top>不兼容</Badge> :
      candidate.version ? <Badge colors={colors} tone="success" top>已检查</Badge> :
      runtime?.status === "compatible" ? <Badge colors={colors} tone="success" top>兼容</Badge> : null}
  </Choice>;
}

const local = StyleSheet.create({
  root: { flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden" },
  toolbar: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 4, minHeight: 45, flexShrink: 0, borderBottomWidth: 1 },
  toolbarTight: { paddingHorizontal: 7, gap: 6 },
  breadcrumb: { flex: 1 },
  stack: { flexShrink: 0, maxWidth: "100%" },
  breadcrumbName: { flexShrink: 1, minWidth: 0, fontWeight: "700" },
  status: { fontSize: 12, lineHeight: 15, textAlign: "right", maxWidth: 360 },
  statusTight: { maxWidth: 102 },
  upper: { flex: 1, minHeight: 0, flexDirection: "row" },
  hidden: { display: "none" },
  search: { padding: 8 },
  navContent: { paddingHorizontal: 6, paddingTop: 3 },
  navHint: { marginHorizontal: 5, borderLeftWidth: 2, paddingHorizontal: 7, paddingVertical: 5 },
  group: { gap: 2 },
  groupLabel: { fontSize: 11, fontWeight: "700", paddingHorizontal: 6, paddingTop: 3, paddingBottom: 2 },
  rowBody: { flex: 1, minWidth: 0, gap: 1 },
  rowTitle: { fontWeight: "700", lineHeight: 17 },
  editor: { padding: 12, gap: 8 },
  editorTight: { padding: 8 },
  targetHeading: { flexDirection: "row", alignItems: "flex-start", gap: 7, marginTop: 5, marginBottom: 3 },
  targetName: { fontSize: 15, lineHeight: 20, fontWeight: "700" },
  fieldInset: { marginLeft: 73 },
  expander: { borderRadius: 5, borderWidth: 1, marginTop: 2 },
  expanderHead: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 7, minHeight: 30 },
  expanderBody: { paddingHorizontal: 8, paddingBottom: 6 },
  toolActions: { flexDirection: "row", alignItems: "center", gap: 6, borderTopWidth: 1, borderBottomWidth: 1, paddingVertical: 6 },
});
