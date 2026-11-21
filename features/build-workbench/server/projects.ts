import { lstatSync } from "node:fs";
import { relative, resolve } from "node:path";
import { minimatch } from "minimatch";
import { parse as yaml } from "yaml";
import type { Target, TargetKey } from "../shared/contracts";
import { targetId } from "../shared/contracts";
import { at, digest, projectDirs, readText, resolveWithin } from "./paths";
import { array, literal, section } from "./manifests";
import { discoverCmake } from "./cmake";
import { discoverGradle, discoverXcode } from "./native-projects";
import type { Gradle, Xcode } from "./native-projects";

export type ProjectTarget = Target & {
  cwd: string;
  stamp: string;
  requirements: { node?: string; manager?: string; managerEngine?: string; miseNode?: string; rust?: string; rustChannel?: string; protoc?: boolean };
  cargo?: { name?: string; targetDir: string };
  cmake?: { dir: string; stamp: string; tool?: string };
  tauri?: { cli: string; targetDir: string };
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

function npmOutputs(project: string, manifest: Record<string, unknown>): string[] {
  // Published bundle directories are observation hints, not proof of exclusive writes.
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const dirs = files.filter((p): p is string => typeof p === "string" && /^(client|server)\/bundle\.(js|d\.ts)$/u.test(p));
  const output = new Set(dirs.map((p) => at(project, p.split("/")[0]!)));
  if (Object.values(object(manifest.scripts)).some((s) => typeof s === "string" && /(?:^|\s)(?:vite build|tsup)(?:\s|$)/u.test(s))) output.add(at(project, "dist"));
  return [...output];
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
  const projects = new Set(["."]);
  const patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : object(manifest.workspaces).packages;
  for (const project of declaredDirs(root, patterns, notices)) projects.add(project);
  const pnpm = read("pnpm-workspace.yaml");
  if (pnpm !== undefined) {
    try { for (const path of declaredDirs(root, object(yaml(pnpm, { maxAliasCount: 0 })).packages, notices)) projects.add(path); }
    catch (e) { notices.push("pnpm-workspace.yaml：" + (e as Error).message); }
  }
  const mise = read("mise.toml") ?? read(".mise.toml");
  const miseTools = mise ? section(mise, "tools") : undefined;
  const miseNode = literal(miseTools, "node");
  const misePnpm = literal(miseTools, "pnpm");
  const packageManager = version(manifest.packageManager);
  const manager = pnpm !== undefined || packageManager?.startsWith("pnpm@");
  for (const project of projects) {
    const source = at(project, "package.json");
    const text = project === "." ? rootText : read(source);
    if (!text) continue;
    try {
      const data = project === "." ? manifest : json(text);
      const engine = version(object(data.engines).node) ?? version(object(manifest.engines).node);
      const tool = manager ? "pnpm" : "npm";
      for (const [name, script] of Object.entries(object(data.scripts))) {
        if (name === "tauri" && read(at(project, "src-tauri/tauri.conf.json"))) continue;
        if (!safeName(name) || typeof script !== "string" || !script.trim() || /^(pre|post)(install|publish)|(?::watch$)|^(install|publish|deploy|release|push|sign|dev|start|watch|preview)(:|$)/iu.test(name)) continue;
        if (targets.length >= 512) { notices.push("目标发现达到上限（512 项）"); break; }
        targets.push({ adapter: tool, project, name, source, cwd: project, stamp: digest(JSON.stringify([rootText, text, pnpm, mise])),
          requirements: { node: engine, miseNode, managerEngine: version(object(data.engines)[tool]) ?? version(object(manifest.engines)[tool]), manager: (tool === "pnpm" && misePnpm) || (packageManager?.startsWith(tool + "@") ? packageManager.slice(tool.length + 1).split("+sha")[0] : undefined) },
          outputs: npmOutputs(project, data),
        });
      }
    } catch (e) { notices.push(source + "：" + (e as Error).message); }
  }
  discoverCargo(root, read, notices, targets);
  discoverTauri(root, read, notices, targets);
  discoverCmake(root, notices, targets);
  discoverGradle(root, notices, targets);
  discoverXcode(root, notices, targets);
  if (!targets.length) notices.push("未找到任务。已检查 npm/pnpm、Cargo、CMake、Tauri、Gradle 与 Xcode 清单；修改清单后可刷新。");
  return { targets: targets.slice(0, 512), notices: notices.slice(0, 32) };
}

function discoverCargo(root: string, read: (path: string) => string | undefined, notices: string[], targets: ProjectTarget[]) {
  const manifest = read("Cargo.toml");
  const workspace = manifest === undefined ? undefined : section(manifest, "workspace");
  const members = new Set(declaredDirs(root, [...array(workspace, "members"), ...array(workspace, "exclude").map((p) => "!" + p)], notices));
  const dirs = manifest === undefined ? projectDirs(root).dirs : [".", ...members];
  const toolchain = read("rust-toolchain.toml");
  const channel = toolchain ? literal(section(toolchain, "toolchain"), "channel") : undefined;
  for (const project of dirs) {
    const source = at(project, "Cargo.toml");
    const text = project === "." ? manifest : read(source);
    if (!text || targets.length >= 512) continue;
    const pkg = section(text, "package");
    const name = literal(pkg, "name");
    if (pkg !== undefined && (!name || !/^[\w-]+$/u.test(name))) { notices.push(source + "：未读取到有效的 [package].name"); continue; }
    if (!name && (project !== "." || workspace === undefined)) { notices.push(source + "：未读取到 [package] 或 [workspace]"); continue; }
    const wd = members.has(project) ? "." : project;
    const targetDir = at(wd, "target");
    const outputs = name ? [at(targetDir, "debug/" + name), at(targetDir, "debug/lib" + name.replaceAll("-", "_") + ".rlib")] : [at(targetDir, "debug")];
    const buildScript = read(at(project, "build.rs"));
    const protoc = !!buildScript && /prost_build::/u.test(buildScript);
    const inputs: string[] = [];
    const missing: string[] = [];
    if (protoc) {
      for (const path of buildScript.matchAll(/"([^"\r\n]+\.proto)"/gu)) {
        const rel = relative(root, resolve(root, project, path[1]!));
        try { if (readText(root, rel) === undefined) missing.push(rel); else inputs.push(rel); }
        catch { missing.push(rel); }
      }
      if (/\.out_dir\("src\/protos"\)/u.test(buildScript)) {
        outputs.push(at(project, "src/protos"));
        notices.push(`${source}：prost 构建会写入 src/protos；验证项目时建议使用副本。`);
      }
    }
    targets.push({ adapter: "cargo", project, name: name ?? "build (workspace)", source, cwd: wd, stamp: digest(JSON.stringify([manifest, text, toolchain, buildScript, inputs])), requirements: {
      rust: literal(pkg, "rust-version"), rustChannel: channel, protoc,
    }, blocked: missing.length ? `缺少或无法读取 protobuf 输入：${missing.slice(0, 8).join("、")}` : undefined, cargo: { name, targetDir }, outputs });
  }
}

function discoverTauri(root: string, read: (path: string) => string | undefined, notices: string[], targets: ProjectTarget[]) {
  for (const project of projectDirs(root).dirs) {
    const source = at(project, "src-tauri/tauri.conf.json");
    const conf = read(source);
    if (!conf) continue;
    const pkgText = read(at(project, "package.json"));
    const manifest = read(at(project, "src-tauri/Cargo.toml"));
    if (!pkgText || !manifest) { notices.push(`${source}：缺少前端或 Cargo 清单`); continue; }
    try {
      const pkg = json(pkgText);
      const build = object(json(conf).build);
      const cargo = section(manifest, "package");
      const name = literal(cargo, "name");
      const frontend = version(build.frontendDist);
      if (!name || !/^[\w-]+$/u.test(name) || !frontend || !/^\.\.\/[\w/-]+$/u.test(frontend) ||
        build.beforeBuildCommand !== "pnpm build" || object(pkg.scripts).tauri !== "tauri" ||
        typeof object(pkg.devDependencies)["@tauri-apps/cli"] !== "string" || !read(at(project, "pnpm-lock.yaml"))) {
        notices.push(`${source}：当前支持 pnpm、项目内 Tauri CLI、pnpm build 前端 hook 和工作区内 frontendDist。`); continue;
      }
      const mise = read(at(project, "mise.toml")) ?? read("mise.toml");
      const miseTools = mise ? section(mise, "tools") : undefined;
      const packageManager = version(pkg.packageManager);
      const cli = at(project, "node_modules/.bin/tauri");
      const targetDir = at(project, "src-tauri/target");
      let blocked: string | undefined;
      if (process.platform !== "darwin") blocked = "当前 Tauri 工具链检查仅支持 macOS。";
      else {
        try { if (!lstatSync(resolveWithin(root, cli)).isFile()) blocked = "缺少项目内 Tauri CLI"; }
        catch { blocked = "缺少项目内 Tauri CLI（node_modules/.bin/tauri），工作台不会安装依赖。"; }
      }
      targets.push({ adapter: "tauri", project, source, cwd: project, name: "build (Debug, no bundle)", blocked,
        stamp: digest(JSON.stringify([conf, manifest, pkgText, mise])), tauri: { cli, targetDir }, requirements: {
          node: version(object(pkg.engines).node), managerEngine: version(object(pkg.engines).pnpm), miseNode: literal(miseTools, "node"),
          manager: literal(miseTools, "pnpm") ?? (packageManager?.startsWith("pnpm@") ? packageManager.slice(5).split("+sha")[0] : undefined), rust: literal(cargo, "rust-version"),
        }, outputs: [at(project, frontend.slice(3)), at(targetDir, `debug/${name}`)] });
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

export function lookup(root: string, key: TargetKey) {
  const result = discoverProjects(root).targets.find((item) => targetId(item) === targetId(key));
  if (!result) throw new Error("目标已删除、移动或不可用，请刷新后重新选择");
  return result;
}
