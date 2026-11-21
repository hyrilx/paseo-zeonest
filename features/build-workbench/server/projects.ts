import { lstatSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { minimatch } from "minimatch";
import { parse as yaml } from "yaml";
import type { Target } from "../shared/contracts";
import { at, digest, projectDirs, readText, resolveWithin } from "./paths";
import { array, literal, section } from "./manifests";
import { discoverCmake } from "./cmake";
import { discoverGradle, discoverXcode } from "./native-projects";
import type { Gradle, Xcode } from "./native-projects";
import { misePin } from "./mise";

export type ProjectTarget = Target & {
  cwd: string;
  stamp: string;
  requirements: { node?: string; manager?: string; managerEngine?: string; miseNode?: string; rust?: string; rustChannel?: string; miseCmake?: string; miseJava?: string };
  cargo?: { name?: string; targetDir: string };
  cmake?: { dir: string; stamp: string; preset?: string; target?: string; configuration?: string; tool?: string };
  tauri?: { cli?: true; targetDir: string; manager?: "npm" | "pnpm" };
  install?: { cwd: string; lock: boolean; required: string[] };
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

function packageTools(root: string, project: string, installRoot: string, data: Record<string, unknown>, parent: Record<string, unknown>, read: Read) {
  const lock = (name: string) => {
    try {
      const stat = lstatSync(resolveWithin(root, at(installRoot, name)), { bigint: true });
      return stat.isFile() ? [name, stat.size, stat.mtimeNs, stat.ctimeNs].join(":") : undefined;
    } catch { return undefined; }
  };
  const pin = (name: string) => misePin([project, installRoot, "."], name, read);
  const nodePin = pin("node");
  const declared = version(data.packageManager) ?? version(parent.packageManager);
  if (declared && !/^(?:npm|pnpm)@/u.test(declared)) return;
  const pnpm = read(at(installRoot, "pnpm-workspace.yaml"));
  const pnpmLock = lock("pnpm-lock.yaml");
  const npmLock = lock("npm-shrinkwrap.json") ?? lock("package-lock.json");
  const manager = declared ? declared.startsWith("pnpm@") ? "pnpm" : "npm" : pnpm || pnpmLock ? "pnpm" : "npm";
  const required = [...new Set(Object.keys({ ...object(parent.dependencies), ...object(parent.devDependencies), ...object(data.dependencies), ...object(data.devDependencies) }))]
    .filter((p) => /^(?:@[\w.-]+\/)?[\w-][\w.-]*$/u.test(p)).slice(0, 256);
  return { manager, install: { cwd: installRoot, lock: !!(manager === "pnpm" ? pnpmLock : npmLock), required },
    stamp: [declared, pnpm, pnpmLock, npmLock, nodePin, pin(manager)],
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
  const dirs = projectDirs(root).dirs;
  const jsRoots = new Map<string, string>();
  const packages = new Map<string, { text: string; data: Record<string, unknown> }>();
  const readPackage = (dir: string) => {
    if (packages.has(dir)) return;
    const source = at(dir, "package.json");
    const text = dir === "." ? rootText : read(source);
    if (text === undefined) return;
    try { packages.set(dir, { text, data: dir === "." ? manifest : json(text) }); }
    catch (e) { notices.push(source + "：" + (e as Error).message); }
  };
  // Traverse shallow to deep; the nearest declared workspace owns installation.
  for (const dir of dirs) {
    readPackage(dir);
    const data = packages.get(dir)?.data ?? {};
    const fromNpm = Array.isArray(data.workspaces) ? data.workspaces : object(data.workspaces).packages;
    const pnpmPath = at(dir, "pnpm-workspace.yaml");
    const pnpm = read(pnpmPath);
    let patterns = fromNpm;
    if (pnpm !== undefined) {
      try { patterns = object(yaml(pnpm, { maxAliasCount: 0 })).packages; }
      catch (e) { notices.push(pnpmPath + "：" + (e as Error).message); }
    }
    if (pnpm !== undefined || Array.isArray(fromNpm)) jsRoots.set(dir, dir);
    for (const sub of declaredDirs(resolveWithin(root, dir), patterns, notices)) {
      const member = at(dir, sub);
      jsRoots.set(member, dir);
      readPackage(member);
    }
  }
  for (const [project, { text, data }] of packages) {
    const source = at(project, "package.json");
    try {
      const installRoot = jsRoots.get(project) ?? project;
      const parent = packages.get(installRoot);
      const info = packageTools(root, project, installRoot, data, parent?.data ?? {}, read);
      if (!info) { notices.push(`${source}：包管理器不是 npm 或 pnpm。`); continue; }
      for (const [name, script] of Object.entries(object(data.scripts))) {
        if (!safeName(name) || typeof script !== "string" || !script.trim() || /^(pre|post)(install|publish)|(?::watch$)|^(install|publish|deploy|release|push|sign|dev|start|watch|preview)(:|$)/iu.test(name)) continue;
        if (targets.length >= 512) { notices.push("目标发现达到上限（512 项）"); break; }
        targets.push({ adapter: info.manager, project, name, source, cwd: project, stamp: digest(JSON.stringify([parent?.text, text, info.stamp])),
          requirements: info.requirements, install: info.install, outputs: outputHints(root, project, data),
        });
      }
    } catch (e) { notices.push(source + "：" + (e as Error).message); }
  }
  discoverCargo(root, dirs, read, notices, targets);
  discoverTauri(root, dirs, jsRoots, read, notices, targets);
  discoverCmake(root, notices, targets);
  discoverGradle(root, dirs, notices, targets);
  discoverXcode(root, notices, targets);
  if (!targets.length) notices.push("未找到任务。已检查 npm/pnpm、Cargo、CMake、Tauri、Gradle 与 Xcode 清单；修改清单后可刷新。");
  return { targets: targets.slice(0, 512), notices: notices.slice(0, 32) };
}

function rustChannel(project: string, read: Read) {
  const parts = project === "." ? [] : project.split("/");
  for (let n = parts.length; n >= 0; n--) {
    const dir = parts.slice(0, n).join("/") || ".";
    const toml = read(at(dir, "rust-toolchain.toml"));
    const channel = toml ? literal(section(toml, "toolchain"), "channel") : read(at(dir, "rust-toolchain"))?.trim();
    if (channel) return channel;
  }
}

function observePath(root: string, base: string, path: string | undefined) {
  if (!path || isAbsolute(path) || /^[a-z][\w+.-]*:/iu.test(path)) return undefined;
  const rel = relative(root, resolve(root, base, path));
  if (!rel) return undefined;
  try { resolveWithin(root, rel); return rel; }
  catch { return undefined; }
}

function discoverCargo(root: string, dirs: string[], read: Read, notices: string[], targets: ProjectTarget[]) {
  const projects = new Map(dirs.flatMap((dir): [string, string][] => {
    const manifest = read(at(dir, "Cargo.toml"));
    return manifest === undefined ? [] : [[dir, manifest]];
  }));
  const workspaces = new Map<string, string>();
  for (const [dir, manifest] of projects) {
    const workspace = section(manifest, "workspace");
    if (workspace === undefined) continue;
    const path = resolve(root, dir);
    for (const rel of declaredDirs(path, [...array(workspace, "members"), ...array(workspace, "exclude").map((p) => "!" + p)], notices)) {
      const member = at(dir, rel);
      workspaces.set(member, dir);
      if (!projects.has(member)) {
        const text = read(at(member, "Cargo.toml"));
        if (text !== undefined) projects.set(member, text);
      }
    }
  }
  for (const [project, text] of projects) {
    const source = at(project, "Cargo.toml");
    const pkg = section(text, "package");
    const name = literal(pkg, "name");
    if (pkg !== undefined && (!name || !/^[\w-]+$/u.test(name))) { notices.push(source + "：未读取到有效的 [package].name"); continue; }
    const ws = section(text, "workspace");
    if (!name && ws === undefined) continue;
    const cwd = workspaces.get(project) ?? project;
    const build = read(at(project, ".cargo/config.toml")) ?? read(at(cwd, ".cargo/config.toml"));
    const targetDir = observePath(root, cwd, build ? literal(section(build, "build"), "target-dir") : undefined);
    const dir = targetDir ?? at(cwd, "target");
    const channel = rustChannel(project, read);
    const script = read(at(project, "build.rs"));
    const stamp = digest(JSON.stringify([text, projects.get(cwd), channel, build, script]));
    const base = { adapter: "cargo" as const, project, source, cwd, stamp, requirements: { rust: literal(pkg, "rust-version"), rustChannel: channel } };
    if (name) targets.push({ ...base, name, cargo: { name, targetDir: dir }, outputs: [at(dir, `debug/${name}`), at(dir, `debug/lib${name.replaceAll("-", "_")}.rlib`)] });
    if (ws !== undefined) targets.push({ ...base, name: "build (workspace)", cargo: { targetDir: dir }, outputs: [at(dir, "debug")] });
  }
}

function discoverTauri(root: string, dirs: string[], jsRoots: Map<string, string>, read: Read, notices: string[], targets: ProjectTarget[]) {
  for (const native of dirs) {
    const jsonPath = at(native, "tauri.conf.json");
    const tomlPath = at(native, "Tauri.toml");
    const rawJson = read(jsonPath);
    const source = rawJson === undefined ? tomlPath : jsonPath;
    const conf = rawJson ?? read(tomlPath);
    if (conf === undefined) continue;
    const manifest = read(at(native, "Cargo.toml"));
    if (!manifest) { notices.push(`${source}：缺少 Cargo.toml`); continue; }
    const project = native === "." ? "." : dirname(native);
    try {
      const pkgText = read(at(project, "package.json"));
      const pkg = pkgText === undefined ? {} : json(pkgText);
      const build = rawJson !== undefined ? object(json(conf).build) : undefined;
      const frontend = build ? version(build.frontendDist) : literal(section(conf, "build"), "frontendDist");
      const frontendOutput = observePath(root, native, frontend);
      const cargo = section(manifest, "package");
      const installRoot = jsRoots.get(project) ?? project;
      const parentText = project === installRoot ? pkgText : read(at(installRoot, "package.json"));
      const parent = parentText === undefined ? {} : json(parentText);
      const dependency = (data: Record<string, unknown>) => object(data.devDependencies)["@tauri-apps/cli"] ?? object(data.dependencies)["@tauri-apps/cli"];
      const js = pkgText === undefined || !(dependency(pkg) || dependency(parent)) ? undefined : packageTools(root, project, installRoot, pkg, parent, read);
      const cli = js ? true : undefined;
      const targetDir = at(native, "target");
      const channel = rustChannel(native, read);
      const rust = { rust: literal(cargo, "rust-version"), rustChannel: channel };
      const name = literal(cargo, "name");
      const outputs = [...(frontendOutput ? [frontendOutput] : []), name && /^[\w-]+$/u.test(name) ? at(targetDir, `debug/${name}`) : at(targetDir, "debug")];
      targets.push({ adapter: "tauri", project: native, source, cwd: project, name: "build (Debug, no bundle)",
        stamp: digest(JSON.stringify([conf, manifest, pkgText, parentText, js?.stamp, channel])),
        tauri: { cli, manager: js?.manager, targetDir }, install: js?.install, requirements: { ...js?.requirements, ...rust }, outputs });
    } catch (error) { notices.push(`${source}：${(error as Error).message}`); }
  }
}

export function declaredDirs(root: string, raw: unknown, notices: string[]) {
  if (!Array.isArray(raw)) return [];
  // Traverse only declared prefixes. Never follow a symlink or glob dependencies.
  const patterns = raw.slice(0, 64).filter((p): p is string => typeof p === "string" && p.length < 256 && !p.includes("\\") && !/\*\*\*/u.test(p));
  const { dirs, limited } = scanDeclared(root, patterns);
  if (limited) notices.push("项目声明扫描达到上限（深度 4、目录 256、条目 4096）");
  return dirs;
}

function scanDeclared(root: string, patterns: string[]) {
  if (!patterns.length) return { dirs: [], limited: false };
  const scan = projectDirs(root);
  const selected = new Set<string>();
  for (const raw of patterns) {
    const excluded = raw.startsWith("!");
    const pattern = (excluded ? raw.slice(1) : raw).replace(/^\.\//u, "").replace(/\/$/u, "");
    if (!pattern || pattern.split("/").some((s) => !s || s === ".." || s.startsWith("."))) continue;
    const matches = scan.dirs.filter((p) => p !== "." && minimatch(p, pattern, { nonegate: true, nocomment: true, nobrace: true, noext: true }));
    if (!/[?*\[\]]/u.test(pattern)) {
      try { if (lstatSync(resolveWithin(root, pattern)).isDirectory()) matches.push(pattern); }
      catch { /* The declaration may refer to an absent or external package. */ }
    }
    for (const p of matches) if (excluded) selected.delete(p); else selected.add(p);
  }
  return { dirs: [...selected], limited: scan.limited };
}
