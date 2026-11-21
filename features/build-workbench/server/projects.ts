import { lstatSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import JSON5 from "json5";
import { minimatch } from "minimatch";
import { parse as yaml } from "yaml";
import { WORKSPACE_TARGET_LIMIT, type Target } from "../shared/contracts";
import { at, digest, projectDirs, readText, resolveWithin } from "./paths";
import { dependencyPaths, rustPin, str, strings, table, toml } from "./rust-projects";
import { discoverCmake } from "./cmake";
import { discoverGradle, discoverXcode } from "./native-projects";
import type { Gradle, Xcode } from "./native-projects";
import { misePin } from "./mise";

export type ProjectTarget = Target & {
  cwd: string;
  stamp: string;
  requirements: { node?: string; manager?: string; managerEngine?: string; miseNode?: string; rust?: string; rustChannel?: string; rustPath?: string; rustIssue?: string; miseCmake?: string; miseJava?: string };
  cargo?: { name?: string; workspace: string };
  cmake?: { dir: string; stamp: string; preset?: string; target?: string; configurations?: Record<string, string[]>; tool?: string };
  tauri?: { cli?: true; workspace: string; manager?: "npm" | "pnpm" };
  install?: { cwd: string; lock?: string; workspace?: boolean; required: { from: string; name: string; version: string }[] };
  gradle?: Gradle;
  xcode?: Xcode;
  // Only populate this when the adapter can bound its writes. Artifact paths are not locks.
  writes?: string[];
};
export type Discovery = { targets: ProjectTarget[]; notices: string[] };
export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const version = (value: unknown) => typeof value === "string" && value.length < 128 ? value : undefined;
export const safeName = (name: string) => /^[\w@][\w@./:+-]{0,127}$/u.test(name);
export function json(text: string) {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { throw new Error("无效 JSON：" + (error as Error).message); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("需要 JSON 对象");
  return object(value);
}

function outputHints(root: string, project: string, manifest: Record<string, unknown>): string[] {
  // Literal package publication/entry paths and existing conventional directories are hints only.
  const names = [...(Array.isArray(manifest.files) ? manifest.files : []), manifest.main, manifest.module, manifest.types];
  const hints = new Set<string>();
  for (const name of names) {
    if (typeof name !== "string" || /[*?\[\]{}]/u.test(name)) continue;
    const path = at(project, name.replace(/^\.\//u, "").replace(/\/$/u, ""));
    try { resolveWithin(root, path); hints.add(path); }
    catch { /* Ignore paths that cannot be observed within the workspace. */ }
  }
  for (const name of ["dist", "build", "out", "lib"]) {
    const path = at(project, name);
    try { if (lstatSync(resolveWithin(root, path)).isDirectory()) hints.add(path); }
    catch { /* Conventional outputs are still candidates before the first build. */ }
  }
  return [...(hints.size ? hints : ["dist", "build", "out"].map((name) => at(project, name)))].slice(0, 16);
}

type Read = (path: string) => string | undefined;

type JsOwner = { cwd: string; manager: "npm" | "pnpm" } | { issue: string };

function packageTools(root: string, project: string, installRoot: string, data: Record<string, unknown>, parent: Record<string, unknown>, read: Read, owner?: JsOwner) {
  if (owner && "issue" in owner) throw new Error(owner.issue);
  const lock = (name: string) => {
    try {
      const stat = lstatSync(resolveWithin(root, at(installRoot, name)), { bigint: true });
      return stat.isFile() ? { name, stamp: [stat.size, stat.mtimeNs, stat.ctimeNs].join(":") } : undefined;
    } catch { return undefined; }
  };
  const pin = (name: string) => misePin(project, name, read);
  const nodePin = pin("node");
  const declared = version(data.packageManager) ?? version(parent.packageManager);
  if (declared && !/^(?:npm|pnpm)@/u.test(declared)) return;
  const pnpm = read(at(installRoot, "pnpm-workspace.yaml"));
  const pnpmLock = lock("pnpm-lock.yaml");
  const npmLock = lock("npm-shrinkwrap.json") ?? lock("package-lock.json");
  if ([data, parent].some((pkg) => object(pkg.devEngines).packageManager !== undefined)) {
    throw new Error("当前无法验证 devEngines.packageManager 声明的包管理器切换规则");
  }
  const explicit = declared?.startsWith("pnpm@") ? "pnpm" : declared ? "npm" : undefined;
  const manager = owner?.manager ?? explicit ?? (pnpm !== undefined || pnpmLock ? "pnpm" : "npm");
  if (explicit && explicit !== manager) throw new Error(`packageManager 声明与 ${installRoot} 的 ${manager} 工作区冲突`);
  if (!owner && !explicit && pnpmLock && npmLock) throw new Error("同时找到 npm 和 pnpm 锁文件，请用 packageManager 明确选择");
  const installConfig = readText(root, at(installRoot, ".npmrc"));
  const memberConfig = project === installRoot ? undefined : readText(root, at(project, ".npmrc"));
  const workspaceConfig = pnpm === undefined ? {} : object(yaml(pnpm, { maxAliasCount: 0 }));
  if ([installConfig, memberConfig].some((text) => /^\s*(?:use-node-version|node-version-for-run|nodeVersionForRun|node-options-for-run)\s*=/imu.test(text ?? "")) ||
      workspaceConfig.useNodeVersion || workspaceConfig.nodeVersionForRun || [data, parent].some((pkg) =>
        object(pkg.devEngines).runtime !== undefined || object(pkg.executionEnv).nodeVersion !== undefined ||
        object(object(pkg.pnpm).executionEnv).nodeVersion !== undefined || pkg.runtime !== undefined)) {
    throw new Error("项目声明单独管理脚本运行时；目前无法确认实际 Node 与所选工具一致");
  }
  const required = (project === installRoot ? [[project, data]] as const : [[installRoot, parent], [project, data]] as const)
    .flatMap(([from, pkg]) => Object.entries({ ...object(pkg.dependencies), ...object(pkg.devDependencies), ...object(pkg.optionalDependencies), ...object(pkg.peerDependencies) }).flatMap(([name, version]) =>
      /^(?:@[\w.-]+\/)?[\w-][\w.-]*$/u.test(name) && typeof version === "string" ? [{ from, name, version }] : [])).slice(0, 256);
  return { manager, install: { cwd: installRoot, lock: (manager === "pnpm" ? pnpmLock : npmLock)?.name, workspace: !!owner, required },
    stamp: [declared, pnpm, pnpmLock, npmLock, installConfig, memberConfig, nodePin, pin(manager)],
    requirements: { node: version(object(data.engines).node) ?? version(object(parent.engines).node), miseNode: nodePin,
      managerEngine: version(object(data.engines)[manager]) ?? version(object(parent.engines)[manager]),
      manager: declared?.split("@")[1]?.split("+sha")[0] ?? pin(manager) } } as const;
}

export function discoverProjects(root: string): Discovery {
  const targets: ProjectTarget[] = [];
  const notices: string[] = [];
  const read = (source: string) => {
    try { return readText(root, source); }
    catch (e) { notices.push(source + "：" + (e as Error).message); return undefined; }
  };
  const rootText = read("package.json");
  let manifest: Record<string, unknown> = {};
  if (rootText !== undefined) {
    try { manifest = json(rootText); }
    catch (e) { notices.push("package.json：" + (e as Error).message); }
  }
  const scan = projectDirs(root);
  const dirs = scan.dirs;
  if (scan.limited) notices.push("目录扫描范围有限（深度 4、目录 256、条目 4096，跳过依赖、隐藏和输出目录）。");
  const jsRoots = new Map<string, JsOwner>();
  const packages = new Map<string, { text: string; data: Record<string, unknown> }>();
  const readPackage = (dir: string) => {
    if (packages.has(dir)) return;
    const source = at(dir, "package.json");
    const text = dir === "." ? rootText : read(source);
    if (text === undefined) return;
    try { packages.set(dir, { text, data: dir === "." ? manifest : json(text) }); }
    catch (e) { notices.push(source + "：" + (e as Error).message); }
  };
  for (const dir of dirs) readPackage(dir);
  // Evaluate ownership per manager; an excluded package is never implicitly installed through pnpm at its ancestor.
  for (const dir of dirs) {
    const data = packages.get(dir)?.data ?? {};
    const fromNpm = Array.isArray(data.workspaces) ? data.workspaces : object(data.workspaces).packages;
    const pnpmPath = at(dir, "pnpm-workspace.yaml");
    let pnpm: string | undefined;
    let patterns: unknown = fromNpm;
    let manager: "npm" | "pnpm" = "npm";
    let issue: string | undefined;
    try {
      pnpm = readText(root, pnpmPath);
      if (pnpm !== undefined) {
        manager = "pnpm";
        const config: unknown = yaml(pnpm, { maxAliasCount: 0 });
        if (config !== null && (typeof config !== "object" || Array.isArray(config))) throw new Error("pnpm 工作区声明不是映射");
        const data = object(config);
        patterns = Object.hasOwn(data, "packages") ? data.packages : [];
        if (version(data.packageManager)?.startsWith("npm@")) throw new Error("pnpm 工作区与 npm packageManager 声明冲突");
      } else if (version(data.packageManager)?.startsWith("pnpm@") && fromNpm !== undefined) {
        throw new Error("pnpm 工作区需用 pnpm-workspace.yaml 声明成员");
      }
      if ((patterns !== undefined || data.workspaces !== undefined) && (!Array.isArray(patterns) || patterns.length > 64 || patterns.some((p) => !supportedPattern(p)))) {
        throw new Error("工作区成员模式无法确认");
      }
    } catch (e) { issue = `${pnpmPath}：${(e as Error).message}`; notices.push(issue); }
    if (issue) {
      for (const child of packages.keys()) if (child === dir || dir === "." || child.startsWith(dir + "/")) jsRoots.set(child, { issue });
      continue;
    }
    if (patterns === undefined) continue;
    const owner = { cwd: dir, manager };
    const parent = jsRoots.get(dir);
    if (parent && "cwd" in parent && parent.cwd !== dir) {
      jsRoots.set(dir, { issue: `嵌套工作区入口也属于 ${parent.cwd}，无法确认安装归属` });
      continue;
    }
    jsRoots.set(dir, owner);
    for (const sub of declaredDirs(resolveWithin(root, dir), patterns, notices, manager)) {
      const member = at(dir, sub);
      readPackage(member);
      jsRoots.set(member, owner);
    }
    if (manager === "pnpm") for (const [child, pkg] of packages) {
      if (child === dir || (dir !== "." && !child.startsWith(dir + "/")) || jsRoots.has(child)) continue;
      const declared = version(pkg.data.packageManager);
      const npmLock = ["package-lock.json", "npm-shrinkwrap.json"].some((name) => {
        try { return lstatSync(resolveWithin(root, at(child, name))).isFile(); } catch { return false; }
      });
      if ((!declared || declared.startsWith("npm@")) && (declared?.startsWith("npm@") || npmLock)) continue;
      jsRoots.set(child, { issue: `${child} 不属于 ${dir} 的 pnpm 工作区；如为独立项目，请声明其工作区或 npm 管理器` });
    }
  }
  for (const [project, { text, data }] of packages) {
    const source = at(project, "package.json");
    try {
      const owner = jsRoots.get(project);
      const installRoot = owner && "cwd" in owner ? owner.cwd : project;
      const parent = packages.get(installRoot);
      const info = packageTools(root, project, installRoot, data, parent?.data ?? {}, read, owner);
      if (!info) { notices.push(`${source}：包管理器不是 npm 或 pnpm。`); continue; }
      for (const [name, script] of Object.entries(object(data.scripts))) {
        if (!safeName(name) || typeof script !== "string" || !script.trim() || /^(pre|post)(install|publish)|(?::watch$)|^(install|publish|deploy|release|push|sign|dev|start|watch|preview)(:|$)/iu.test(name)) continue;
        if (targets.length >= WORKSPACE_TARGET_LIMIT) { notices.unshift(`目标发现达到上限（${WORKSPACE_TARGET_LIMIT} 项）`); break; }
        targets.push({ adapter: info.manager, project, name, source, cwd: project, stamp: digest(JSON.stringify([parent?.text, text, info.stamp])),
          requirements: info.requirements, install: info.install, outputs: outputHints(root, project, data),
        });
      }
    } catch (e) { notices.push(source + "：" + (e as Error).message); }
  }
  const cargoWorkspaces = discoverCargo(root, dirs, read, notices, targets);
  discoverTauri(root, dirs, jsRoots, cargoWorkspaces, read, notices, targets);
  discoverCmake(root, notices, targets);
  discoverGradle(root, dirs, notices, targets);
  discoverXcode(root, notices, targets);
  if (!targets.length) notices.push("未找到任务。已检查 npm/pnpm、Cargo、CMake、Tauri、Gradle 与 Xcode 清单；修改清单后可刷新。");
  if (targets.length > WORKSPACE_TARGET_LIMIT) {
    targets.sort((a, b) => Number(!!b.operation) - Number(!!a.operation));
    notices.unshift(`目标发现达到上限（${WORKSPACE_TARGET_LIMIT} 项），优先保留探测入口。`);
  }
  return { targets: targets.slice(0, WORKSPACE_TARGET_LIMIT), notices: [...new Set(notices)].slice(0, 32) };
}

function observePath(root: string, base: string, path: string | undefined) {
  if (!path || isAbsolute(path) || /^[a-z][\w+.-]*:/iu.test(path)) return undefined;
  const rel = relative(root, resolve(root, base, path));
  if (!rel) return undefined;
  try { resolveWithin(root, rel); return rel; }
  catch { return undefined; }
}

function discoverCargo(root: string, dirs: string[], read: Read, notices: string[], targets: ProjectTarget[]) {
  const projects = new Map<string, { text: string; data: ReturnType<typeof toml> }>();
  function load(dir: string) {
    const existing = projects.get(dir);
    if (existing) return existing;
    const source = at(dir, "Cargo.toml");
    try {
      const text = read(source);
      if (text === undefined) return;
      const value = { text, data: toml(text) };
      projects.set(dir, value);
      return value;
    } catch (error) { notices.push(`${source}：${(error as Error).message}`); }
  }
  for (const dir of dirs) load(dir);
  const workspaces = new Map<string, string>();
  for (const [dir, { data }] of projects) {
    if (!data.workspace) continue;
    const workspace = table(data.workspace);
    const exclude = strings(workspace.exclude);
    const members = declaredDirs(resolve(root, dir), [...strings(workspace.members), ...exclude.map((p) => "!" + p)], notices);
    const pending = [dir, ...members.map((member) => at(dir, member))];
    const seen = new Set<string>();
    for (let i = 0; i < pending.length && seen.size < 256; i++) {
      const member = pending[i]!;
      if (seen.has(member)) continue;
      seen.add(member);
      const entry = load(member);
      if (!entry || (member !== dir && entry.data.workspace)) continue;
      workspaces.set(member, dir);
      for (const dep of dependencyPaths(entry.data, workspace)) {
        const next = observePath(root, dep.startsWith("\0") ? dir : member, dep.replace(/^\0/u, ""));
        if (!next || (dir !== "." && !next.startsWith(dir + "/")) || exclude.some((glob) => minimatch(relative(resolve(root, dir), resolve(root, next)), glob, { nobrace: true, noext: true }))) continue;
        if (!seen.has(next) && pending.length < 1024) pending.push(next);
      }
    }
    if (pending.length >= 256) notices.push(`${dir}：Cargo 成员扫描达到上限`);
  }
  for (const [project, { text, data }] of projects) {
    const source = at(project, "Cargo.toml");
    const pkg = table(data.package);
    const name = str(pkg.name);
    if (data.package && (!name || !/^[\w-]+$/u.test(name))) { notices.push(source + "：未读取到有效的 [package].name"); continue; }
    if (!name && !data.workspace) continue;
    const explicit = str(pkg.workspace);
    const owner = explicit ? observePath(root, project, explicit) ?? (resolve(root, project, explicit) === root ? "." : undefined) : workspaces.get(project);
    if (explicit && (!owner || !projects.get(owner)?.data.workspace || workspaces.get(project) !== owner)) {
      notices.push(`${source}：无法确认 package.workspace 的成员归属`); continue;
    }
    const cwd = owner ?? project;
    const ws = table(projects.get(cwd)?.data.workspace);
    const pin = rustPin(root, cwd);
    const rust = table(pkg["rust-version"]).workspace === true ? str(table(ws.package)["rust-version"]) : str(pkg["rust-version"]);
    const stamp = digest(JSON.stringify([text, projects.get(cwd)?.text, pin]));
    const base = { adapter: "cargo" as const, project, source, cwd, stamp, requirements: { rust, ...pin }, outputs: [] };
    if (name) targets.push({ ...base, name, cargo: { name, workspace: cwd } });
    if (data.workspace) targets.push({ ...base, name: "build (workspace)", cargo: { workspace: cwd } });
  }
  return workspaces;
}

function discoverTauri(root: string, dirs: string[], jsRoots: Map<string, JsOwner>, cargoWorkspaces: Map<string, string>, read: Read, notices: string[], targets: ProjectTarget[]) {
  const apps = dirs.flatMap((native) => {
    const entries = ["tauri.conf.json", "tauri.conf.json5", "Tauri.toml"].map((name) => at(native, name))
      .flatMap((source) => { const conf = read(source); return conf === undefined ? [] : [{ source, conf }]; });
    return entries.map((entry) => ({ native, project: native === "." ? "." : dirname(native), ...entry }));
  });
  for (const { native, project, source, conf } of apps) {
    const manifest = read(at(native, "Cargo.toml"));
    if (!manifest) { notices.push(`${source}：缺少 Cargo.toml`); continue; }
    try {
      // The CLI searches from its cwd and offers no stable argument that selects a different Rust app.
      if (apps.filter((app) => app.native === project || dirname(app.native) === project).length !== 1 || (native !== project && native !== at(project, "src-tauri"))) {
        throw new Error("无法从 CLI 工作目录唯一绑定此 Rust 应用（支持目录本身或 src-tauri）");
      }
      const pkgText = read(at(project, "package.json"));
      const pkg = pkgText === undefined ? {} : json(pkgText);
      const confData = source.endsWith(".toml") ? toml(conf) : object(source.endsWith(".json5") ? JSON5.parse(conf) : json(conf));
      const frontendOutput = observePath(root, native, str(table(confData.build).frontendDist));
      const cargo = table(toml(manifest).package);
      const owner = jsRoots.get(project);
      const installRoot = owner && "cwd" in owner ? owner.cwd : project;
      const parentText = project === installRoot ? pkgText : read(at(installRoot, "package.json"));
      const parent = parentText === undefined ? {} : json(parentText);
      const dependency = (data: Record<string, unknown>) => object(data.devDependencies)["@tauri-apps/cli"] ?? object(data.dependencies)["@tauri-apps/cli"];
      const declaredCli = pkgText !== undefined && !!(dependency(pkg) || dependency(parent));
      const js = declaredCli ? packageTools(root, project, installRoot, pkg, parent, read, owner) : undefined;
      if (declaredCli && !js) throw new Error("无法确认所声明的 Tauri JS CLI 使用 npm 或 pnpm");
      const cli = js ? true : undefined;
      const workspace = cargoWorkspaces.get(native) ?? native;
      const wsText = workspace === native ? manifest : read(at(workspace, "Cargo.toml"));
      const ws = wsText ? table(toml(wsText).workspace) : {};
      const pin = rustPin(root, native);
      const rust = { rust: table(cargo["rust-version"]).workspace === true ? str(table(ws.package)["rust-version"]) : str(cargo["rust-version"]), ...pin };
      const outputs = frontendOutput ? [frontendOutput] : [];
      targets.push({ adapter: "tauri", project: native, source, cwd: project, name: "build (Debug, no bundle)",
        stamp: digest(JSON.stringify([conf, manifest, wsText, pkgText, parentText, js?.stamp, pin])),
        tauri: { cli, manager: js?.manager, workspace }, install: js?.install, requirements: { ...js?.requirements, ...rust }, outputs });
    } catch (error) { notices.push(`${source}：${(error as Error).message}`); }
  }
}

function supportedPattern(p: unknown): p is string {
  return typeof p === "string" && p.length < 256 && !p.includes("\\") && !/\*\*\*/u.test(p) &&
    !p.replace(/^!+/u, "").replace(/^\.?\/+/u, "").split("/").some((part) => part === ".." || part.startsWith("."));
}

export function declaredDirs(root: string, raw: unknown, notices: string[], manager: "npm" | "pnpm" | "cargo" = "cargo") {
  if (!Array.isArray(raw)) return [];
  const patterns = raw.slice(0, 64).filter(supportedPattern);
  let series = patterns;
  if (manager === "npm") {
    const positives: string[] = [];
    let negatives: string[] = [];
    for (const raw of patterns) {
      const bangs = /^!+/u.exec(raw)?.[0].length ?? 0;
      const pattern = raw.slice(bangs).replace(/^\.?\/+/u, "").replace(/\/$/u, "");
      if (bangs % 2) negatives.push(pattern);
      else {
        negatives = negatives.filter((excluded) => !minimatch(pattern, excluded, { nonegate: true }));
        positives.push(pattern);
      }
    }
    series = [...positives, ...negatives.map((p) => "!" + p)];
  } else if (manager === "pnpm") series = [...patterns.filter((p) => !p.startsWith("!")), ...patterns.filter((p) => p.startsWith("!"))];
  const { dirs, limited } = scanDeclared(root, series, manager);
  if (limited) notices.push("项目声明扫描达到上限（深度 4、目录 256、条目 4096）");
  return dirs;
}

function scanDeclared(root: string, patterns: string[], manager: "npm" | "pnpm" | "cargo") {
  if (!patterns.length) return { dirs: [], limited: false };
  const scan = projectDirs(root);
  const selected = new Set<string>();
  for (const raw of patterns) {
    const excluded = raw.startsWith("!");
    const pattern = (excluded ? raw.slice(1) : raw).replace(/^\.\//u, "").replace(/\/$/u, "");
    if (!pattern || pattern.split("/").some((s) => !s || s === ".." || s.startsWith("."))) continue;
    const matches = scan.dirs.filter((p) => p !== "." && minimatch(p, pattern, { nonegate: true, nocomment: true, nobrace: manager === "cargo", noext: manager === "cargo" }));
    if (!/[?*\[\]{}()]/u.test(pattern)) {
      try { if (lstatSync(resolveWithin(root, pattern)).isDirectory()) matches.push(pattern); }
      catch { /* The declaration may refer to an absent or external package. */ }
    }
    for (const p of matches) if (excluded) selected.delete(p); else selected.add(p);
  }
  return { dirs: [...selected], limited: scan.limited };
}
