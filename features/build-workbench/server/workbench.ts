import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { adapter, artifact, live, log, retryable, run, saved, target, targetId } from "../shared/contracts";
import type { Command, Configuration, Log, Run, Saved, TargetKey } from "../shared/contracts";
import { changes, observe } from "./artifacts";
import { finishCmake, prepareCmake } from "./cmake";
import { nativeTarget, parseNativeProbe } from "./native-projects";
import { digest, inside, missing, readBounded, resolveWithin, workspaceRoot } from "./paths";
import { discoverProjects, type ProjectTarget } from "./projects";
import { launch } from "./process";
import type { Invocation, OwnedProcess } from "./process";
import { buildArguments, preparation, requirement, toolchains, toolIssues, verifyTool } from "./toolchains";

const HISTORY = 24;
const LOG_CHARS = 96 * 1024;
const LOG_ROWS = 512;
const MAX_ACTIVE = 12;
const MAX_RUNNING = 2;
const entrySchema = z.object({ run, rows: z.array(log), cursor: z.number(), artifacts: z.array(artifact), artifactsLimited: z.boolean(), probeStamp: z.string().optional(), probeRoot: z.string().optional(), preparationCompleted: z.boolean().optional() });
const document = z.object({ sequence: z.number(), configurations: z.array(saved), tools: z.partialRecord(adapter, z.string()).default({}), history: z.array(entrySchema) });
type State = z.infer<typeof document>;
type Entry = z.infer<typeof entrySchema>;
export type Workspace = { id: string; root: string };
type Plan = { command: Command; fingerprint: string; steps: Invocation[]; outputs: string[]; locks?: string[]; configure?: { dir: string; stamp: string; tool: string }; nativeProbe?: { adapter: "gradle" | "xcode"; stamp: string } };
type Job = { workspace: Workspace; entry: Entry; plan: Plan; forcePreparation: boolean; process?: OwnedProcess; flush?: ReturnType<typeof setTimeout>; stopTimer?: ReturnType<typeof setTimeout>; before?: ReturnType<typeof observe>; probeOutput?: string; probeLimited?: boolean };

export function conflicts(a: { root: string; locks?: string[] }, b: { root: string; locks?: string[] }) {
  const overlaps = (x: string, y: string) => inside(x, y) || inside(y, x);
  if (!a.locks || !b.locks) return overlaps(a.root, b.root);
  return a.locks.some((x) => b.locks!.some((y) => overlaps(x, y)));
}

export class Workbench {
  readonly #checks = new Map<string, string>();
  readonly #probes = new Set<OwnedProcess>();
  readonly #jobs: Job[] = [];
  readonly #states = new Map<string, State>();
  #active = true;
  #verificationRoot?: string;
  #closing?: Promise<void>;

  constructor(private readonly data: string, private readonly environment: NodeJS.ProcessEnv = process.env) {}

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

  #discovery(w: Workspace) {
    const result = discoverProjects(w.root);
    const history = this.#state(w.id).history;
    result.targets = result.targets.flatMap((t) => {
      if (!t.operation || !(t.gradle || t.xcode)) return [t];
      const probe = history.find((entry) => entry.probeStamp === t.stamp && entry.probeRoot === w.root &&
        entry.run.status === "success" && targetId(entry.run.configuration.target) === targetId(t));
      return [t, ...(probe?.run.confirmedTargets ?? []).flatMap((name) => {
        const item = nativeTarget(t, name);
        return item ? [item] : [];
      })];
    }).slice(0, 512);
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

  #plan(w: Workspace, c: Configuration, forcePreparation = false): Plan {
    this.accept();
    if (w.root !== workspaceRoot(w.root)) throw new Error("工作区目录已变化，请刷新");
    const t = this.#lookup(w, c.target);
    if (t.blocked) throw new Error(t.blocked);
    const tool = toolchains(t, this.environment, this.#cache(w, t), w.root).find(({ candidate }) => candidate.id === c.tool);
    if (!tool) throw new Error("所选工具不存在或路径已变更，请重新选择");
    const build = buildArguments(w.root, t, c.options, tool);
    const args = build.args;
    const outputs = [...new Set([...build.outputs, ...c.artifacts])];
    for (const dir of c.artifacts) {
      if (dir === "." || dir.split("/").some((part) => part.startsWith("."))) throw new Error("产物须指定明确的非隐藏工作区相对路径");
      resolveWithin(w.root, dir);
    }
    const cwd = resolveWithin(w.root, t.cwd);
    const prep = preparation(w.root, t, tool, forcePreparation);
    const command: Command = { cwd: t.cwd, source: t.source, argv: [tool.executable, ...args], tool: tool.candidate,
      ...(prep.length ? { preparation: prep.map(({ cwd, invocation }) => ({ cwd, argv: [invocation.executable, ...invocation.args] })) } : {}) };
    const fingerprint = digest(JSON.stringify([w.root, targetId(t), t.stamp, tool.signature, command, outputs]));
    const configure = t.operation === "probe" && t.cmake ? { ...t.cmake, tool: tool.signature } : undefined;
    const nativeProbe = t.operation && (t.adapter === "gradle" || t.adapter === "xcode") ? { adapter: t.adapter, stamp: t.stamp } : undefined;
    const main = { executable: tool.executable, args, cwd, env: tool.env, reapAfterExit: !!t.gradle };
    return { command, fingerprint, steps: [...prep.map(({ invocation }) => invocation), main], outputs, configure, nativeProbe, locks: t.writes?.map((p) => resolveWithin(w.root, p)) };
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
  #submit(w: Workspace, configuration: Configuration, expected: string, forcePreparation = false, previewOnly = false) {
    const plan = this.#plan(w, configuration, forcePreparation);
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
    this.#jobs.push({ workspace: w, plan, entry, forcePreparation });
    this.#pump();
    return { kind: "started" as const, run: { ...entry.run } };
  }
  retry(w: Workspace, id: string, fingerprint?: string, previewOnly = false) {
    const { run, preparationCompleted } = this.#entry(w, id);
    if (!retryable(run.status)) throw new Error("只能重试失败、已停止或中断的任务");
    if (this.#jobs.some((job) => job.entry.run.id === id)) throw new Error("仍未确认原进程退出，暂时不能重试");
    const forcePreparation = !!run.command.preparation?.length && preparationCompleted !== true;
    return this.#submit(w, run.configuration, fingerprint ?? run.fingerprint, forcePreparation, previewOnly);
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
        const current = this.#plan(job.workspace, job.entry.run.configuration, job.forcePreparation);
        if (job.plan.fingerprint !== current.fingerprint) throw new Error("排队期间声明或工具发生变化，请检查并重试");
        if (job.plan.configure) prepareCmake(job.workspace.root, job.plan.configure.dir);
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
    if (preparing || index > 0) this.#append(job, "stdout", `\n[${phase}] ${JSON.stringify([invocation.executable, ...invocation.args])}\n`);
    job.process = launch(invocation, (stream, text) => {
      if (!preparing && job.plan.nativeProbe && stream === "stdout" && !job.probeLimited) {
        if ((job.probeOutput?.length ?? 0) + text.length <= 256 * 1024) job.probeOutput = (job.probeOutput ?? "") + text;
        else { job.probeOutput = undefined; job.probeLimited = true; }
      }
      this.#append(job, stream, text);
    });
    void job.process.done.then((exit) => {
      const stopping = !this.#active || ["stopping", "interrupted"].includes(job.entry.run.status);
      if (preparing && !stopping && !exit.stopped && exit.code === 0 && !exit.error) {
        if (index === steps.length - 2) {
          job.entry.preparationCompleted = true;
          this.#checkpoint(job);
        }
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
        const { dir, stamp, tool } = job.plan.configure;
        try { finishCmake(job.workspace.root, dir, stamp, tool); result += "；刷新目标以读取 File API"; }
        catch (error) { status = "failed"; result = (error as Error).message; }
      }
      if (status === "success" && job.plan.nativeProbe) {
        const { adapter, stamp } = job.plan.nativeProbe;
        try {
          if (job.probeLimited) throw new Error("探测输出超过读取上限");
          const reported = parseNativeProbe(adapter, job.probeOutput ?? "");
          const key = job.entry.run.configuration.target;
          const probe = discoverProjects(job.workspace.root).targets.find((t) => targetId(t) === targetId(key) && t.stamp === stamp && t.operation);
          if (!probe) throw new Error("探测期间项目声明已变化，请重新探测");
          job.entry.probeStamp = stamp;
          job.entry.probeRoot = job.workspace.root;
          job.entry.run.confirmedTargets = reported.filter((name) => nativeTarget(probe, name));
          result += `；发现 ${job.entry.run.confirmedTargets.length} 个可选目标，刷新后可查看`;
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
      job.entry.artifacts = found.artifacts;
      job.entry.artifactsLimited = found.artifactsLimited;
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
