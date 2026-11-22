import { lstatSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import JSON5 from "json5";
import { minimatch } from "minimatch";
import { parse as yaml } from "yaml";
import { WORKSPACE_TARGET_LIMIT, type Target } from "../shared/contracts";
import { at, digest, inside, parentDirectories, projectDirs, readDeclaration, readText, resolveWithin } from "./paths";
import { dependencyPaths, rustPin, str, strings, table, toml } from "./rust-projects";
import { discoverCmake } from "./cmake";
import { discoverGradle, discoverXcode } from "./native-projects";
import type { Gradle, Xcode } from "./native-projects";
import { misePin } from "./mise";

type JsRequirements = { node?: string; manager?: string; managerEngine?: string; miseNode?: string; miseManager?: string };
export type ProjectTarget = Target & {
  cwd: string;
  stamp: string;
  requirements: JsRequirements & { install?: JsRequirements; rust?: string; rustChannel?: string; rustPath?: string; rustIssue?: string; miseCmake?: string; miseJava?: string };
  cargo?: { name?: string; workspace: string };
  cmake?: { dir: string; stamp: string; preset?: string; target?: string; configurations?: Record<string, string[]>; writePaths?: Record<string, string[]>; defaultConfig?: string; tool?: string };
  tauri?: { cli?: { owner: string; spec: string }; workspace: string; frontend: string; manager?: "npm" | "pnpm"; declaration: string };
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
  const pnpm = readText(root, at(installRoot, "pnpm-workspace.yaml"));
  const pnpmLock = lock("pnpm-lock.yaml");
  const npmLock = lock("npm-shrinkwrap.json") ?? lock("package-lock.json");
  if ([data, parent].some((pkg) => object(pkg.devEngines).packageManager !== undefined)) {
    throw new Error("当前无法验证 devEngines.packageManager 声明的包管理器切换规则");
  }
  const explicit = declared?.startsWith("pnpm@") ? "pnpm" : declared ? "npm" : undefined;
  const manager = owner?.manager ?? explicit ?? (pnpm !== undefined || pnpmLock ? "pnpm" : "npm");
  if (explicit && explicit !== manager) throw new Error(`packageManager 声明与 ${installRoot} 的 ${manager} 工作区冲突`);
  if (!owner && !explicit && pnpmLock && npmLock) throw new Error("同时找到 npm 和 pnpm 锁文件，请用 packageManager 明确选择");
  assertJsBoundary(root, installRoot, manager, !!owner);
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
  const declaration = [declared, pnpm, installConfig, memberConfig, nodePin, pin(manager)];
  return { manager, install: { cwd: installRoot, lock: (manager === "pnpm" ? pnpmLock : npmLock)?.name, workspace: !!owner, required },
    declaration, stamp: [declaration, pnpmLock, npmLock],
    requirements: { node: version(object(data.engines).node) ?? version(object(parent.engines).node), miseNode: nodePin,
      managerEngine: version(object(data.engines)[manager]) ?? version(object(parent.engines)[manager]),
      manager: declared?.split("@")[1]?.split("+sha")[0], miseManager: pin(manager),
      install: project === installRoot ? undefined : { node: version(object(parent.engines).node), managerEngine: version(object(parent.engines)[manager]),
        miseNode: misePin(installRoot, "node", read), manager: version(parent.packageManager)?.split("@")[1]?.split("+sha")[0], miseManager: misePin(installRoot, manager, read) } } } as const;
}

function assertJsBoundary(root: string, installRoot: string, manager: "npm" | "pnpm", declaredRoot: boolean) {
  // Check ancestors of the actual installation directory, not just the directories scanned for targets.
  const directory = resolveWithin(root, installRoot);
  if (manager === "pnpm" && declaredRoot) return; // pnpm uses the nearest workspace declaration.
  for (const parent of parentDirectories(directory)) {
    const external = !inside(root, parent);
    const read = (name: string) => external ? readDeclaration(parent, name) : readText(root, at(relative(root, parent) || ".", name));
    const rel = relative(parent, directory);
    if (manager === "npm") {
      const pnpm = read("pnpm-workspace.yaml");
      if (pnpm !== undefined) {
        const declaration: unknown = yaml(pnpm, { maxAliasCount: 0 });
        const config = object(declaration);
        const patterns = Object.hasOwn(config, "packages") ? config.packages : [];
        if ((declaration !== null && (typeof declaration !== "object" || Array.isArray(declaration))) || !validatedPatterns(patterns) ||
            patternIncludes(rel, workspacePatterns(patterns, "pnpm"), "pnpm")) {
          throw new Error(`上级 pnpm 工作区 ${parent} 可能包含该包；请打开该目录确认包归属，不改用 npm 运行`);
        }
      }
      const text = read("package.json");
      const data = text === undefined ? {} : json(text);
      const patterns = Array.isArray(data.workspaces) ? data.workspaces : object(data.workspaces).packages;
      if (data.workspaces === undefined) continue;
      if (!validatedPatterns(patterns) || patternIncludes(rel, workspacePatterns(patterns, "npm"), "npm")) {
        throw new Error(`npm 可能将包并入上级工作区 ${parent}；请打开该目录确认安装根`);
      }
    } else {
      const text = read("pnpm-workspace.yaml");
      if (text === undefined) continue;
      // Even an excluded package can inherit pnpm workspace settings. Do not
      // run a standalone pnpm install inside an unresolved ancestor workspace.
      throw new Error(`pnpm 发现上级工作区 ${parent}，无法确认独立安装范围；请打开该目录确认包归属`);
    }
  }
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
        const pnpmConfig = object(config);
        patterns = Object.hasOwn(pnpmConfig, "packages") ? pnpmConfig.packages : [];
        if (version(data.packageManager)?.startsWith("npm@")) throw new Error("pnpm 工作区与 npm packageManager 声明冲突");
      } else if (version(data.packageManager)?.startsWith("pnpm@") && fromNpm !== undefined) {
        throw new Error("pnpm 工作区需用 pnpm-workspace.yaml 声明成员");
      }
      if ((patterns !== undefined || data.workspaces !== undefined) && !validatedPatterns(patterns)) {
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

function cargoExcluded(workspace: Record<string, unknown>, rel: string) {
  const exclusions = strings(workspace.exclude).map((glob) => glob.replace(/^\.\//u, "").replace(/\/$/u, ""));
  const parts = rel.split("/");
  return parts.some((_, i) => exclusions.some((glob) => minimatch(parts.slice(0, i + 1).join("/"), glob, { nobrace: true, noext: true, nonegate: true })));
}

type CargoOwner = { cwd: string } | { issue: string };

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
      if (!entry || (member !== dir && (entry.data.workspace || cargoExcluded(workspace, relative(resolve(root, dir), resolve(root, member)))))) continue;
      workspaces.set(member, dir);
      for (const dep of dependencyPaths(entry.data, workspace)) {
        const next = observePath(root, dep.startsWith("\0") ? dir : member, dep.replace(/^\0/u, ""));
        if (!next || (dir !== "." && !next.startsWith(dir + "/")) || cargoExcluded(workspace, relative(resolve(root, dir), resolve(root, next)))) continue;
        if (!seen.has(next) && pending.length < 1024) pending.push(next);
      }
    }
    if (pending.length >= 256) notices.push(`${dir}：Cargo 成员扫描达到上限`);
  }
  const ownership = new Map<string, CargoOwner>();
  const outsideManifests = new Map<string, string | undefined>();
  for (const [project, { text, data }] of projects) {
    const source = at(project, "Cargo.toml");
    const pkg = table(data.package);
    const name = str(pkg.name);
    if (data.package && (!name || !/^[\w-]+$/u.test(name))) { notices.push(source + "：未读取到有效的 [package].name"); continue; }
    if (!name && !data.workspace) continue;
    let cwd: string;
    try {
      const directory = resolveWithin(root, project);
      if (data.workspace) cwd = project;
      else if (pkg.workspace !== undefined) {
        const explicit = str(pkg.workspace);
        if (!explicit) throw new Error("无法确认 package.workspace 的成员归属");
        const parent = resolve(directory, explicit);
        if (!inside(root, parent)) throw new Error(`Cargo 工作区位于当前范围之外，请打开父工作区 ${parent}`);
        cwd = relative(root, parent) || ".";
        resolveWithin(root, cwd);
        if (!projects.get(cwd)?.data.workspace || workspaces.get(project) !== cwd) throw new Error("无法确认 package.workspace 的成员归属");
      } else {
        cwd = project;
        for (const parent of parentDirectories(directory)) {
          const local = inside(root, parent);
          const parentKey = relative(root, parent) || ".";
          if (!local && !outsideManifests.has(parent)) outsideManifests.set(parent, readDeclaration(parent, "Cargo.toml"));
          const external = outsideManifests.get(parent);
          const declaration = local ? load(parentKey)?.data : external === undefined ? undefined : toml(external);
          if (!declaration?.workspace) continue;
          if (cargoExcluded(table(declaration.workspace), relative(parent, directory))) break;
          if (!local) throw new Error(`Cargo 工作区位于当前范围之外，请打开父工作区 ${parent}`);
          if (workspaces.get(project) !== parentKey) throw new Error(`当前包位于 ${parentKey} 的 Cargo 工作区下，但未确认是成员；请检查 members、路径依赖和 exclude`);
          cwd = parentKey;
          break;
        }
      }
    } catch (error) {
      const issue = (error as Error).message;
      ownership.set(project, { issue });
      notices.push(`${source}：${issue}`);
      continue;
    }
    ownership.set(project, { cwd });
    const ws = table(projects.get(cwd)?.data.workspace);
    const pin = rustPin(root, cwd);
    const rust = table(pkg["rust-version"]).workspace === true ? str(table(ws.package)["rust-version"]) : str(pkg["rust-version"]);
    const stamp = digest(JSON.stringify([text, projects.get(cwd)?.text, pin]));
    const base = { adapter: "cargo" as const, project, source, cwd, stamp, requirements: { rust, ...pin }, outputs: [] };
    if (name) targets.push({ ...base, name, cargo: { name, workspace: cwd } });
    if (data.workspace) targets.push({ ...base, name: "build (workspace)", cargo: { workspace: cwd } });
  }
  return ownership;
}

function discoverTauri(root: string, dirs: string[], jsRoots: Map<string, JsOwner>, cargoWorkspaces: Map<string, CargoOwner>, read: Read, notices: string[], targets: ProjectTarget[]) {
  const apps = dirs.flatMap((native) => {
    const entries = ["tauri.conf.json", "tauri.conf.json5", "Tauri.toml"].map((name) => at(native, name))
      .flatMap((source) => { const conf = read(source); return conf === undefined ? [] : [{ source, conf }]; });
    return entries.map((entry) => ({ native, project: native === "." ? "." : dirname(native), formats: entries.length, ...entry }));
  });
  for (const { native, project, source, conf, formats } of apps) {
    const manifest = read(at(native, "Cargo.toml"));
    if (!manifest) { notices.push(`${source}：缺少 Cargo.toml`); continue; }
    try {
      // Explicit CLI bindings distinguish sibling Rust apps, regardless of directory name.
      if (formats !== 1) throw new Error("同一 Tauri Rust 目录存在多个基础配置，无法确认绑定");
      const nearby = dirs.filter((dir) => dir !== project && (project === "." || dir.startsWith(project + "/")) && read(at(dir, "package.json")) !== undefined);
      const parentPackage = read(at(project, "package.json"));
      const colocated = native !== project && read(at(native, "package.json")) !== undefined;
      const frontend = colocated ? native : parentPackage !== undefined || !nearby.length ? project : undefined;
      if (!frontend) throw new Error("Tauri 前端目录存在多个或非同目录候选，无法确认 CLI 绑定");
      const pkgText = frontend === project ? parentPackage : read(at(frontend, "package.json"));
      const pkg = pkgText === undefined ? {} : json(pkgText);
      const confData = tauriConfig(source, conf);
      const frontendOutput = observePath(root, native, str(table(confData.build).frontendDist));
      const cargo = table(toml(manifest).package);
      const owner = jsRoots.get(frontend);
      const installRoot = owner && "cwd" in owner ? owner.cwd : frontend;
      const parentText = frontend === installRoot ? pkgText : read(at(installRoot, "package.json"));
      const parent = parentText === undefined ? {} : json(parentText);
      const localCli = tauriCliSpec(pkg);
      const inheritedCli = localCli === undefined ? tauriCliSpec(parent) : undefined;
      const cli = localCli !== undefined ? { owner: frontend, spec: localCli } :
        inheritedCli !== undefined ? { owner: installRoot, spec: inheritedCli } : undefined;
      const js = cli ? packageTools(root, frontend, installRoot, pkg, parent, read, owner) : undefined;
      if (cli && !js) throw new Error("无法确认所声明的 Tauri JS CLI 使用 npm 或 pnpm");
      const ownership = cargoWorkspaces.get(native);
      if (!ownership || "issue" in ownership) throw new Error(ownership?.issue ?? "无法确认 Tauri 应用的 Cargo 工作区归属");
      const workspace = ownership.cwd;
      const wsText = workspace === native ? manifest : read(at(workspace, "Cargo.toml"));
      const ws = wsText ? table(toml(wsText).workspace) : {};
      const pin = rustPin(root, native);
      const rust = { rust: table(cargo["rust-version"]).workspace === true ? str(table(ws.package)["rust-version"]) : str(cargo["rust-version"]), ...pin };
      const outputs = frontendOutput ? [frontendOutput] : [];
      const declaration = digest(JSON.stringify([conf, manifest, wsText, frontend, pkgText, parentText, js?.declaration, pin]));
      targets.push({ adapter: "tauri", project: native, source, cwd: frontend, name: "build (Debug, no bundle)",
        stamp: digest(JSON.stringify([declaration, js?.stamp])),
        tauri: { cli, manager: js?.manager, workspace, frontend, declaration }, install: js?.install, requirements: { ...js?.requirements, ...rust }, outputs });
    } catch (error) { notices.push(`${source}：${(error as Error).message}`); }
  }
}

export const TAURI_CLI_PACKAGE = "@tauri-apps/cli";
export function tauriCliSpec(pkg: Record<string, unknown>) {
  const specs = [...new Set([pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies]
    .map((group) => object(group)[TAURI_CLI_PACKAGE]).filter((spec) => spec !== undefined))];
  if (!specs.length) return;
  const [spec] = specs;
  if (specs.length !== 1 || typeof spec !== "string" || !spec || spec.length > 4096) throw new Error("Tauri CLI 依赖声明冲突或无效");
  return spec;
}

export function tauriConfig(file: string, text: string) {
  const data = file.endsWith(".toml") ? toml(text) : object(file.endsWith(".json5") ? JSON5.parse(text) : json(text));
  if (table(data.build).runner !== undefined) throw new Error(`${file}：自定义 Tauri build.runner 无法绑定到所选 Cargo`);
  return data;
}

function supportedPattern(p: unknown): p is string {
  return typeof p === "string" && p.length < 256 && !p.includes("\\") && !/\*\*\*/u.test(p) &&
    !p.replace(/^!+/u, "").replace(/^\.?\/+/u, "").split("/").some((part) => part === ".." || part.startsWith("."));
}

const validatedPatterns = (raw: unknown): raw is string[] => Array.isArray(raw) && raw.length <= 64 && raw.every(supportedPattern);
type WorkspaceManager = "npm" | "pnpm" | "cargo";

function workspacePatterns(patterns: string[], manager: WorkspaceManager) {
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
    return [...positives, ...negatives.map((p) => "!" + p)];
  }
  return manager === "pnpm" ? [...patterns.filter((p) => !p.startsWith("!")), ...patterns.filter((p) => p.startsWith("!"))] : patterns;
}

const normalizePattern = (p: string) => p.replace(/^\.\//u, "").replace(/\/$/u, "");
const matchesPattern = (path: string, pattern: string, manager: WorkspaceManager) =>
  minimatch(path, pattern, { nonegate: true, nocomment: true, nobrace: manager === "cargo", noext: manager === "cargo" });

function patternIncludes(path: string, patterns: string[], manager: WorkspaceManager) {
  let included = false;
  for (const raw of patterns) {
    const excluded = raw.startsWith("!");
    if (matchesPattern(path, normalizePattern(excluded ? raw.slice(1) : raw), manager)) included = !excluded;
  }
  return included;
}

export function declaredDirs(root: string, raw: unknown, notices: string[], manager: WorkspaceManager = "cargo") {
  if (!Array.isArray(raw)) return [];
  const series = workspacePatterns(raw.slice(0, 64).filter(supportedPattern), manager);
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
    const pattern = normalizePattern(excluded ? raw.slice(1) : raw);
    if (!pattern || pattern.split("/").some((s) => !s || s === ".." || s.startsWith("."))) continue;
    const matches = scan.dirs.filter((p) => p !== "." && matchesPattern(p, pattern, manager));
    if (!/[?*\[\]{}()]/u.test(pattern)) {
      try { if (lstatSync(resolveWithin(root, pattern)).isDirectory()) matches.push(pattern); }
      catch { /* The declaration may refer to an absent or external package. */ }
    }
    for (const p of matches) if (excluded) selected.delete(p); else selected.add(p);
  }
  return { dirs: [...selected], limited: scan.limited };
}
