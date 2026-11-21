import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { adapter, artifact, live, log, retryable, run, saved, target, targetId, WORKSPACE_TARGET_LIMIT } from "../shared/contracts";
import type { Command, Configuration, Log, Run, Saved, TargetKey } from "../shared/contracts";
import { changes, observe } from "./artifacts";
import { finishCmake, prepareCmake } from "./cmake";
import { GradleCache, type GradleScope, type NativeResult } from "./gradle-cache";
import { gradleProbe, gradleTaskPriority, nativeTarget, parseXcodeProbe } from "./native-projects";
import { digest, inside, missing, readBounded, resolveWithin, workspaceRoot } from "./paths";
import { discoverProjects, type ProjectTarget } from "./projects";
import { launch } from "./process";
import type { Invocation, OwnedProcess } from "./process";
import { assertPackageBindings, buildArguments, preparation, requirement, toolchains, toolIssues, verifyTool } from "./toolchains";

const HISTORY = 24;
const LOG_CHARS = 96 * 1024;
const LOG_ROWS = 512;
const XCODE_PROBE_CHARS = 256 * 1024;
const MAX_ACTIVE = 12;
const MAX_RUNNING = 2;
const entrySchema = z.object({ run, rows: z.array(log), cursor: z.number(), artifacts: z.array(artifact), artifactsLimited: z.boolean(),
  probeStamp: z.string().optional(), probeRoot: z.string().optional(), probeContext: z.string().optional(), probeTool: z.string().optional(),
  probeFilter: z.string().optional(), probeOptions: z.array(z.string()).optional(), probeSession: z.string().optional(), consumed: z.boolean().optional() });
const document = z.object({ sequence: z.number(), configurations: z.array(saved), tools: z.partialRecord(adapter, z.string()).default({}), history: z.array(entrySchema) });
type State = z.infer<typeof document>;
type Entry = z.infer<typeof entrySchema>;
export type Workspace = { id: string; root: string };
type NativeProbe = { adapter: "gradle" | "xcode"; stamp: string; context: string; tool: string; filter?: string; options: string[]; gradleScope?: GradleScope };
type Plan = { command: Command; fingerprint: string; steps: Invocation[]; outputs: string[]; hints: string[]; locks: string[]; configure?: { base: string; dir: string; stamp: string; tool: string };
  nativeProbe?: NativeProbe; consume?: NativeResult["consume"]; cargoReport?: { source?: string; dir: string } };
type Job = { workspace: Workspace; entry: Entry; plan: Plan; process?: OwnedProcess; flush?: ReturnType<typeof setTimeout>; stopTimer?: ReturnType<typeof setTimeout>; before?: ReturnType<typeof observe>; reported?: Set<string>; reportLimited?: boolean };

function cargoMessages(job: Job) {
  const report = job.plan.cargoReport!;
  const root = job.workspace.root;
  const reported = job.reported = new Set<string>();
  let remainder = "";
  let overflow = false;
  return (chunk: string) => {
    let visible = "";
    for (const [i, part] of chunk.split("\n").entries()) {
      if (i > 0) {
        if (!overflow) {
          let value;
          try { value = JSON.parse(remainder); } catch { visible += remainder + "\n"; }
          if (value?.reason === "compiler-message" && typeof value.message?.rendered === "string") visible += value.message.rendered;
          if (value?.reason === "compiler-artifact" && (!report.source || value.manifest_path === report.source)) {
            for (const path of Array.isArray(value.filenames) ? value.filenames : []) {
              if (typeof path !== "string" || !isAbsolute(path) || !inside(report.dir, resolve(path))) continue;
              if (!inside(root, resolve(path)) || reported.size >= 160) { job.reportLimited = true; continue; }
              reported.add(relative(root, resolve(path)));
            }
          }
        }
        remainder = "";
        overflow = false;
      }
      if (remainder.length + part.length <= 256 * 1024 && !overflow) remainder += part;
      else { overflow = true; job.reportLimited = true; }
    }
    return visible;
  };
}
const nativeContext = (tool: string, options: string[]) => digest(JSON.stringify([tool, options]));

export function conflicts(a: { root: string; locks?: string[] }, b: { root: string; locks?: string[] }) {
  const overlaps = (x: string, y: string) => inside(x, y) || inside(y, x);
  return (a.locks ?? [a.root]).some((x) => (b.locks ?? [b.root]).some((y) => overlaps(x, y)));
}

export class Workbench {
  readonly #session = randomUUID();
  readonly #checks = new Map<string, string>();
  readonly #probes = new Set<OwnedProcess>();
  readonly #jobs: Job[] = [];
  readonly #states = new Map<string, State>();
  readonly #gradle: GradleCache;
  #active = true;
  #verificationRoot?: string;
  #closing?: Promise<void>;

  constructor(private readonly data: string, private readonly environment: NodeJS.ProcessEnv = process.env) {
    this.#gradle = new GradleCache(join(data, "gradle-tasks"));
  }

  accept = () => { if (!this.#active) throw new Error("构建工作台未启用或已停止"); };

  #file(id: string) { return join(this.data, digest(id) + ".json"); }
  #state(id: string) {
    const current = this.#states.get(id);
    if (current) return current;
    let state: State;
    try {
      const raw = readBounded(this.#file(id), 12 * 1024 * 1024);
      state = document.parse(JSON.parse(raw));
    } catch (error) {
      if (!missing(error)) throw new Error("无法读取构建工作台的工作区记录", { cause: error });
      state = { sequence: 0, configurations: [], tools: {}, history: [] };
    }
    for (const { run } of state.history) {
      if (live(run.status)) Object.assign(run, { status: "interrupted", result: "工作台已重启，之前的进程状态未知", endedAt: Date.now() });
    }
    if (this.#states.size >= 16) {
      for (const key of this.#states.keys()) {
        if (!this.#jobs.some((job) => job.workspace.id === key)) { this.#states.delete(key); break; }
      }
    }
    this.#states.set(id, state);
    return state;
  }

  #persist(id: string) {
    mkdirSync(this.data, { recursive: true, mode: 0o700 });
    const file = this.#file(id);
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(this.#state(id)), { flag: "wx", mode: 0o600 });
    try { renameSync(temp, file); }
    finally { rmSync(temp, { force: true }); }
  }

  #checkpoint(job: Job) {
    try { this.#persist(job.workspace.id); }
    catch { job.entry.run.result = [job.entry.run.result, "无法保存本次运行记录"].filter(Boolean).join("；"); }
  }

  #gradleScope(w: Workspace, t: ProjectTarget): GradleScope {
    const scoped = resolveWithin(w.root, t.cwd);
    const directory = workspaceRoot(scoped);
    if (directory !== scoped) throw new Error("Gradle 项目目录已变化，请刷新");
    return { directory, stamp: t.stamp, volatileOwner: t.gradle?.volatile ? JSON.stringify([w.id, w.root]) : undefined };
  }

  #nativeResults(w: Workspace, t: ProjectTarget): NativeResult[] {
    const validTool = new Set(toolchains(t, this.environment, new Map(), w.root).map((tool) => tool.signature));
    if (t.gradle) return this.#gradle.read(this.#gradleScope(w, t), validTool);
    const key = targetId({ ...t, name: "list schemes" });
    const scopes = new Set<string>();
    const results: NativeResult[] = [];
    for (const entry of this.#state(w.id).history) {
      const context = entry.probeContext;
      if (entry.probeStamp !== t.stamp || entry.probeRoot !== w.root || !context || !entry.probeTool || !validTool.has(entry.probeTool) ||
          entry.run.status !== "success" || targetId(entry.run.configuration.target) !== key) continue;
      const scope = JSON.stringify([context, entry.probeFilter]);
      if (scopes.has(scope)) continue;
      scopes.add(scope);
      if (t.xcode?.volatile && (entry.consumed || entry.probeSession !== this.#session)) continue;
      results.push({ context, filter: entry.probeFilter, options: entry.probeOptions, names: entry.run.confirmedTargets ?? [], limited: entry.run.confirmedTargetsLimited,
        consume: t.xcode?.volatile ? { id: entry.run.id, take: () => { entry.consumed = true; } } : undefined });
    }
    return results;
  }

  #discovery(w: Workspace) {
    const result = discoverProjects(w.root);
    const ranked: { target: ProjectTarget; priority: number }[] = [];
    for (const t of result.targets) {
      ranked.push({ target: t, priority: t.operation ? 8 : 0 });
      if (!t.operation || !(t.gradle || t.xcode)) continue;
      const probes = this.#nativeResults(w, t);
      const seen = new Set<string>();
      if (probes.some((p) => p.limited)) result.notices.unshift(t.gradle
        ? `${t.source}：探测结果有截断；可用 --workbench-task-filter=:模块: 或任务名片段缩小范围。`
        : `${t.source}：scheme 探测结果有截断。`);
      for (const probe of probes) for (const name of probe.names) {
        if (seen.has(name)) continue;
        seen.add(name);
        const item = nativeTarget(t, name);
        if (item) ranked.push({ target: { ...item, probeOptions: probe.options }, priority: probe === probes[0] && probe.filter ? 7 : item.gradle ? 1 + gradleTaskPriority(name) : 4 });
      }
    }
    if (ranked.length > WORKSPACE_TARGET_LIMIT) {
      result.notices.unshift(`工作区仅显示 ${WORKSPACE_TARGET_LIMIT} 个目标，优先保留探测入口和可直接构建的原生目标。`);
      ranked.sort((a, b) => b.priority - a.priority);
    }
    result.targets = ranked.slice(0, WORKSPACE_TARGET_LIMIT).map((item) => item.target);
    result.notices = result.notices.slice(0, 32);
    return result;
  }

  #lookup(w: Workspace, key: TargetKey): ProjectTarget {
    const result = this.#discovery(w).targets.find((item) => targetId(item) === targetId(key));
    if (!result) throw new Error("目标已删除、移动或不可用，请刷新后重新选择");
    return result;
  }

  discover(w: Workspace) {
    const { targets, notices } = this.#discovery(w);
    return { targets: targets.map((t) => target.parse({ ...t, confirmed: t.confirmed ?? !!t.cmake?.tool })),
      notices, configurations: this.#state(w.id).configurations };
  }
  #cache(w: Workspace, t: TargetKey) {
    const prefix = JSON.stringify([w.id, w.root, t.adapter, t.project]) + ":";
    return new Map([...this.#checks].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key.slice(prefix.length), value]));
  }
  tools(w: Workspace, k: TargetKey) {
    const t = this.#lookup(w, k);
    const candidates = toolchains(t, this.environment, this.#cache(w, t), w.root).map((tool) => tool.candidate);
    return { candidates, requirement: requirement(t), issues: toolIssues(t, this.environment), selected: this.#state(w.id).tools[t.adapter] };
  }
  selectTool(w: Workspace, key: TargetKey, id: string) {
    const { candidates } = this.tools(w, key);
    if (!candidates.some((tool) => tool.id === id)) throw new Error("所选工具不在工作区候选列表中");
    const state = this.#state(w.id);
    state.tools[key.adapter] = id;
    this.#persist(w.id);
    return { selected: id };
  }
  async verify(w: Workspace, c: Configuration) {
    this.accept();
    if (this.#verificationRoot) throw new Error("已有工具检查在进行，请稍后重试");
    if (this.#jobs.some((job) => conflicts({ root: w.root }, { root: job.workspace.root, locks: job.plan.locks }))) {
      throw new Error("此工作区有排队或运行的任务，请在任务结束后检查工具");
    }
    const t = this.#lookup(w, c.target);
    const tool = toolchains(t, this.environment, this.#cache(w, t), w.root).find(({ candidate }) => candidate.id === c.tool);
    if (!tool) throw new Error(toolIssues(t, this.environment).join("；") || "工具不存在或路径已变更，请刷新后重新选择");
    this.#verificationRoot = w.root;
    try {
      const found = await verifyTool(t, tool, this.#probes, this.accept);
      const updated = this.#lookup(w, c.target);
      const refreshed = toolchains(updated, this.environment, new Map(), w.root).find(({ candidate }) => candidate.id === c.tool);
      if (refreshed?.signature !== tool.signature || updated.stamp !== t.stamp) throw new Error("检查期间工具或项目声明发生变化，请重试");
      if (this.#checks.size >= 128) { const oldest = this.#checks.keys().next(); if (!oldest.done) this.#checks.delete(oldest.value); }
      this.#checks.set(JSON.stringify([w.id, w.root, t.adapter, t.project]) + ":" + tool.signature, found);
      return { ...tool.candidate, version: found };
    } finally { this.#verificationRoot = undefined; this.#pump(); }
  }

  #plan(w: Workspace, c: Configuration): Plan {
    this.accept();
    if (w.root !== workspaceRoot(w.root)) throw new Error("工作区目录已变化，请刷新");
    const t = this.#lookup(w, c.target);
    if (t.blocked) throw new Error(t.blocked);
    const tool = toolchains(t, this.environment, this.#cache(w, t), w.root).find(({ candidate }) => candidate.id === c.tool);
    if (!tool) throw new Error("所选工具不存在或路径已变更，请重新选择");
    const build = buildArguments(w.root, t, c.options, tool);
    const args = build.args;
    const hints = t.adapter === "npm" || t.adapter === "pnpm" || t.tauri ? build.outputs.filter((path) => !c.artifacts.includes(path)) : [];
    const outputs = [...new Set([...build.outputs, ...c.artifacts])];
    for (const dir of c.artifacts) {
      const xcodeOutput = t.xcode && (dir === t.xcode.derived || dir.startsWith(t.xcode.derived + "/")) && !dir.split("/").slice(1).some((part) => part.startsWith("."));
      if (!xcodeOutput && (dir === "." || dir.split("/").some((part) => part.startsWith(".")))) throw new Error("产物须指定明确的工作区相对路径（隐藏目录仅支持本次 Xcode 的 DerivedData）");
      resolveWithin(w.root, dir);
    }
    const cwd = resolveWithin(w.root, t.cwd);
    const prep = preparation(w.root, t, tool);
    const notes = [...(tool.overrides ?? [])];
    for (const [name, path] of Object.entries(tool.bindings ?? {})) notes.push(`${name} → ${path}`);
    if (prep.notice) notes.push(prep.notice);
    if (hints.length) notes.push(`产物线索（未经构建工具确认）：${hints.join("、")}`);
    if (!outputs.length && !build.cargoReport && !t.operation) notes.push("未取得原生产物路径；可手填要观察的工作区路径。");
    const context = nativeContext(tool.signature, build.nativeOptions ?? []);
    let consume: NativeResult["consume"];
    if ((t.gradle || t.xcode) && !t.operation) {
      const probe = this.#nativeResults(w, t).find((p) => p.context === context && p.names.includes(t.name));
      if (!probe) throw new Error("当前工具或配置选项下未确认此目标；请先用同一工具和项目配置探测");
      consume = probe.consume;
      if (t.gradle) notes.push("Gradle 任务名与分组不能保证行为；确认这是本地构建或检查，不会发布、签名或操作设备。");
    }
    if (build.taskFilter) notes.push(`仅收录匹配 ${build.taskFilter} 的任务`);
    const command: Command = { cwd: t.cwd, source: t.source, argv: [tool.executable, ...args], tool: tool.candidate,
      ...(prep.steps.length ? { preparation: prep.steps.map(({ cwd, invocation }) => ({ cwd, argv: [invocation.executable, ...invocation.args] })) } : {}), ...(notes.length ? { notes } : {}) };
    const locks = [...new Set([w.root, build.cargo?.targetDir, build.cargo?.buildDir].filter((p): p is string => !!p))];
    const fingerprint = digest(JSON.stringify([w.root, targetId(t), t.stamp, tool.signature, command, outputs, build.cargo, consume?.id]));
    const configure = build.configureDir && t.cmake ? { base: t.cmake.dir, dir: build.configureDir, stamp: t.cmake.stamp, tool: tool.signature } : undefined;
    const nativeProbe = t.operation && (t.adapter === "gradle" || t.adapter === "xcode") ? { adapter: t.adapter, stamp: t.stamp, context, tool: tool.signature,
      filter: build.taskFilter, options: build.nativeOptions ?? [], gradleScope: t.gradle ? this.#gradleScope(w, t) : undefined } : undefined;
    const main = { executable: tool.executable, args, cwd, env: tool.env, bindings: tool.bindings, reapAfterExit: !!t.gradle,
      bindingDirectory: t.cmake ? join(this.data, "cmake-bin", digest(JSON.stringify(tool.bindings ?? {}))) : undefined };
    const cargoReport = build.cargoReport && build.cargo ? { source: t.cargo?.name ? resolveWithin(w.root, t.source) : undefined, dir: build.cargo.targetDir } : undefined;
    return { command, fingerprint, steps: [...prep.steps.map(({ invocation }) => invocation), main], outputs, hints, configure, nativeProbe, consume, cargoReport, locks };
  }
  preview(w: Workspace, c: Configuration) {
    const { command, fingerprint } = this.#plan(w, c);
    return { command, fingerprint };
  }
  save(w: Workspace, c: Saved) {
    this.#plan(w, c);
    const state = this.#state(w.id);
    const configurations = [c, ...state.configurations.filter((old) => old.name !== c.name)];
    if (configurations.length > 24) throw new Error("配置达到上限，请先删除不再使用的配置");
    state.configurations = configurations;
    this.#persist(w.id);
    return configurations;
  }
  remove(w: Workspace, name: string) {
    const state = this.#state(w.id);
    state.configurations = state.configurations.filter((c) => c.name !== name);
    this.#persist(w.id);
    return state.configurations;
  }

  list(w: Workspace) { return this.#state(w.id).history.map((item) => ({ ...item.run })); }
  #entry(w: Workspace, id: string) {
    const entry = this.#state(w.id).history.find((item) => item.run.id === id);
    if (!entry) throw new Error("当前工作区没有这次运行记录");
    return entry;
  }
  detail(w: Workspace, id: string, cursor: number) {
    const entry = this.#entry(w, id);
    const rows = entry.rows.filter((row) => row.cursor > cursor).slice(0, 24);
    return { ...entry, run: { ...entry.run }, rows, cursor: rows.at(-1)?.cursor ?? entry.cursor,
      truncated: cursor < (entry.rows[0]?.cursor ?? entry.cursor + 1) - 1 };
  }

  start(w: Workspace, configuration: Configuration, expected: string) {
    return this.#submit(w, configuration, expected);
  }
  #submit(w: Workspace, configuration: Configuration, expected: string, previewOnly = false) {
    const plan = this.#plan(w, configuration);
    if (previewOnly || plan.fingerprint !== expected) return { kind: "changed" as const, command: plan.command, fingerprint: plan.fingerprint };
    if (!plan.command.tool.version) throw new Error("请先检查所选工具的实际版本");
    if (this.#jobs.length >= MAX_ACTIVE) throw new Error("排队与运行任务已达到宿主上限");
    if (process.platform === "win32") throw new Error("当前仅支持可管理 POSIX 进程组的宿主");
    const state = this.#state(w.id);
    const entry: Entry = { run: { id: randomUUID(), sequence: ++state.sequence, status: "queued", configuration, command: plan.command,
      fingerprint: plan.fingerprint, createdAt: Date.now() }, rows: [], cursor: 0, artifacts: [], artifactsLimited: false };
    const old = state.history;
    state.history = [entry, ...old];
    while (state.history.length > HISTORY) {
      const index = state.history.findLastIndex(({ run }) => !live(run.status) && !this.#jobs.some((job) => job.entry.run.id === run.id));
      if (index < 0) break;
      state.history.splice(index, 1);
    }
    try { this.#persist(w.id); }
    catch (e) { state.history = old; throw e; }
    this.#jobs.push({ workspace: w, plan, entry });
    this.#pump();
    return { kind: "started" as const, run: { ...entry.run } };
  }
  retry(w: Workspace, id: string, fingerprint?: string, previewOnly = false) {
    const { run } = this.#entry(w, id);
    if (!retryable(run.status)) throw new Error("只能重试失败、已停止或中断的任务");
    if (this.#jobs.some((job) => job.entry.run.id === id)) throw new Error("仍未确认原进程退出，暂时不能重试");
    return this.#submit(w, run.configuration, fingerprint ?? run.fingerprint, previewOnly);
  }

  #pump() {
    if (!this.#active) return;
    const running = this.#jobs.filter((job) => job.process);
    const scope = (job: Job) => ({ root: job.workspace.root, locks: job.plan.locks });
    const queues: Job[] = [];
    for (const job of [...this.#jobs]) {
      if (running.length >= MAX_RUNNING) break;
      if (job.process) continue;
      if ((this.#verificationRoot && conflicts(scope(job), { root: this.#verificationRoot })) ||
          [...running, ...queues].some((other) => conflicts(scope(job), scope(other)))) { queues.push(job); continue; }
      try {
        const current = this.#plan(job.workspace, job.entry.run.configuration);
        if (job.plan.fingerprint !== current.fingerprint) throw new Error("排队期间声明或工具发生变化，请检查并重试");
        current.consume?.take();
        if (job.plan.configure) prepareCmake(job.workspace.root, job.plan.configure.base, job.plan.configure.dir);
        job.before = observe(job.workspace.root, job.plan.outputs);
        Object.assign(job.entry.run, { status: "running", startedAt: Date.now() });
        this.#checkpoint(job);
        this.#step(job, current.steps, 0);
        running.push(job);
      } catch (e) { this.#finish(job, "failed", (e as Error).message); }
    }
  }

  #step(job: Job, steps: Invocation[], index: number) {
    const invocation = steps[index]!;
    const preparing = index < steps.length - 1;
    const phase = preparing ? "准备依赖" : job.entry.run.configuration.target.name;
    const relativeCwd = preparing ? job.plan.command.preparation![index]!.cwd : job.plan.command.cwd;
    if (!this.#sameRoot(job.workspace.root) || resolveWithin(job.workspace.root, relativeCwd) !== invocation.cwd) {
      throw new Error("工作区或命令目录已变化，请刷新");
    }
    assertPackageBindings(invocation);
    if (preparing || index > 0) this.#append(job, "stdout", `\n[${phase}] ${JSON.stringify([invocation.executable, ...invocation.args])}\n`);
    const probeAdapter = preparing ? undefined : job.plan.nativeProbe?.adapter;
    const gradle = probeAdapter === "gradle" ? gradleProbe(job.plan.nativeProbe?.filter) : undefined;
    const cargo = !preparing && job.plan.cargoReport ? cargoMessages(job) : undefined;
    let xcodeOutput: string | undefined = "";
    job.process = launch(invocation, (stream, text) => {
      if (stream === "stdout") {
        gradle?.push(text);
        if (probeAdapter === "xcode" && xcodeOutput !== undefined) {
          xcodeOutput = xcodeOutput.length + text.length <= XCODE_PROBE_CHARS ? xcodeOutput + text : undefined;
        }
      }
      this.#append(job, stream, stream === "stdout" && cargo ? cargo(text) : text);
    });
    void job.process.done.then((exit) => {
      if (cargo) this.#append(job, "stdout", cargo("\n"));
      const stopping = !this.#active || ["stopping", "interrupted"].includes(job.entry.run.status);
      if (preparing && !stopping && !exit.stopped && exit.code === 0 && !exit.error) {
        try { this.#step(job, steps, index + 1); }
        catch (error) { this.#finish(job, "failed", (error as Error).message); this.#pump(); }
        return;
      }
      const description = exit.error ?? (exit.signal ? `信号 ${exit.signal}` : `退出码 ${exit.code}`);
      let status: Run["status"] = (exit.stopped || stopping) ? "stopped" : exit.code === 0 && !exit.error ? "success" : "failed";
      let result = preparing ? `依赖准备未完成：${description}` : description;
      if (status === "success" && !this.#sameRoot(job.workspace.root)) {
        status = "failed"; result = "工作区路径已变化，无法确认产物或探测结果";
      }
      if (status === "success" && job.plan.configure) {
        const { base, dir, stamp, tool } = job.plan.configure;
        try { finishCmake(job.workspace.root, job.entry.run.configuration.target.project, base, dir, stamp, tool); result += "；刷新目标以读取 File API"; }
        catch (error) { status = "failed"; result = (error as Error).message; }
      }
      if (status === "success" && job.plan.nativeProbe) {
        const { stamp, context, tool, filter, options, gradleScope } = job.plan.nativeProbe;
        try {
          if (xcodeOutput === undefined) throw new Error("探测输出超过读取上限");
          const reported = gradle ? gradle.finish() : parseXcodeProbe(xcodeOutput);
          const key = job.entry.run.configuration.target;
          const probe = discoverProjects(job.workspace.root).targets.find((t) => targetId(t) === targetId(key) && t.stamp === stamp && t.operation);
          if (!probe) throw new Error("探测期间项目声明已变化，请重新探测");
          const confirmed = reported.names.filter((name) => nativeTarget(probe, name));
          if (gradleScope) {
            const current = this.#gradleScope(job.workspace, probe);
            const tools = toolchains(probe, this.environment, new Map(), job.workspace.root);
            if (current.directory !== gradleScope.directory || current.volatileOwner !== gradleScope.volatileOwner || !tools.some((candidate) => candidate.signature === tool)) {
              throw new Error("探测期间 Gradle 目录、声明或工具发生变化，请重新探测");
            }
            this.#gradle.publish(current, { context, tool, filter, options, names: confirmed, limited: reported.limited });
          } else {
            job.entry.probeStamp = stamp;
            job.entry.probeRoot = job.workspace.root;
            Object.assign(job.entry, { probeContext: context, probeTool: tool, probeFilter: filter, probeOptions: options, probeSession: this.#session });
          }
          job.entry.run.confirmedTargets = confirmed;
          if (reported.limited) job.entry.run.confirmedTargetsLimited = true;
          result += reported.limited ? `；保留 ${confirmed.length} 个可选目标，部分条目未收录` : `；发现 ${confirmed.length} 个可选目标，刷新后可查看`;
        } catch (error) { status = "failed"; result = (error as Error).message; }
      }
      this.#finish(job, status, result);
      this.#pump();

    });
  }

  #append(job: Job, stream: Log["stream"], text: string) {
    const { entry } = job;
    if (!text) return;
    // Render as text, not terminal control sequences. StringDecoder preserves UTF-8 across pipe reads.
    text = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "");
    for (let offset = 0; offset < text.length; offset += 2048) entry.rows.push({ cursor: ++entry.cursor, stream, text: text.slice(offset, offset + 2048) });
    let size = entry.rows.reduce((total, row) => total + row.text.length, 0);
    while (entry.rows.length > LOG_ROWS || size > LOG_CHARS) size -= entry.rows.shift()?.text.length ?? 0;
    if (!job.flush) job.flush = setTimeout(() => { job.flush = undefined; this.#checkpoint(job); }, 500);
  }
  #sameRoot(root: string) {
    try { return workspaceRoot(root) === root; }
    catch { return false; }
  }
  #finish(job: Job, status: Run["status"], result: string) {
    if (job.flush) clearTimeout(job.flush);
    if (job.stopTimer) clearTimeout(job.stopTimer);
    if (job.before && !this.#sameRoot(job.workspace.root)) job.entry.artifactsLimited = true;
    else if (job.before) {
      const found = changes(job.before, observe(job.workspace.root, job.plan.outputs));
      for (const item of found.artifacts) if (job.plan.hints.some((hint) => item.path === hint || item.path.startsWith(hint + "/")) &&
          !job.entry.run.configuration.artifacts.some((path) => item.path === path || item.path.startsWith(path + "/"))) item.origin = "hint";
      const observed = new Set(found.artifacts.map(({ path }) => path));
      const reported = observe(job.workspace.root, [...(job.reported ?? [])].filter((path) => !observed.has(path)));
      for (const [path, observation] of reported.files) if (observation && typeof observation === "object" && !observation.directory) {
        found.artifacts.push({ path, state: "existing", origin: "native" });
      }
      job.entry.artifacts = found.artifacts;
      job.entry.artifactsLimited = found.artifactsLimited || !!job.reportLimited || reported.limited;
    }
    Object.assign(job.entry.run, { status, result, endedAt: Date.now() });
    this.#checkpoint(job);
    this.#jobs.splice(this.#jobs.indexOf(job), 1);
  }
  stop(w: Workspace, id: string) {
    const entry = this.#entry(w, id);
    const job = this.#jobs.find((j) => j.entry === entry);
    if (!job) return { ...entry.run };
    this.#stop(job);
    this.#pump();
    return { ...entry.run };
  }
  #stop(job: Job) {
    if (!job.process) { this.#finish(job, "stopped", "已移出队列"); return; }
    if (job.entry.run.status !== "stopping" && job.entry.run.status !== "interrupted") {
      job.entry.run.status = "stopping";
      job.process.stop();
      job.stopTimer = setTimeout(() => {
        Object.assign(job.entry.run, { status: "interrupted", result: "未能确认进程组退出；暂不释放输出占用" });
        this.#checkpoint(job);
      }, 5000);
      job.stopTimer.unref();
      this.#checkpoint(job);
    }
  }
  close() {
    if (this.#closing) return this.#closing;
    this.#active = false;
    for (const job of [...this.#jobs]) this.#stop(job);
    for (const probe of this.#probes) probe.stop();
    const settling = [...this.#probes, ...this.#jobs.flatMap((job) => job.process ? [job.process] : [])];
    this.#closing = new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 5500);
      void Promise.allSettled(settling.map((p) => p.done)).then(() => { clearTimeout(timeout); resolve(); });
    });
    return this.#closing;
  }
}
