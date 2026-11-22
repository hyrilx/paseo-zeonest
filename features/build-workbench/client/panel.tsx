import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Loading, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { formatArguments, parseArguments } from "../shared/arguments";
import * as rpc from "../shared/contracts";
import type { Candidate, Command, Configuration, Run, Saved, Target } from "../shared/contracts";
import { Button, Caption, Choice, Code, CommandPreview, Field, Heading, PaneHead, Region, errorMessage, styles } from "./panel-ui.tsx";
import type { Colors } from "./panel-ui.tsx";
import { ResizeHandle, RunDock } from "./run-dock.tsx";
import type { DetailTab } from "./run-dock.tsx";
import { defaultTool, limitDock, ProbeCompletions } from "./workbench-state";
import { useDiscovery } from "./use-discovery";

type Plan = { command: Command; fingerprint: string };
type ToolList = { candidates: Candidate[]; requirement: string; issues: string[]; selected?: string };
type Area = "targets" | "config" | "tools";
const areas = { targets: "目标", config: "配置", tools: "工具链" };
const projectLabel = (target: rpc.TargetKey) => `${target.project === "." ? "根目录" : target.project} · ${target.adapter}`;
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
  const [project, setProject] = useState("");
  const [search, setSearch] = useState("");
  const [onlyNew, showOnlyNew] = useState(false);
  const [area, setArea] = useState<Area>("targets");
  const [draft, setDraft] = useState(blank);
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
  const compact = layout.compact || (width > 0 && width < 820);
  const maxDock = Math.max(90, Math.floor(height * 0.66));
  const minDock = Math.min(145, maxDock);
  const dock = limitDock(dockHeight ?? Math.floor(height * 0.36), minDock, maxDock);
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
  const confirm = confirmation && (confirmation.id ? confirmation.id === runId : confirmation.key === planKey && !!planKey) ? confirmation : undefined;
  const current = runs.find((row) => row.id === runId);
  const action = !busy && !connection;
  const blocked = busy ? "正在提交操作" : connection ? "无法读取运行状态" : discovery.busy ? "正在刷新目标"
    : !selected ? (selection ? "原目标已失效，请重新选择" : "请先选择目标") : selected.blocked
      || (currentTools?.error ? "无法读取工具链，请重试" : !tools ? "正在查找工具链" : undefined)
      || (!actual ? (tool ? "所选工具已失效，请重新选择" : "请选择可用的工具") : undefined)
      || (actual?.gradleRuntime?.status === "incompatible" ? actual.gradleRuntime.reason : undefined)
      || (parsed.error || artifactError || currentPreview?.field ? "请修正配置中的字段错误" : undefined)
      || (!actual?.version ? "请先检查所选工具" : undefined)
      || currentPreview?.error || (!plan ? "正在准备命令预览" : "");

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
    if (saved) { setSearch(""); setProject(""); showOnlyNew(false); }
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
  const projects = [...new Set(all.map(projectLabel))];
  const viewingNew = onlyNew && !!discovery.feedback?.added.length;
  const targets = all.filter((target) => (!project || projectLabel(target) === project) &&
    (!viewingNew || discovery.feedback?.added.includes(rpc.targetId(target))) &&
    `${projectLabel(target)} ${target.name}`.toLowerCase().includes(search.trim().toLowerCase()));
  const suggestions = !selected ? [] : selected.operation && selected.adapter === "cmake" ? ['-DCMAKE_BUILD_TYPE=Release', '-G "Unix Makefiles"']
    : selected.operation && selected.adapter === "xcode" ? ["-verbose"]
      : selected.operation && selected.adapter === "gradle" ? ["--offline", "--workbench-task-filter=:模块:", "--workbench-task-filter=assembleDebug"] : examples[selected.adapter];
  const setOptions = (value: string) => changeDraft({ options: value, optionsTouched: true });
  const nameError = draft.name.trim().length > 64 ? "配置名称最多 64 个字符。" : undefined;
  const refreshLabel = discovery.busy ? "正在刷新…" : discovery.failure ? "重试刷新" : "刷新目标";

  return <View style={[local.root, { backgroundColor: colors.surface0 }]} onLayout={({ nativeEvent: { layout: size } }) => setSize((old) => old.width === size.width && old.height === size.height ? old : { width: size.width, height: size.height })}>
    <PaneHead colors={colors}>
      <Heading colors={colors}>工作台：构建</Heading>
      <Button colors={colors} label={selected?.operation ? "执行探测" : "构建"} primary disabled={!!blocked || !!confirm} onPress={() => {
        if (!plan) return;
        if (selected?.adapter === "gradle" && !selected.operation) { setConfirmation({ key: planKey, plan }); setArea("config"); }
        else perform(() => submit(plan));
      }} />
      <View style={local.barStatus}>
        <Text selectable accessibilityLiveRegion="polite" style={{ color: blocked ? colors.statusWarning : colors.foreground, fontSize: 12 }}>
          {blocked || (confirm ? "请核对并确认命令" : selected?.operation ? "探测完成后会刷新目标列表" : "可构建")}
        </Text>
      </View>
      {confirm ? <Button colors={colors} label="取消确认" onPress={() => setConfirmation(undefined)} /> : null}
    </PaneHead>
    {discovery.failure && compact && area !== "targets" ? <PaneHead colors={colors}>
      <Caption colors={colors} tone="warning">目标刷新失败{discovery.result ? "，保留上次结果" : ""}。</Caption>
      <Button colors={colors} label="查看刷新问题" onPress={() => setArea("targets")} />
    </PaneHead> : null}
    {discovery.feedback ? <PaneHead colors={colors}>
      <Caption colors={colors} tone="success">探测成功。{discovery.feedback.added.length ? `已发现 ${discovery.feedback.added.length} 个新目标。` : "目标列表没有新增。"}</Caption>
      {discovery.feedback.limited ? <Caption colors={colors} tone="warning">结果已截断。</Caption> : null}
      {discovery.feedback.added.length ? <Button colors={colors} label="查看新目标" onPress={() => { setSearch(""); setProject(""); showOnlyNew(true); setArea("targets"); }} /> : null}
    </PaneHead> : null}
    {compact ? <PaneHead colors={colors}>{(Object.keys(areas) as Area[]).map((key) => <Button key={key} colors={colors} label={areas[key]} active={area === key} onPress={() => setArea(key)} />)}</PaneHead> : null}
    <View style={local.upper}>
      <View style={[styles.pane, !compact && { flexBasis: "25%", flexGrow: 0, flexShrink: 0 }, !compact && styles.frame, { borderColor: colors.border }, compact && area !== "targets" && local.hidden]}>
        {!compact ? <PaneHead colors={colors}><Heading colors={colors}>目标</Heading></PaneHead> : null}
        <View style={local.search}><Field colors={colors} label="搜索目标" hideLabel value={search} set={setSearch} placeholder="搜索目标" action={
          <Button colors={colors} label={refreshLabel} disabled={discovery.busy} onPress={() => refresh()} />
        } /></View>
        <Region key={viewingNew ? "new" : "all"} label="目标列表">
          {discovery.busy && !discovery.result ? <Loading /> : null}
          {discovery.failure ? <Caption colors={colors} tone="warning">刷新失败{discovery.result ? "，保留上次结果" : ""}：{discovery.failure}</Caption> : null}
          <SettingsSelect label="分组" value={project} options={[{ label: "所有项目", value: "" }, ...projects.map((group) => ({ label: group, value: group }))]} onValueChange={setProject} />
          {viewingNew ? <Button colors={colors} label="显示全部目标" onPress={() => showOnlyNew(false)} /> : null}
          {targets.length === 0 && discovery.result ? <Caption colors={colors}>没有符合条件的目标。</Caption> : null}
          {projects.map((group) => {
            const rows = targets.filter((target) => projectLabel(target) === group);
            return rows.length ? <View key={group} style={local.group}>
              <Heading colors={colors}>{group}</Heading>
              {rows.map((target) => {
                const id = rpc.targetId(target);
                return <Choice key={id} colors={colors} active={id === selection} disabled={busy} onPress={() => openTarget(target)}>
                  <Text style={[styles.wrapText, { color: colors.foreground }]}>{target.name}</Text>
                  <Caption colors={colors}>{target.operation ? "探测" : target.blocked ? "不可运行" : target.confirmed ? "已探测" : "构建"}{discovery.feedback?.added.includes(id) ? " · 新目标" : ""}</Caption>
                </Choice>;
              })}
            </View> : null;
          })}
          {discovery.result?.notices.map((msg, i) => <Caption key={i} colors={colors} tone="warning">{msg}</Caption>)}
        </Region>
      </View>
      <View style={[styles.pane, compact && area !== "config" && local.hidden]}>
        {!compact ? <PaneHead colors={colors}><Heading colors={colors}>配置与命令</Heading></PaneHead> : null}
        <Region label="配置与命令">
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
              <Button colors={colors} label="确认运行" primary disabled={!action || !confirm.plan.command.tool.version || (!confirm.id && !!blocked)} onPress={() => perform(() => submit(confirm.plan, confirm.id))} />
            </View>
          </View> : null}
          {actionError ? <Caption colors={colors} tone="danger">操作未提交：{actionError}</Caption> : null}
          <SettingsSelect label="已保存配置" value={draft.named} options={[{ label: "临时配置", value: "" }, ...discovery.saved.map((c) => ({ label: c.name, value: c.name }))]} onValueChange={(value) => {
            const c = discovery.saved.find((item) => item.name === value);
            if (c) openTarget(c.target, c);
            else changeDraft({ name: "", named: "" });
          }} />
          {selected ? <>
            <Heading colors={colors}>{selected.name}</Heading>
            <Caption colors={colors}>{projectLabel(selected)} · {selected.source}</Caption>
            {selected.operation ? <Caption colors={colors} tone="warning">探测会执行项目配置，可能下载项目依赖。</Caption> : null}
            {selected.adapter === "gradle" && !selected.operation ? <Caption colors={colors}>构建变体在目标列表选择。任务执行前需核对命令。</Caption> : null}
            <Field colors={colors} label="构建选项" placeholder="留空使用项目默认值" value={options} set={setOptions} error={parsed.error ?? (currentPreview?.field === "options" ? currentPreview.error : undefined)} maxLength={65536} />
            {suggestedOptions ? <Caption colors={colors}>当前工具有匹配的探测选项：{suggestedOptions}</Caption> : null}
            {suggestedOptions && options !== suggestedOptions ? <View style={styles.actions}><Button colors={colors} label="带入探测选项" onPress={() => setOptions(suggestedOptions)} /></View> : null}
            <SettingsSelect label="常用选项" value={suggestions.includes(options) ? options : ""} options={[{ label: "选择示例", value: "" }, ...suggestions.map((value) => ({ label: value, value }))]} onValueChange={(value) => { if (value) setOptions(value); }} />
            <Field colors={colors} label="附加产物路径（每行一个）" multiline value={draft.artifacts} set={(value) => changeDraft({ artifacts: value })} error={artifactError ?? (currentPreview?.field === "artifacts" ? currentPreview.error : undefined)} maxLength={8200} />
            <Heading colors={colors}>命令预览</Heading>
            {plan ? <CommandPreview plan={plan.command} colors={colors} /> : <Caption colors={colors}>配置和工具可用后显示命令。</Caption>}
            <Field colors={colors} label="配置名称" value={draft.name} set={(value) => changeDraft({ name: value })} error={nameError} action={
              <Button colors={colors} label="保存配置" disabled={!action || !plan || !configuration || !draft.name.trim() || !!nameError} onPress={() => perform(async () => {
                if (!configuration) return;
                const name = draft.name.trim();
                discovery.replaceSaved(await save({ workspaceId, configuration: { ...configuration, name } }));
                setDraft((old) => ({ ...old, named: name, name }));
              })} />
            } />
            {draft.named ? <View style={styles.actions}><Button colors={colors} label="删除已保存配置" disabled={!action} onPress={() => perform(async () => {
              discovery.replaceSaved(await remove({ workspaceId, name: draft.named })); setDraft((old) => ({ ...old, named: "" }));
            })} /></View> : null}
          </> : <Caption colors={colors}>{selection ? "原目标已失效。重新选择前，当前草稿仍保留。" : "从目标列表选择要配置的构建或探测。"}</Caption>}
        </Region>
      </View>
      <View style={[styles.pane, !compact && { flexBasis: "29%", flexGrow: 0, flexShrink: 0, borderLeftWidth: 1, borderColor: colors.border }, compact && area !== "tools" && local.hidden]}>
        {!compact ? <PaneHead colors={colors}><Heading colors={colors}>工具链</Heading></PaneHead> : null}
        <Region label="工作区工具链">
          <Caption colors={colors}>{tools?.requirement ?? (selected ? "正在读取工作区工具链" : "先选择目标")}</Caption>
          {currentTools?.error || checkError ? <Caption colors={colors} tone="danger">{currentTools?.error ?? checkError}</Caption> : null}
          {tools?.issues.map((issue, i) => <Caption key={i} colors={colors} tone="warning">{issue}</Caption>)}
          {tool && tools && !actual ? <Caption colors={colors} tone="warning">所选工具已失效，请明确选择替代工具。</Caption> : null}
          <View style={styles.actions}>
            <Button colors={colors} label="检查所选工具" disabled={!action || !actual} onPress={checkTool} />
            <Button colors={colors} label="刷新工具链" disabled={!selected || busy} onPress={() => { setCheckError(""); reloadTools((n) => n + 1); }} />
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
    <RunDock colors={colors} workspaceId={workspaceId} height={dock} compact={compact} runs={runs} id={runId} tab={detailTab} setTab={setDetailTab}
      update={updates} connection={connection} busy={!action} select={(id) => { if (!lock.current) { setRunId(id); setConfirmation(undefined); } }} retry={retryRun}
      stop={() => perform(async () => { await stop({ workspaceId, id: runId }); updateRuns((x) => x + 1); })} />
  </View>;
}

function ToolCard({ colors, candidate, active, disabled, choose }: { colors: Colors; candidate: Candidate; active: boolean; disabled: boolean; choose(): void }) {
  const runtime = candidate.gradleRuntime;
  return <View style={[styles.tile, { borderColor: active ? colors.accent : colors.border, backgroundColor: active ? colors.surface2 : colors.surface1 }]}>
    <Text selectable style={[styles.wrapText, { color: colors.foreground, fontWeight: "600" }]}>{candidate.label}</Text>
    <Caption colors={colors}>{candidate.version ?? (runtime ? "启动 Java 未检查" : "版本未检查")}</Caption>
    <Code colors={colors}>{candidate.paths.join("\n")}</Code>
    {runtime ? <Caption colors={colors} tone={runtime.status === "compatible" ? "success" : "warning"}>{runtime.reason}</Caption> : null}
    <View style={styles.actions}><Button colors={colors} label={active ? "当前工具" : "选择此工具"} active={active} disabled={disabled || active} onPress={choose} /></View>
  </View>;
}

const local = StyleSheet.create({
  root: { flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden" },
  upper: { flex: 1, minHeight: 0, flexDirection: "row" },
  hidden: { display: "none" },
  search: { padding: 8 },
  group: { gap: 5 },
  barStatus: { flex: 1, minWidth: 100 },
});
