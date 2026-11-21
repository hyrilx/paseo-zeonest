import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Loading, ScrollView, SettingsCard, SettingsRow, SettingsSection, SettingsSelect, TextInput } from "@getpaseo/plugin/client/ui";
import * as rpc from "../shared/contracts";
import type { Command, Configuration, Log, Run, Saved } from "../shared/contracts";

type Colors = PluginWorkspacePanelProps["theme"]["colors"];
type Plan = { command: Command; fingerprint: string };
const labels: Record<Run["status"], string> = { queued: "排队中", running: "运行中", stopping: "正在停止", success: "成功", failed: "失败", stopped: "已停止", interrupted: "中断 · 进程状态未知" };
const assetLabels = { new: "新增", changed: "变化", existing: "已有", missing: "缺失", removed: "已移除", unavailable: "无法观察" };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const projectLabel = (target: rpc.TargetKey) => `${target.project === "." ? "根目录" : target.project} · ${target.adapter}`;
const commandText = (command: Pick<Command, "argv">) => command.argv.map((arg) => /^[\w@./:=+-]+$/u.test(arg) ? arg : JSON.stringify(arg)).join(" ");

export function BuildPanel(props: PluginWorkspacePanelProps) {
  return <Workbench key={JSON.stringify([props.host.id, props.workspaceId])} {...props} />;
}

function Workbench({ workspaceId, layout, theme: { colors } }: PluginWorkspacePanelProps) {
  const getDiscovery = useRpc(rpc.discover);
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
  const [discovery, setDiscovery] = useState<Awaited<ReturnType<typeof getDiscovery>>>();
  const [configs, setConfigs] = useState<Saved[]>([]);
  const [revision, refresh] = useState(0);
  const [updates, updateRuns] = useState(0);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selection, select] = useState("");
  const [project, setProject] = useState("");
  const [search, setSearch] = useState("");
  const [tool, chooseTool] = useState("");
  const [toolRevision, refreshVersions] = useState(0);
  const [options, setOptions] = useState("");
  const [artifacts, setArtifacts] = useState("");
  const [name, setName] = useState("");
  const [named, setNamed] = useState("");
  const [available, setAvailable] = useState<Awaited<ReturnType<typeof getTools>>>();
  const [preview, setPreview] = useState<{ key: string; plan: Plan }>();
  const [confirmation, setConfirmation] = useState<{ key: string; plan: Plan; id?: string }>();
  const [runId, setRunId] = useState("");
  const [detail, showDetail] = useState(false);
  const [toolsOpen, showTools] = useState(false);
  const [failure, setFailure] = useState("");
  const [planError, setPlanError] = useState("");
  const [connection, setConnection] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = discovery?.targets.find((item) => rpc.targetId(item) === selection);
  const configuration: Configuration | undefined = selected && tool ? { target: selected, tool,
    options: options.trim().split(/\s+/u).filter(Boolean), artifacts: artifacts.split("\n").map((s) => s.trim()).filter(Boolean) } : undefined;
  const configurationKey = configuration && JSON.stringify(configuration);

  useEffect(() => {
    let cancelled = false;
    getDiscovery({ workspaceId }).then((found) => {
      if (cancelled) return;
      setDiscovery(found); setConfigs(found.configurations);
    }, (error) => { if (!cancelled) setFailure(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [getDiscovery, revision, workspaceId]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const rows = await list({ workspaceId });
        if (!cancelled) { setRuns(rows); setConnection(""); }
      } catch (error) { if (!cancelled) setConnection(errorMessage(error)); }
      if (!cancelled) timer = setTimeout(poll, 1800);
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [list, workspaceId, updates]);
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    getTools({ workspaceId, target: selected }).then((found) => {
      if (cancelled) return;
      setAvailable(found);
      chooseTool((old) => old || found.selected || found.candidates[0]?.id || "");
    }, (error) => { if (!cancelled) setFailure(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [selected, getTools, workspaceId, toolRevision]);
  useEffect(() => {
    if (!configurationKey) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const request = async () => {
        try { return await getPreview({ workspaceId, configuration: rpc.config.parse(JSON.parse(configurationKey)) }); }
        catch (error) { throw new Error(errorMessage(error), { cause: error }); }
      };
      void request().then((plan) => {
        if (!cancelled) { setPreview({ key: configurationKey, plan }); setPlanError(""); }
      }, (error) => { if (!cancelled) { setPreview(undefined); setPlanError(errorMessage(error)); } });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [configurationKey, getPreview, workspaceId, toolRevision]);

  function perform(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setFailure("");
    void task().catch((error) => setFailure(errorMessage(error))).finally(() => setBusy(false));
  }
  async function submit(plan: Plan, id?: string) {
    const result = id ? await retry({ workspaceId, id, fingerprint: plan.fingerprint })
      : configuration && await start({ workspaceId, configuration, fingerprint: plan.fingerprint });
    if (!result) return;
    if (result.kind === "changed") {
      setConfirmation({ key: configurationKey ?? "", plan: result, id }); return;
    }
    setConfirmation(undefined); setRunId(result.run.id); showDetail(true); updateRuns((x) => x + 1);
  }
  function retryRun(id: string) {
    perform(async () => {
      const result = await retry({ workspaceId, id });
      if (result.kind === "changed") { setConfirmation({ key: "", plan: result, id }); return; }
      setConfirmation(undefined); setRunId(result.run.id); showDetail(true); updateRuns((x) => x + 1);
    });
  }
  const projects = [...new Set(discovery?.targets.map(projectLabel))];
  const targets = discovery?.targets.filter((t) => (!project || projectLabel(t) === project) &&
    `${projectLabel(t)} ${t.name}`.toLowerCase().includes(search.toLowerCase().trim())) ?? [];
  const plan = preview?.key === configurationKey ? preview?.plan : undefined;
  const actualTool = available?.candidates.find((item) => item.id === tool);
  const confirm = confirmation && (confirmation.id ? confirmation.id === runId : confirmation.key === configurationKey) ? confirmation : undefined;
  const action = !connection && !busy;
  const current = runs.find((row) => row.id === runId);
  const compactDetail = layout.compact && detail && !!runId;

  return <ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={[styles.page, layout.compact && styles.compact]} keyboardShouldPersistTaps="handled">
    <View style={styles.spread}>
      <Text style={[styles.heading, { color: colors.foreground }]}>工作台：构建</Text>
      {compactDetail ? <Button colors={colors} label="返回运行记录" onPress={() => showDetail(false)} />
        : <Button colors={colors} label={toolsOpen ? "收起工具链" : "工具链"} onPress={() => showTools(!toolsOpen)} />}
    </View>
    {connection ? <Note colors={colors} warning>无法刷新运行状态：{connection}。下方保留上次确认的状态。</Note> : null}
    {failure ? <Note colors={colors} warning>{failure}</Note> : null}
    {!discovery && !failure ? <Loading /> : null}
    {!compactDetail ? <SettingsSection title="运行配置">
      <SettingsCard>
        <SettingsSelect label="已保存配置" value={named} options={[{ label: "临时配置", value: "" }, ...configs.map((c) => ({ label: c.name, value: c.name }))]} onValueChange={(value) => {
          setNamed(value);
          const c = configs.find((item) => item.name === value);
          if (c) { setProject(projectLabel(c.target)); setSearch(""); select(rpc.targetId(c.target)); chooseTool(c.tool); setOptions(c.options.join(" ")); setArtifacts(c.artifacts.join("\n")); setName(c.name); setAvailable(undefined); refreshVersions((v) => v + 1); }
          else setName("");
        }} />
        <SettingsSelect label="子项目" value={project} options={[{ label: "全部", value: "" }, ...projects.map((p) => ({ label: p, value: p }))]} onValueChange={(value) => { setProject(value); select(""); setAvailable(undefined); chooseTool(""); }} />
        <Field colors={colors} label="搜索目标" value={search} set={setSearch} />
        <SettingsSelect label="目标" value={selection} options={[{ label: selection && !selected ? "原目标已失效，请重新选择" : "选择目标", value: "" },
          ...targets.map((t) => ({ label: `${projectLabel(t)} › ${t.name}${t.operation ? "（探测）" : t.blocked ? "（不可运行）" : t.confirmed ? "（已探测）" : ""}`, value: rpc.targetId(t) }))]} onValueChange={(value) => { select(value); chooseTool(""); setAvailable(undefined); setPlanError(""); }} />
        {selected ? <>
          <Field colors={colors} label="构建选项" placeholder={selected.adapter === "npm" || selected.adapter === "pnpm" ? "--mode staging" : "留空使用默认选项"} value={options} set={setOptions} />
          <Field colors={colors} label="附加产物路径（每行一个）" multiline value={artifacts} set={setArtifacts} />
        </> : null}
      </SettingsCard>
      <View style={styles.actions}>
        <Button colors={colors} label="刷新目标" onPress={() => { setFailure(""); refresh((x) => x + 1); }} />
        <Button colors={colors} label={selected?.operation ? "执行探测" : "运行"} primary disabled={!action || !plan?.command.tool.version || !!confirm} onPress={() => { if (plan) perform(() => submit(plan)); }} />
      </View>
      {selected?.operation ? <Note colors={colors}>探测会执行项目配置，并可能下载工具声明的项目依赖。完成后可刷新目标。</Note> : null}
      {selected?.blocked ? <Note colors={colors} warning>{selected.blocked}</Note> : null}
      {selected && !selected.blocked && !plan?.command.tool.version ? <Note colors={colors}>运行前请在工具链中选择并检查版本。</Note> : null}
      {configurationKey && planError ? <Note colors={colors} warning>{planError}</Note> : null}
      {discovery?.notices.map((msg, idx) => <Note key={idx} colors={colors}>{msg}</Note>)}
      {plan ? <CommandPreview plan={plan.command} colors={colors} /> : null}
      {plan && configuration ? <View style={styles.actions}>
        <Field colors={colors} label="配置名称" value={name} set={setName} />
        <Button colors={colors} label="保存配置" disabled={!action || !name.trim()} onPress={() => perform(async () => {
          setConfigs(await save({ workspaceId, configuration: { ...configuration, name: name.trim() } })); setNamed(name.trim());
        })} />
        {named ? <Button colors={colors} label="删除配置" disabled={!action} onPress={() => perform(async () => {
          setConfigs(await remove({ workspaceId, name: named })); setNamed("");
        })} /> : null}
      </View> : null}
    </SettingsSection> : null}
    {!compactDetail && available?.issues?.map((issue) => <Note key={issue} colors={colors} warning>{issue}</Note>)}
    {toolsOpen && !compactDetail ? <SettingsSection title="工作区工具链">
      <SettingsCard>
        <SettingsSelect label="工具组合" value={tool} hint={available?.requirement ?? "先选择构建目标"}
          options={[{ label: "请选择", value: "" }, ...(available?.candidates ?? []).map((c) => ({ label: c.label, value: c.id }))]} onValueChange={(id) => {
            if (selected && id) perform(async () => {
              await selectTool({ workspaceId, target: selected, tool: id }); chooseTool(id);
            });
          }} />
        <SettingsRow label={actualTool ? actualTool.version ?? "找到候选 · 版本未验证" : tool ? "保存的工具已失效，请重新选择" : available ? "没有匹配的候选工具" : "未选择"}
          hint={actualTool?.paths.join("\n")} />
      </SettingsCard>
      <Button colors={colors} label="检查所选工具" disabled={!configuration || !actualTool || !action} onPress={() => perform(async () => {
        if (!configuration) return;
        await verify({ workspaceId, configuration }); refreshVersions((v) => v + 1);
      })} />
    </SettingsSection> : null}
    {confirm ? <SettingsSection title="命令或工具链已变化">
      {confirm.id && current ? <><Note colors={colors}>原运行</Note><CommandPreview colors={colors} plan={current.command} /></> : null}
      <Note colors={colors}>请核对新的命令、工作目录和工具版本后再运行。</Note>
      <CommandPreview colors={colors} plan={confirm.plan.command} />
      <View style={styles.actions}>
        {confirm.id && current && !confirm.plan.command.tool.version ? <Button colors={colors} label="重新检查原配置的工具" disabled={!action} onPress={() => perform(async () => {
          await verify({ workspaceId, configuration: current.configuration });
          const plan = await getPreview({ workspaceId, configuration: current.configuration });
          setConfirmation({ ...confirm, plan }); refreshVersions((v) => v + 1);
        })} /> : null}
        <Button colors={colors} label="确认运行" primary disabled={!action || !confirm.plan.command.tool.version} onPress={() => perform(() => submit(confirm.plan, confirm.id))} />
        <Button colors={colors} label="取消" onPress={() => setConfirmation(undefined)} />
      </View>
    </SettingsSection> : null}
    <View style={[styles.runs, layout.compact && styles.stacked]}>
      {!compactDetail ? <View style={styles.list}>
        <Text style={[styles.subhead, { color: colors.foreground }]}>运行记录</Text>
        {runs.length === 0 ? <Note colors={colors}>还没有运行记录。选择目标并检查工具后即可运行。</Note> : null}
        {runs.map((r) => <Pressable key={r.id} accessibilityRole="button" accessibilityState={{ selected: r.id === runId }} onPress={() => { setRunId(r.id); showDetail(true); }}
          style={[styles.tile, { borderColor: r.id === runId ? colors.accent : colors.border, backgroundColor: colors.surface1 }]}>
          <Text style={{ color: colors.foreground }}>#{r.sequence} {r.configuration.target.project} › {r.configuration.target.name}</Text>
          <Text style={{ color: r.status === "failed" ? colors.statusDanger : colors.foregroundMuted }}>{labels[r.status]}</Text>
        </Pressable>)}
      </View> : null}
      {runId && (!layout.compact || detail) ? <View style={styles.detail}>
        <RunDetail key={runId} colors={colors} workspaceId={workspaceId} id={runId} update={updates} busy={!action} retry={() => retryRun(runId)} stop={() => perform(async () => {
          await stop({ workspaceId, id: runId }); updateRuns((x) => x + 1);
        })} />
      </View> : null}
    </View>
  </ScrollView>;
}

function RunDetail({ colors, workspaceId, id, update, busy, retry, stop }: {
  colors: Colors; workspaceId: string; id: string; update: number; busy: boolean; retry(): void; stop(): void;
}) {
  const read = useRpc(rpc.detail);
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof read>>>();
  const [rows, setRows] = useState<Log[]>([]);
  const [trimmed, setTrimmed] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"output" | "artifacts">("output");
  const cursor = useRef(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let delay = 1300;
      try {
        const state = await read({ workspaceId, id, cursor: cursor.current });
        if (cancelled) return;
        cursor.current = state.cursor; setSnapshot(state); setError("");
        if (state.truncated || state.cursor > 512) setTrimmed(true);
        if (state.rows.length) setRows((old) => [...(state.truncated ? [] : old), ...state.rows].slice(-512));
        if (state.rows.length === 24) delay = 50;
        else if (state.run.endedAt !== undefined || (!rpc.live(state.run.status) && state.run.status !== "interrupted")) return;
      } catch (e) { if (!cancelled) setError(errorMessage(e)); }
      if (!cancelled) timer = setTimeout(poll, delay);
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [read, workspaceId, id, update]);
  const run = snapshot?.run;
  return <View style={styles.list}>
    <Text style={[styles.subhead, { color: colors.foreground }]}>运行详情{run ? ` #${run.sequence} · ${labels[run.status]}` : ""}</Text>
    {error ? <Note colors={colors} warning>无法刷新详情：{error}</Note> : null}
    {run ? <>
      <CommandPreview plan={run.command} colors={colors} />
      {run.result ? <Note colors={colors}>{run.result}</Note> : null}
      {run.confirmedTargets?.length ? <Note colors={colors}>已确认：{run.confirmedTargets.join("、")}</Note> : null}
      <View style={styles.actions}>
        <Button colors={colors} label="输出" primary={tab === "output"} onPress={() => setTab("output")} />
        <Button colors={colors} label="产物" primary={tab === "artifacts"} onPress={() => setTab("artifacts")} />
        {rpc.live(run.status) ? <Button colors={colors} label={run.status === "queued" ? "移出队列" : "停止"} disabled={busy || run.status === "stopping"} onPress={stop} /> : null}
        {rpc.retryable(run.status) ? <Button colors={colors} label="重试" disabled={busy || run.endedAt === undefined} onPress={retry} /> : null}
      </View>
    </> : null}
    {tab === "output" ? <View style={[styles.tile, { backgroundColor: colors.surface1, borderColor: colors.border }]}>
      {trimmed ? <Note colors={colors} warning>较早的输出已截断。</Note> : null}
      <Text selectable style={{ color: colors.foreground, fontFamily: "monospace", lineHeight: 20 }}>
        {rows.length ? rows.map((row) => <Text key={row.cursor} style={{ color: row.stream === "stderr" ? colors.statusWarning : colors.foreground }}>{row.text}</Text>) : "等待输出"}
      </Text>
    </View> : <View style={styles.list}>
      <Note colors={colors}>仅比较运行前后的文件状态，不代表文件一定由本次构建产生。</Note>
      {snapshot?.artifactsLimited ? <Note colors={colors}>已达到扫描上限，仅显示部分结果。</Note> : null}
      {snapshot?.artifacts.length ? snapshot.artifacts.map((a) => <Text key={a.path} selectable style={{ color: colors.foreground }}>{assetLabels[a.state]} · {a.path}</Text>)
        : <Note colors={colors}>{run && rpc.live(run.status) ? "运行结束后查看产物" : "没有可展示的产物记录"}</Note>}
    </View>}
  </View>;
}

function CommandPreview({ plan, colors }: { plan: Command; colors: Colors }) {
  return <View style={[styles.tile, { borderColor: colors.border, backgroundColor: colors.surface1 }]}>
    {plan.preparation?.map((step) => <View key={JSON.stringify(step)} style={styles.step}>
      <Note colors={colors}>先准备依赖 · 目录：{step.cwd}</Note>
      <Text selectable style={[styles.code, { color: colors.foreground }]}>{commandText(step)}</Text>
    </View>)}
    {plan.preparation?.length ? <Note colors={colors}>准备成功后执行</Note> : null}
    <Text selectable style={[styles.code, { color: colors.foreground }]}>{commandText(plan)}</Text>
    <Note colors={colors}>目录：{plan.cwd} · 来源：{plan.source}{"\n"}{plan.tool.version ?? "版本未验证"}{"\n"}{plan.tool.paths.join("\n")}</Note>
  </View>;
}
function Note({ colors, children, warning }: { colors: Colors; children: ReactNode; warning?: boolean }) {
  return <Text selectable style={{ color: warning ? colors.statusWarning : colors.foregroundMuted, lineHeight: 20 }}>{children}</Text>;
}
function Button({ colors, label, onPress, disabled, primary }: { colors: Colors; label: string; onPress(): void; disabled?: boolean; primary?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.button, { alignSelf: "flex-start", borderColor: primary ? colors.accent : colors.border, backgroundColor: primary ? colors.accent : colors.surface1,
      opacity: disabled ? 0.45 : pressed ? 0.75 : 1 }]}>
    <Text style={{ color: primary ? colors.accentForeground : colors.foreground }}>{label}</Text>
  </Pressable>;
}
function Field({ colors, label, value, set, placeholder, multiline }: { colors: Colors; label: string; value: string; set(value: string): void; placeholder?: string; multiline?: boolean }) {
  return <View style={styles.field}>
    <Text style={{ color: colors.foreground }}>{label}</Text>
    <TextInput accessibilityLabel={label} onChangeText={set} value={value} placeholder={placeholder} placeholderTextColor={colors.foregroundMuted}
      autoCapitalize="none" autoCorrect={false} multiline={multiline} maxLength={2048}
      style={[styles.input, { backgroundColor: colors.surface0, borderColor: colors.border, color: colors.foreground }]} />
  </View>;
}
const styles = StyleSheet.create({
  page: { gap: 18, paddingHorizontal: 24, paddingVertical: 18 }, compact: { paddingHorizontal: 12 },
  heading: { fontSize: 23, fontWeight: "700" }, subhead: { fontSize: 16, fontWeight: "600" },
  spread: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 },
  actions: { flexDirection: "row", alignItems: "flex-end", flexWrap: "wrap", gap: 8 },
  runs: { flexDirection: "row", alignItems: "flex-start", gap: 16 }, stacked: { flexDirection: "column", alignItems: "stretch" },
  list: { flex: 1, minWidth: 0, gap: 8 }, detail: { flex: 2, minWidth: 0, gap: 10 },
  tile: { padding: 12, gap: 5, borderWidth: 1, borderRadius: 8 }, step: { gap: 4, paddingBottom: 5 }, code: { fontFamily: "monospace", lineHeight: 20 },
  field: { gap: 5, paddingHorizontal: 12, paddingVertical: 6, minWidth: 156, flexGrow: 1 },
  input: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 9, paddingVertical: 7, minHeight: 36 },
  button: { borderRadius: 6, borderWidth: 1, minHeight: 36, paddingHorizontal: 12, justifyContent: "center" },
});
