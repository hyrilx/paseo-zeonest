import { readlinkSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, relative, resolve } from "node:path";
import { parse } from "smol-toml";
import { ancestors, executable } from "./mise";
import { at, inside, readBounded, readText } from "./paths";

type Table = Record<string, unknown>;
export const table = (v: unknown): Table => v && typeof v === "object" && !Array.isArray(v) ? v as Table : {};
export const str = (v: unknown) => typeof v === "string" && v.length ? v : undefined;
export const strings = (v: unknown) => Array.isArray(v) ? v.filter((item): item is string => typeof item === "string") : [];
export const toml = (s: string) => table(parse(s));
export function rustPin(root: string, cwd: string) {
  for (const dir of ancestors(cwd)) {
    for (const file of ["rust-toolchain", "rust-toolchain.toml"]) {
      const path = at(dir, file);
      try {
        const text = readText(root, path);
        if (text === undefined) continue;
        const pin = /^\s*\[/u.test(text) || file.endsWith(".toml") ? table(toml(text).toolchain) : { channel: text.trim() };
        const channel = str(pin.channel);
        const selected = str(pin.path);
        if (channel && !selected && /^[\w.-]+$/u.test(channel)) return { rustChannel: channel };
        if (selected && !channel) return { rustPath: resolve(root, dir, selected) };
        throw new Error("需指定有效的 channel 或 path");
      } catch (error) { return { rustIssue: `${path}：无法确认 Rust 工具链（${(error as Error).message}）` }; }
    }
  }
  return {};
}

export type CargoContext = { targetDir: string; buildDir?: string; compiler?: string; inputs: unknown[] };
export function cargoContext(root: string, cwd: string, defaultRoot: string, env: NodeJS.ProcessEnv, selectedRustc?: string) {
  let targetDir = resolve(root, defaultRoot, "target");
  let buildDir: string | undefined;
  let buildBase: string | undefined;
  let compiler: string | undefined;
  let compilerBase: string | undefined;
  const inputs: unknown[] = [];
  const dir = resolve(root, cwd);
  const stack = new Set<string>();
  const sensitive = ["RUSTC", "CARGO_BUILD_RUSTC", "CARGO_HOME", "CARGO_TARGET_DIR", "CARGO_BUILD_TARGET_DIR", "CARGO_BUILD_BUILD_DIR"];
  function readConfig(path: string): boolean {
    try {
      const physical = realpathSync(path);
      if (stack.has(physical) || stack.size >= 16 || inputs.length >= 128) throw new Error("Cargo include 循环或超过读取范围");
      const text = readBounded(physical, 512 * 1024);
      const parsed = toml(text);
      inputs.push([path, physical, text]);
      stack.add(physical);
      try {
        const include = parsed.include;
        if (include !== undefined && !Array.isArray(include)) throw new Error("无法确认 Cargo include 声明");
        for (const item of include ?? []) {
          const entry = table(item);
          const file = str(typeof item === "string" ? item : entry.path);
          if (!file?.endsWith(".toml") || (entry.optional !== undefined && typeof entry.optional !== "boolean")) throw new Error("Cargo include 须指定 TOML 文件");
          const included = resolve(dirname(path), file);
          if (!readConfig(included) && entry.optional !== true) throw new Error(`缺少 Cargo include：${included}`);
        }
      } finally { stack.delete(physical); }
      if (sensitive.some((name) => Object.hasOwn(table(parsed.env), name))) throw new Error("Cargo [env] 声明另一个编译器或输出上下文，无法确认实际写入位置");
      const settings = table(parsed.build);
      const base = dirname(dirname(path));
      const setting = (name: string) => {
        const val = settings[name];
        if (val !== undefined && !str(val)) throw new Error(`未识别 Cargo build.${name}`);
        return str(val);
      };
      const target = setting("target-dir");
      if (target) targetDir = resolve(base, target);
      const intermediate = setting("build-dir");
      if (intermediate) { buildDir = intermediate; buildBase = base; }
      const rustc = setting("rustc");
      if (rustc) { compiler = rustc; compilerBase = base; }
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") { inputs.push([path, null]); return false; }
      throw new Error(`${path}：${(e as Error).message}`, { cause: e });
    }
  }
  const home = env.CARGO_HOME ? resolve(dir, env.CARGO_HOME) : env.HOME && resolve(env.HOME, ".cargo");
  if (!home) throw new Error("无法确定 Cargo 用户配置目录");
  if (!readConfig(resolve(home, "config"))) readConfig(resolve(home, "config.toml"));
  const dirs = [dir];
  while (dirs[0] !== resolve(dirs[0]!, "..")) dirs.unshift(resolve(dirs[0]!, ".."));
  for (const parent of dirs) {
    const config = resolve(parent, ".cargo");
    if (home && config === resolve(home)) continue;
    if (!readConfig(resolve(config, "config"))) readConfig(resolve(config, "config.toml"));
  }
  const override = env.CARGO_TARGET_DIR || env.CARGO_BUILD_TARGET_DIR;
  if (override) targetDir = resolve(dir, override);
  if (env.CARGO_BUILD_BUILD_DIR) { buildDir = env.CARGO_BUILD_BUILD_DIR; buildBase = dir; }
  if (buildDir) {
    buildDir = buildDir.replaceAll("{workspace-root}", () => resolve(root, defaultRoot)).replaceAll("{cargo-cache-home}", () => home);
    if (/[{}]/u.test(buildDir)) throw new Error("Cargo build.build-dir 含未确认的路径模板；无法确认共享写入位置");
    buildDir = canonicalWrite(resolve(buildBase!, buildDir));
  }
  if (env.RUSTC || env.CARGO_BUILD_RUSTC) { compiler = env.RUSTC || env.CARGO_BUILD_RUSTC; compilerBase = dir; }
  if (compiler) {
    const previous = compiler;
    const path = compiler.includes("/") ? resolve(compilerBase!, compiler) : compiler === "rustc" && selectedRustc ? selectedRustc :
      (env.PATH ?? "").split(delimiter).map((p) => resolve(dir, p, previous)).find(executable);
    if (!path || !executable(path)) throw new Error(`无法确认 Cargo 声明的 Rust 编译器：${previous}`);
    compiler = realpathSync(path);
  }
  return { targetDir: canonicalWrite(targetDir), buildDir, compiler, inputs } satisfies CargoContext;
}

export function canonicalWrite(path: string, links = new Set<string>()): string {
  try { return realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    let link: string | undefined;
    try { link = readlinkSync(path); }
    catch (e) { if (!["ENOENT", "EINVAL"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e; }
    if (link === undefined) return resolve(canonicalWrite(parent, links), relative(parent, path));
    if (links.has(path) || links.size >= 32) throw new Error(`无法确认写入路径：${path}`);
    links.add(path);
    return canonicalWrite(resolve(parent, link), links);
  }
}

export function localCargoDir(root: string, path: string) {
  return isAbsolute(path) && inside(root, path) && root !== path ? relative(root, path) : undefined;
}

export function dependencyPaths(manifest: Table, workspace: Table) {
  const result: string[] = [];
  const collect = (group: Table) => {
    for (const name of ["dependencies", "dev-dependencies", "build-dependencies"]) {
      for (const [alias, value] of Object.entries(table(group[name]))) {
        const dep = table(value);
        const inherited = dep.workspace === true;
        const path = str((inherited ? table(table(workspace.dependencies)[alias]) : dep).path);
        if (path) result.push(inherited ? `\0${path}` : path);
      }
    }
  };
  collect(manifest);
  for (const group of Object.values(table(manifest.target))) collect(table(group));
  return result;
}
