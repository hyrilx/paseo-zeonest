import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { clearInterval, setInterval, setTimeout, clearTimeout } from "node:timers";
import type { ConfigDocument, DocumentKind, PackageRequest, Preferences, Preview, Resource, Scope, Snapshot } from "../shared/contracts";
import { preferencesSchema } from "../shared/contracts";
import { isObject, packageEnabled, parseObject, resourceTypes, setProperty, skillMetadata, sourceOf, validateConfig } from "../shared/config";
import { discover, packageIdentity, packagePath, resolveResourcePath } from "./discovery";
import { assertRevision, atomicWrite, canonical, copyTree, fileDiff, hash, lockTargets, readState, revalidate, target, treeDiff, treeState, validateTreeLinks, MAX_TEXT, type FileState, type Target, type TreeState } from "./files";

interface Edit { before: FileState; after: string }
interface TreeEdit { target: Target; before: TreeState; after: TreeState; staged: string }
interface Plan { preview: Preview; edits: Edit[]; guards: FileState[]; trees: TreeEdit[]; staging?: string; scope: Scope; directory: string }
export interface RunOptions { cwd: string; env: Record<string, string | undefined>; signal: AbortSignal }
export type Runner = (executable: string, args: string[], options: RunOptions) => Promise<void>;
export const runCommand: Runner = (executable, args, options) => new Promise((done, fail) => {
  if (options.signal.aborted) { fail(new Error("包操作已取消。")); return; }
  const group = process.platform !== "win32";
  const child = spawn(executable, args, { cwd: options.cwd, env: options.env, shell: false, detached: group, stdio: ["ignore", "pipe", "pipe"] });
  // Never echo package output: registries, git URLs and subprocess errors can contain credentials.
  child.stdout?.resume(); child.stderr?.resume();
  const stop = () => { try { if (group && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Already exited. */ } };
  const timer = setTimeout(stop, 180_000);
  options.signal.addEventListener("abort", stop, { once: true });
  const cleanup = () => { clearTimeout(timer); options.signal.removeEventListener("abort", stop); };
  child.once("error", () => { cleanup(); fail(new Error("无法启动 Pi 包命令；请检查宿主 Pi 可执行文件与 npm/git 是否可用。")); });
  child.once("close", (code) => {
    cleanup();
    if (code === 0) done();
    else fail(new Error(`Pi 包命令失败或已取消（退出码 ${code ?? "未知"}）。正式配置未更改；检查源地址、网络及权限。`));
  });
});
interface Options {
  home?: string; agentDir?: string; runner?: Runner; now?: () => number;
  writeFile?: typeof atomicWrite;
  workspaceDirectory(id: string): Promise<string>;
}
export class PiSettingsService {
  readonly home: string;
  readonly defaultAgentDir: string;
  private readonly preferencesTarget: Target;
  private readonly plans = new Map<string, Plan>();
  private readonly now: () => number;
  private readonly runner: Runner;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private readonly abort = new AbortController();
  private staging = false;
  private disposed = false;
  constructor(private readonly options: Options) {
    this.home = options.home ?? homedir();
    this.defaultAgentDir = resolveResourcePath(options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(this.home, ".pi", "agent"), this.home, this.home);
    this.preferencesTarget = target(join(this.defaultAgentDir, "zeonest-pi-settings.json"), this.defaultAgentDir);
    this.now = options.now ?? Date.now; this.runner = options.runner ?? runCommand;
    this.cleanupTimer = setInterval(() => { this.expire(); }, 60_000); this.cleanupTimer.unref();
  }
  private active() { if (this.disposed) throw new Error("Pi 设置服务已停止，请重新打开页面。"); }
  private expire() { for (const [token, plan] of this.plans) if (Date.parse(plan.preview.expiresAt) <= this.now()) this.discard(token); }
  discard(token: string): boolean {
    const plan = this.plans.get(token); if (!plan) return false;
    this.plans.delete(token); if (plan.staging) rmSync(plan.staging, { recursive: true, force: true }); return true;
  }
  dispose() { this.disposed = true; this.abort.abort(); clearInterval(this.cleanupTimer); for (const token of this.plans.keys()) this.discard(token); }
  private preferences(): { state: FileState; values: Preferences } {
    const state = readState(this.preferencesTarget);
    return { state: { ...state, mode: 0o600 }, values: preferencesSchema.parse(parseObject(state.text ?? "{}")) };
  }
  private async location(scope: Scope, prefs: Preferences) {
    const agentDir = resolveResourcePath(prefs.agentDir || this.defaultAgentDir, this.home, this.home);
    const directory = scope.workspaceId ? await this.options.workspaceDirectory(scope.workspaceId) : agentDir;
    if (!isAbsolute(directory)) throw new Error("工作区未提供绝对目录。");
    const base = scope.workspaceId ? join(directory, ".pi") : agentDir;
    if (scope.workspaceId) target(base, directory); // A project's .pi link may not redirect into global or unrelated files.
    return { agentDir, directory, base };
  }
  private document(kind: DocumentKind, base: string, agentDir: string): FileState {
    const t = kind === "preferences" ? this.preferencesTarget : kind === "models" ? target(join(agentDir, "models.json"), agentDir) : target(join(base, `${kind === "mcp" ? "mcp" : "settings"}.json`), base);
    const state = readState(t);
    return kind === "preferences" || kind === "models" || base === agentDir ? { ...state, mode: 0o600 } : state;
  }
  async snapshot(scope: Scope): Promise<Snapshot> {
    this.active(); this.expire();
    const warnings: string[] = [];
    let prefs: Preferences; let prefState: FileState;
    try { ({ state: prefState, values: prefs } = this.preferences()); }
    catch { prefState = readState(this.preferencesTarget); prefs = preferencesSchema.parse({}); warnings.push("本页偏好文件无效；目录选择和写入已停用，请在「页面设置」修复后保存。"); }
    const { agentDir, directory, base } = await this.location(scope, prefs);
    const documents: ConfigDocument[] = [];
    for (const kind of ["settings", "models", "mcp", "preferences"] as const) {
      try {
        const state = kind === "preferences" ? prefState : this.document(kind, base, agentDir);
        let error: string | null = null;
        try { if (kind === "preferences") preferencesSchema.parse(parseObject(state.text ?? "{}")); else validateConfig(kind, state.text ?? "{}", kind === "models" ? false : Boolean(scope.workspaceId)); }
        catch (e) { error = e instanceof Error ? e.message : "配置无效"; }
        documents.push({ kind, path: state.target.path, text: state.text ?? "{}\n", exists: state.text !== null, revision: state.revision, error });
      } catch (e) { documents.push({ kind, path: kind === "preferences" ? this.preferencesTarget.path : join(kind === "models" ? agentDir : base, `${kind}.json`), text: "", exists: true, revision: "unreadable", error: e instanceof Error ? e.message : "文件不可读" }); }
    }
    const safeObject = (text: string): Record<string, unknown> => { try { return parseObject(text); } catch { return {}; } };
    let globalSettings = documents.find((d) => d.kind === "settings")!.text;
    let globalMcp = documents.find((d) => d.kind === "mcp")!.text;
    if (scope.workspaceId) {
      try { globalSettings = readState(target(join(agentDir, "settings.json"), agentDir)).text ?? "{}"; parseObject(globalSettings); }
      catch { globalSettings = "{}"; warnings.push("全局 settings.json 无法读取，继承信息可能不完整。"); }
      try { globalMcp = readState(target(join(agentDir, "mcp.json"), agentDir)).text ?? "{}"; parseObject(globalMcp); }
      catch { globalMcp = "{}"; warnings.push("全局 mcp.json 无法读取，继承信息可能不完整。"); }
    }
    const selected = safeObject(documents.find((d) => d.kind === "settings")!.text);
    const scopes = [{ base: agentDir, scope: "global" as const, settings: safeObject(globalSettings) }, ...(scope.workspaceId ? [{ base, scope: "project" as const, settings: selected, cwd: directory }] : [])];
    const found = discover(scopes, this.home);
    const packages = (Array.isArray(selected.packages) ? selected.packages : []).map((entry) => {
      const source = sourceOf(entry); let path: string | null = null; let version: string | null = null;
      try {
        const root = packagePath(source, base, this.home); if (existsSync(root)) path = root;
        if (path && existsSync(join(path, "package.json"))) { const metadata = parseObject(readFileSync(join(path, "package.json"), "utf8")); if (typeof metadata.version === "string") version = metadata.version; }
      } catch { warnings.push(`无法定位包：${source}`); }
      return { source, path, version, enabled: packageEnabled(entry) };
    });
    return { scope, directory, agentDir, defaultAgentDir: this.defaultAgentDir, preferences: prefs, documents, globalSettings, globalMcp, packages, resources: found.resources, warnings: [...warnings, ...found.warnings] };
  }
  private async resource(scope: Scope, id: string): Promise<{ resource: Resource; state: FileState }> {
    const snapshot = await this.snapshot(scope); const resource = snapshot.resources.find((r) => r.id === id);
    if (!resource) throw new Error("资源已移动、已移除或不在当前范围，请重新读取。");
    // Discovery produced an exact file, including authorized explicit symlinks. Preserve its link.
    const real = canonical(resource.path); const state = readState(target(resource.path, dirname(real)));
    if (state.text === null) throw new Error("资源文件已删除。");
    return { resource, state };
  }
  async readResource(scope: Scope, id: string) { const { state } = await this.resource(scope, id); return { text: state.text!, revision: state.revision }; }
  private async addPlan(scope: Scope, title: string, edits: Edit[], guards: FileState[], trees: TreeEdit[] = [], staging?: string): Promise<Preview> {
    this.active(); this.expire();
    if (this.plans.size >= 8) throw new Error("待确认操作过多，请先取消旧操作或等待过期。");
    const { values, state } = this.preferences();
    const { directory } = await this.location(scope, values);
    for (const edit of edits) if (Buffer.byteLength(edit.after, "utf8") > MAX_TEXT || edit.after.includes("\u0000")) throw new Error("配置必须是不含 NUL 的 UTF-8 文本，最大 1 MiB。");
    const changed = edits.filter((e) => e.before.text !== e.after);
    const changedTrees = trees.filter((t) => t.before.revision !== t.after.revision);
    const changes = changed.map((e) => fileDiff(e.before.target.path, e.before.text, e.after));
    // npm's own configuration is part of the review too; payload files are summarized separately.
    for (const tree of changedTrees) for (const file of ["package.json", "package-lock.json", ".gitignore"]) {
      const oldPath = join(tree.target.real, file); const newPath = join(tree.staged, file);
      const before = readState(target(oldPath, tree.target.real)).text;
      const after = readState(target(newPath, tree.staged)).text;
      if (before !== after) changes.push(fileDiff(join(tree.target.path, file), before, after));
    }
    if (changes.reduce((n, change) => n + change.diff.length, 0) > 2_000_000) throw new Error("diff 超过 2 MB，拒绝无法完整审阅的写入。");
    const preview: Preview = { token: randomUUID(), title, expiresAt: new Date(this.now() + 20 * 60_000).toISOString(), confirmationRequired: values.confirmDiff,
      changes, artifacts: changedTrees.map((t) => treeDiff(t.target.path, t.before, t.after)),
      warnings: trees.length ? ["包将在下次 Pi 启动或 /reload 时运行，拥有 Pi 进程的完整权限。暂存未加载扩展，npm 生命周期脚本被禁用。", "安装目录按内容指纹校验；下载的依赖与代码文件以数量汇总，配置文件 diff 逐项展示。"] : [] };
    this.plans.set(preview.token, { preview, edits: changed, guards: [...guards, state], trees: changedTrees, staging, scope, directory });
    return preview;
  }
  async prepare(scope: Scope, requests: { kind: DocumentKind; text: string; revision: string }[]) {
    this.active();
    // Repairing an invalid preference file is allowed, but no other write may silently fall back to defaults.
    const prefState = readState(this.preferencesTarget);
    const onlyPrefs = requests.length === 1 && requests[0]?.kind === "preferences";
    let prefs: Preferences;
    try { prefs = this.preferences().values; } catch { if (!onlyPrefs) throw new Error("请先修复页面偏好文件。"); prefs = preferencesSchema.parse({}); }
    const { base, agentDir } = await this.location(scope, prefs);
    const kinds = new Set<string>(); const edits: Edit[] = [];
    for (const request of requests) {
      if (kinds.has(request.kind)) throw new Error("同一文件不能重复修改。"); kinds.add(request.kind);
      if (request.kind === "models" && scope.workspaceId) throw new Error("请切换到全局管理供应商。");
      if (request.kind === "preferences") {
        const next = preferencesSchema.parse(parseObject(request.text));
        if (next.agentDir && !isAbsolute(next.agentDir) && !next.agentDir.startsWith("~/")) throw new Error("agent 目录必须为绝对路径或 ~/ 开头。");
        if (/[\r\n\u0000]/.test(next.piExecutable)) throw new Error("Pi 可执行文件路径包含无效字符。");
      } else validateConfig(request.kind, request.text, Boolean(scope.workspaceId));
      const before = this.document(request.kind, base, agentDir); assertRevision(before, request.revision); edits.push({ before, after: request.text });
    }
    if (onlyPrefs) {
      // addPlan normally reads valid preferences; an explicit repair still requires confirmation.
      try { this.preferences(); } catch {
        const preview: Preview = { token: randomUUID(), title: "修复页面偏好", expiresAt: new Date(this.now() + 1_200_000).toISOString(), confirmationRequired: true, changes: edits.map((e) => fileDiff(e.before.target.path, e.before.text, e.after)), artifacts: [], warnings: [] };
        this.plans.set(preview.token, { preview, edits, guards: [prefState], trees: [], scope, directory: (await this.location(scope, prefs)).directory }); return preview;
      }
    }
    return this.addPlan(scope, "保存 Pi 配置", edits, [prefState]);
  }
  async prepareResource(scope: Scope, id: string, text: string, revision: string) {
    const { resource, state } = await this.resource(scope, id);
    if (resource.kind !== "skill") throw new Error("扩展代码仅供查看；请使用项目编辑器修改代码。");
    const metadata = skillMetadata(text);
    if (!metadata.description.trim()) throw new Error("技能必须有非空的 description 才能被 Pi 加载。");
    assertRevision(state, revision);
    return this.addPlan(scope, "保存技能文件（影响该文件的所有使用者）", [{ before: state, after: text }], []);
  }
  async preparePackage(scope: Scope, request: PackageRequest): Promise<Preview> {
    this.active(); if (this.staging) throw new Error("另一个包操作正在暂存，请等待完成。");
    const { state: prefState, values: prefs } = this.preferences(); assertRevision(prefState, request.preferencesRevision);
    const { base, agentDir } = await this.location(scope, prefs);
    const settings = this.document("settings", base, agentDir); assertRevision(settings, request.revision);
    const config = validateConfig("settings", settings.text ?? "{}", Boolean(scope.workspaceId));
    const packages = Array.isArray(config.packages) ? config.packages : [];
    const identity = packageIdentity(request.source, base, this.home);
    const samePackage = (entry: unknown) => packageIdentity(sourceOf(entry), base, this.home) === identity;
    const current = packages.find((entry) => sourceOf(entry) === request.source) ?? (request.action === "install" ? packages.find(samePackage) : undefined);
    if (request.action !== "install" && packages.filter(samePackage).length > 1) throw new Error("此范围有重复的包身份，请先在原始配置中合并声明。");
    if (request.action !== "install" && current === undefined) throw new Error("此范围未配置这个包。");
    if (request.action === "enable" || request.action === "disable") {
      const key = hash(`${settings.target.real}\0${request.source}`); const backups = { ...prefs.packageBackups };
      const next = packages.map((entry) => {
        if (sourceOf(entry) !== request.source || packageEnabled(entry) === (request.action === "enable")) return entry;
        if (request.action === "disable") { backups[key] = entry; return { ...(isObject(entry) ? entry : { source: entry }), ...Object.fromEntries(resourceTypes.map((kind) => [kind, []])) }; }
        const original = backups[key]; delete backups[key];
        if (original !== undefined) {
          if (sourceOf(original) !== request.source) throw new Error("停用备份与当前包不匹配，请在页面偏好中修复备份。");
          return original;
        }
        const value: Record<string, unknown> = isObject(entry) ? { ...entry } : { source: entry }; for (const kind of resourceTypes) delete value[kind]; return value;
      });
      const nextSettings = setProperty(settings.text ?? "{}\n", ["packages"], next);
      validateConfig("settings", nextSettings, Boolean(scope.workspaceId));
      return this.addPlan(scope, `${request.action === "enable" ? "启用" : "停用"} Pi 包`, [
        { before: settings, after: nextSettings },
        { before: prefState, after: setProperty(prefState.text ?? "{}\n", ["packageBackups"], backups) },
      ], [prefState]);
    }
    const source = request.source.trim();
    if (!/^(npm:|git:|https:\/\/)/.test(source) || /[\r\n\u0000]/.test(source)) throw new Error("联网操作只接受 npm:、git: 或 HTTPS Git 源；本地路径请在配置引用中管理。");
    packagePath(source, base, this.home); // Validate source before invoking a process.
    this.staging = true;
    const staging = mkdtempSync(join(tmpdir(), "zeonest-pi-stage-"));
    try {
      const stageAgent = join(staging, "agent"); const cwd = join(staging, "project"); mkdirSync(stageAgent); mkdirSync(cwd);
      // Only one package declaration goes into this isolated agent. No extensions, secrets, trust hooks or configured npm wrapper are loaded.
      const stageSettings = { packages: current === undefined ? [] : [current], npmCommand: ["npm", "--ignore-scripts"] };
      writeFileSync(join(stageAgent, "settings.json"), JSON.stringify(stageSettings), { mode: 0o600 });
      const installKind = source.startsWith("npm:") ? "npm" : "git";
      const liveTarget = target(join(base, installKind), base); const before = treeState(liveTarget.real);
      copyTree(liveTarget.real, join(stageAgent, installKind));
      // Freshly clone Git updates instead of running copied repository hooks or local Git config.
      if (installKind === "git" && request.action !== "remove") rmSync(packagePath(source, stageAgent, this.home), { recursive: true, force: true });
      const args = request.action === "update" ? (installKind === "git" ? ["install", source] : ["update", "--extension", source]) : [request.action, source];
      await this.runner(prefs.piExecutable, args, { cwd, signal: this.abort.signal, env: { ...process.env, PI_CODING_AGENT_DIR: stageAgent, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", npm_config_ignore_scripts: "true", GIT_TERMINAL_PROMPT: "0" } });
      this.active();
      const stagedRoot = join(stageAgent, installKind); validateTreeLinks(stagedRoot); const after = treeState(stagedRoot);
      const stagedConfig = parseObject(readFileSync(join(stageAgent, "settings.json"), "utf8"));
      const stagedPackages = Array.isArray(stagedConfig.packages) ? stagedConfig.packages : [];
      let next = packages;
      if (request.action === "install") {
        const installed = stagedPackages.find((entry) => sourceOf(entry) === source);
        if (!installed) throw new Error("Pi 未返回预期包声明，拒绝应用。");
        const replacement = isObject(current) ? { ...current, source } : installed;
        next = [...packages.filter((entry) => !samePackage(entry)), replacement];
      } else if (request.action === "remove") next = packages.filter((entry) => sourceOf(entry) !== source);
      const text = request.action === "update" ? (settings.text ?? "{}\n") : setProperty(settings.text ?? "{}\n", ["packages"], next);
      validateConfig("settings", text, Boolean(scope.workspaceId));
      return await this.addPlan(scope, `${({ install: "安装", remove: "卸载", update: "检查并更新" } as const)[request.action]} ${source}`, [{ before: settings, after: text }], [settings, prefState], [{ target: liveTarget, before, after, staged: stagedRoot }], staging);
    } catch (e) { rmSync(staging, { recursive: true, force: true }); throw e; }
    finally { this.staging = false; }
  }
  async commit(token: string, confirmed: boolean) {
    this.active(); this.expire(); const plan = this.plans.get(token);
    if (!plan) throw new Error("预览已过期或已取消，请重新生成。");
    if (plan.preview.confirmationRequired && !confirmed) throw new Error("此操作需要确认 diff。");
    let prefs: Preferences; try { prefs = this.preferences().values; } catch { prefs = preferencesSchema.parse({}); }
    if ((await this.location(plan.scope, prefs)).directory !== plan.directory) throw new Error("目标工作区或 agent 目录已改变，请重新生成预览。");
    const release = lockTargets([...plan.edits.map((e) => e.before.target.real), ...plan.guards.map((g) => g.target.real), ...plan.trees.map((t) => t.target.real)]);
    const applied: Edit[] = []; const promoted: { tree: TreeEdit; backup: string; hadOriginal: boolean }[] = [];
    const temporary: string[] = [];
    try {
      for (const file of [...plan.guards, ...plan.edits.map((e) => e.before)]) assertRevision(readState(file.target), file.revision);
      for (const tree of plan.trees) {
        revalidate(tree.target);
        if (treeState(tree.target.real).revision !== tree.before.revision || treeState(tree.staged).revision !== tree.after.revision) throw new Error("安装目录或暂存内容已改变，请重新生成预览。");
      }
      for (const tree of plan.trees) {
        mkdirSync(dirname(tree.target.real), { recursive: true, mode: 0o700 });
        const incoming = join(dirname(tree.target.real), `.zeonest-incoming-${randomUUID()}`); temporary.push(incoming);
        copyTree(tree.staged, incoming);
        const backup = join(dirname(tree.target.real), `.zeonest-backup-${randomUUID()}`);
        const hadOriginal = existsSync(tree.target.real); if (hadOriginal) renameSync(tree.target.real, backup);
        promoted.push({ tree, backup, hadOriginal });
        if (existsSync(incoming)) renameSync(incoming, tree.target.real);
      }
      for (const edit of plan.edits) { assertRevision(readState(edit.before.target), edit.before.revision); (this.options.writeFile ?? atomicWrite)(edit.before.target, edit.after, edit.before.mode); applied.push(edit); }
    } catch (error) {
      const failures: string[] = [];
      for (const edit of applied.reverse()) try {
        assertRevision(readState(edit.before.target), hash(edit.after));
        atomicWrite(edit.before.target, edit.before.text, edit.before.mode);
      } catch { failures.push(edit.before.target.path); }
      for (const { tree, backup, hadOriginal } of promoted.reverse()) try {
        if (treeState(tree.target.real).revision !== tree.after.revision) throw new Error("安装目录已被外部修改");
        rmSync(tree.target.real, { recursive: true, force: true }); if (hadOriginal) renameSync(backup, tree.target.real);
      } catch { failures.push(backup); }
      if (failures.length) throw new Error(`写入失败且回滚不完整，保留备份需人工恢复：${failures.join("、")}`);
      throw error;
    } finally { try { for (const path of temporary) rmSync(path, { recursive: true, force: true }); } finally { release(); } }
    for (const { backup } of promoted) rmSync(backup, { recursive: true, force: true });
    this.discard(token);
    return { message: "已应用。请在 Pi 中 /reload 或开启新会话；不会重启 Paseo daemon 或中断当前 agent。" };
  }
}
